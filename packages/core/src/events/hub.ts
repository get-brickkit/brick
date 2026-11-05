import { GLOBAL_SYMBOL } from "../telemetry-names";
import { Dispatcher, type OutboxCounts } from "./dispatcher";
import { newEventId } from "./id";
import type { OutboxTable } from "./outbox";
import { runInTransaction } from "./transaction";
import type {
  DispatchOptions,
  EventDelivery,
  EventListener,
  EventRecorder,
  EventsOptions,
  EventsWorld,
  ServiceEvents,
} from "./types";
import { WorkflowRuntime } from "./workflows";
import { runWithDeps } from "../deps";

interface EventsHost {
  readonly name: string;
  getDb(): unknown;
  getOutbox?(): OutboxTable | undefined;
  setRecorder?(recorder: ServiceEvents | undefined): void;
  /** Throws for an event the service's catalog does not allow. */
  checkEvent?(name: string, payload: unknown): void;
}

export function matchesEvent(pattern: string, name: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/** The recorder of each service database, so `emitEvent(ctx, ...)` can find it from `ctx.db`. */
export const recorders = new WeakMap<object, ServiceEvents>();

// Shared by name: the CLI that stops the hubs may hold another copy of this package.
const startedHubs = ((globalThis as Record<symbol, unknown>)[
  Symbol.for(GLOBAL_SYMBOL.eventsStarted)
] ??= new Set()) as Set<Pick<EventsHub, "stop">>;

/**
 * Stop every events hub started in this process, by any copy of `@brickkit/core`,
 * and wait for their deliveries. A hub that fails to stop does not cut the wait
 * for the others: the first failure is thrown once every hub is done.
 */
export async function stopAllEvents(): Promise<void> {
  const results = await Promise.allSettled(
    [...startedHubs].map((hub) => hub.stop()),
  );
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed) throw failed.reason;
}

/**
 * What an app's `events` option describes, as plain data. It goes in the app
 * definition, which is sent to the dev dashboard, so it holds no functions.
 */
export interface EventsDefinition {
  listeners: { name: string; on: string[]; kind: "handler" | "workflow" }[];
  dispatch: boolean;
  /** Names of the services whose writes record events. */
  recorders: string[];
}

/** What the dispatcher runs for a delivery. */
export interface Deliverable {
  readonly maxAttempts?: number;
  readonly errors?: EventListener["errors"];
  readonly retry?: EventListener["retry"];
  run(delivery: EventDelivery): void | Promise<void>;
}

/**
 * The events of one app: who listens, where events are recorded, and the
 * dispatchers that deliver them. `brick({ events })` makes one and puts it on
 * `app.events`.
 */
export class EventsHub {
  private readonly byName = new Map<string, EventListener>();
  private readonly dispatchers = new Map<OutboxTable, Dispatcher>();
  private readonly deliverables = new Map<string, Deliverable>();
  private readonly dispatchOptions: DispatchOptions | false;
  private readonly runtime: WorkflowRuntime | undefined;
  private readonly recorderNames: string[] = [];
  private started = false;
  private stopping: Promise<void> | undefined;

  /**
   * @param options - The `events` option.
   * @param deps - The app's `brick({ deps })`, which `useDeps()` returns in its
   * listeners and workflow steps.
   */
  constructor(
    options: EventsOptions,
    private readonly deps: Record<string, unknown> = {},
  ) {
    for (const listener of options.listeners ?? []) {
      if (typeof listener.name !== "string" || !listener.name)
        throw new Error("An event listener needs a name");
      if (listener.name.includes(":"))
        throw new Error(
          `Event listener name '${listener.name}' must not contain ':'`,
        );
      if (!listener.on?.length)
        throw new Error(
          `Event listener '${listener.name}' listens for nothing`,
        );
      if (this.byName.has(listener.name))
        throw new Error(`Duplicate event listener '${listener.name}'`);
      if (!listener.run === !listener.workflow)
        throw new Error(
          `Event listener '${listener.name}' needs exactly one of run and workflow`,
        );
      this.byName.set(listener.name, listener);
    }
    const workflowListeners = [...this.byName.values()].filter(
      (listener) => listener.workflow,
    );
    if (workflowListeners.length) {
      if (!options.world)
        throw new Error(
          `Event listener '${workflowListeners[0]!.name}' runs a workflow, so events needs a world: ` +
            "brick({ events: { world: createWorld(...) } }) with createWorld from @brickkit/redis-world.",
        );
      this.runtime = new WorkflowRuntime(
        options.world,
        options.workflows,
        workflowListeners,
        deps,
      );
    }
    this.dispatchOptions =
      options.dispatch === false
        ? false
        : options.dispatch === true || options.dispatch === undefined
          ? {}
          : options.dispatch;
  }

  /**
   * Give each service whose database holds an outbox table a recorder, and a
   * dispatcher for that table. Call it before the first request: a service has no
   * recorder until then.
   *
   * @param services - The app's services.
   * @returns The hub, for chaining.
   */
  attach(services: readonly EventsHost[]): this {
    let attached = 0;
    for (const service of services) {
      const table = service.getOutbox?.();
      if (!table) continue;
      attached++;
      this.recorderNames.push(service.name);
      const bound = this.bind(table, (name, payload) =>
        service.checkEvent?.(name, payload),
      );
      service.setRecorder?.(bound);
      const db = service.getDb();
      if (db && typeof db === "object") recorders.set(db, bound);
    }
    if (attached === 0 && this.byName.size > 0) {
      console.warn(
        "[Brick-TS] events are configured, but no service database has an outbox table. " +
          "Add outboxTable() to a database's tables so its writes can record events.",
      );
    }
    for (const service of services) {
      const table = service.getOutbox?.();
      if (table && !this.dispatchers.has(table)) {
        this.dispatchers.set(
          table,
          new Dispatcher(
            service.getDb(),
            table,
            (name) => this.deliverable(name),
            this.dispatchOptions || {},
          ),
        );
      }
    }
    return this;
  }

  /** The listeners that want an event. */
  matching(name: string): EventListener[] {
    const found: EventListener[] = [];
    for (const listener of this.byName.values())
      if (listener.on.some((pattern) => matchesEvent(pattern, name)))
        found.push(listener);
    return found;
  }

  /** The listeners and settings, as plain data. */
  describe(): EventsDefinition {
    return {
      listeners: [...this.byName.values()].map((listener) => ({
        name: listener.name,
        on: [...listener.on],
        kind: listener.workflow ? ("workflow" as const) : ("handler" as const),
      })),
      dispatch: this.dispatchOptions !== false,
      recorders: [...this.recorderNames],
    };
  }

  /**
   * Where the workflow bundle is read from, the project it is built from, and
   * the world the workflows run on. Only set when a listener runs a workflow.
   * The CLI builds the bundle there before events start, and shows the world's
   * runs in the dev dashboard.
   */
  get workflows():
    | { root: string; dir: string; world: EventsWorld }
    | undefined {
    return (
      this.runtime && {
        root: this.runtime.root,
        dir: this.runtime.dir,
        world: this.runtime.world,
      }
    );
  }

  /**
   * Resume the workflow that waits on a webhook. The server mounts this on the
   * route the Workflow SDK puts in webhook URLs.
   */
  webhook(request: Request): Promise<Response> {
    if (!this.runtime)
      throw new Error("No listener of this app runs a workflow");
    return this.runtime.handleWebhook(request);
  }

  /**
   * Start delivering recorded events from this process, and start the world that
   * runs workflow listeners. Does nothing if this process only records events
   * (`dispatch: false`), already started, or a stop is still waiting.
   */
  start(): void {
    // A process being stopped exits when the stop is done, and would drop what
    // this start claims. A startup that finishes late, or a commit, lands here.
    if (this.dispatchOptions === false || this.started || this.stopping) return;
    this.started = true;
    startedHubs.add(this);
    this.runtime?.warmUp();
    for (const dispatcher of this.dispatchers.values()) dispatcher.start();
  }

  /**
   * Stop delivering, wait for the deliveries that are running, and close the
   * world. A world cannot be started again, so workflow listeners stop for good.
   * A stop that arrives while another runs waits for that one.
   */
  stop(): Promise<void> {
    return (this.stopping ??= this.shutDown().finally(() => {
      // Removed only when done, so a stop-all waits for a stop already running.
      this.stopping = undefined;
      startedHubs.delete(this);
    }));
  }

  private async shutDown(): Promise<void> {
    this.started = false;
    await Promise.all(
      [...this.dispatchers.values()].map((dispatcher) => dispatcher.stop()),
    );
    await this.runtime?.close();
  }

  /**
   * Deliver everything that is due now and wait for it. For tests and for
   * workers that drive delivery themselves.
   *
   * @returns How many deliveries ran.
   */
  async drain(): Promise<number> {
    let total = 0;
    for (const dispatcher of this.dispatchers.values())
      total += await dispatcher.drain();
    return total;
  }

  /** How many rows are in each state, across the app's outbox tables. */
  async counts(): Promise<OutboxCounts> {
    const total: OutboxCounts = {
      pending: 0,
      claimed: 0,
      delivered: 0,
      dead: 0,
    };
    for (const dispatcher of this.dispatchers.values()) {
      const counts = await dispatcher.counts();
      for (const status of Object.keys(total) as (keyof OutboxCounts)[])
        total[status] += counts[status];
    }
    return total;
  }

  /**
   * Put parked deliveries back in line.
   *
   * @param deliveryId - One delivery. Omit it to retry every dead one.
   * @returns How many deliveries were put back.
   */
  async retryDead(deliveryId?: string): Promise<number> {
    let total = 0;
    for (const dispatcher of this.dispatchers.values())
      total += await dispatcher.retryDead(deliveryId);
    return total;
  }

  private deliverable(name: string): Deliverable | undefined {
    const listener = this.byName.get(name);
    if (!listener) return undefined;
    let found = this.deliverables.get(name);
    if (!found) {
      const runtime = this.runtime;
      found = {
        ...(listener.errors ? { errors: listener.errors } : {}),
        ...(listener.retry ? { retry: listener.retry } : {}),
        ...(listener.workflow
          ? {
              ...(listener.maxAttempts !== undefined
                ? { maxAttempts: listener.maxAttempts }
                : {}),
              run: async (delivery) => {
                await runtime!.startRun(listener, delivery);
              },
            }
          : {
              ...(listener.maxAttempts !== undefined
                ? { maxAttempts: listener.maxAttempts }
                : {}),
              run: (delivery) =>
                runWithDeps(this.deps, () => listener.run!(delivery)),
            }),
      };
      this.deliverables.set(name, found);
    }
    return found;
  }

  private bind(
    table: OutboxTable,
    check: (name: string, payload: unknown) => void,
  ): ServiceEvents {
    const startAndNotify = () => {
      this.start();
      this.dispatchers.get(table)?.notify();
    };
    const insert = async (
      tx: any,
      context: { traceId?: string; source?: string },
      name: string,
      payload: unknown,
    ): Promise<boolean> => {
      check(name, payload);
      const listeners = this.matching(name);
      if (!listeners.length) return false;
      const eventId = newEventId();
      const occurredAt = new Date();
      await tx.insert(table as any).values(
        listeners.map((listener) => ({
          id: `${eventId}:${listener.name}`,
          eventId,
          listener: listener.name,
          name,
          payload,
          traceId: context.traceId ?? null,
          source: context.source ?? null,
          occurredAt,
          status: "pending",
          attempts: 0,
          availableAt: occurredAt,
        })),
      );
      return true;
    };
    return {
      wants: (name) => this.matching(name).length > 0,
      transaction: async (db, context, fn) => {
        let recorded = false;
        const result = await runInTransaction(db, async (tx) => {
          const record: EventRecorder = async (name, payload) => {
            if (await insert(tx, context, name, payload)) recorded = true;
          };
          return fn(tx, record);
        });
        if (recorded) startAndNotify();
        return result;
      },
      record: async (tx, context, name, payload) => {
        await insert(tx, context, name, payload);
      },
    };
  }
}
