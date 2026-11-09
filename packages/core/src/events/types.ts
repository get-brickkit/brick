import type { ActionErrorDefinition, ErrorDetails } from "../types";

/**
 * An event, as it was recorded. It is the same for every listener of it.
 */
export interface EventEnvelope<TPayload = unknown> {
  /** Unique per event. Every listener's delivery of the event shares it. */
  id: string;
  /** The event name, such as `user.create`. */
  name: string;
  /** What happened. JSON data. */
  payload: TPayload;
  /** When it happened, as an ISO timestamp. */
  occurredAt: string;
  /** The trace of the request that caused it, so a listener continues the same trace. */
  traceId?: string;
  /** What emitted it, such as `identity.user` for a generated CRUD write. */
  source?: string;
}

/**
 * One listener's delivery of an event: the envelope, plus which listener it is for
 * and which attempt this is.
 */
export interface EventDelivery<
  TPayload = unknown,
> extends EventEnvelope<TPayload> {
  /** The name of the listener this delivery is for. */
  listener: string;
  /**
   * `<event id>:<listener>`. It is the same on every retry, so a listener can use
   * it to avoid doing the work twice: delivery is at least once.
   */
  deliveryId: string;
  /** 1 on the first try, 2 on the first retry, and so on. */
  attempt: number;
}

/**
 * The CRUD events of a resource called `user`, by operation. Listeners of
 * `user.create`, `user.update` and `user.delete` receive these payloads.
 */
export type CrudEventPayload<TRow = Record<string, unknown>> =
  | { id: unknown; row: TRow }
  | { id: unknown; before: TRow; after: TRow };

/**
 * What `retry` receives: one member per error the listener declares, or the
 * fallback for anything else it threw.
 */
export type ListenerFailure<
  TErrors extends Record<string, ActionErrorDefinition>,
> =
  | {
      [K in keyof TErrors & string]: {
        code: K;
        message: string;
        details: ErrorDetails<TErrors[K]>;
      };
    }[keyof TErrors & string]
  | { code: "UNKNOWN"; message: string; cause: unknown };

/** What a listener's `retry` decides: try again later, or park the delivery as dead now. */
export type RetryDecision = "retry" | "dead";

/**
 * A listener: code that runs when an event it listens for has been recorded.
 */
export interface EventListener<TPayload = any> {
  /** Unique among the app's listeners. It is part of each delivery's id. */
  readonly name: string;
  /**
   * The event names to listen for. A trailing `*` matches a prefix (`user.*`),
   * and `*` alone matches every event.
   */
  readonly on: readonly string[];
  /**
   * A handler that runs in the dispatching process for each delivery. Throwing
   * retries the delivery with a growing delay. A listener has this or `workflow`.
   */
  readonly run?: (delivery: EventDelivery<TPayload>) => void | Promise<void>;
  /** The typed errors a handler can fail with; `retry` receives them as a `ListenerFailure`. */
  readonly errors?: Record<string, ActionErrorDefinition>;
  /**
   * Decides what a failed delivery does next. Without it, every failure retries
   * until `maxAttempts`. It cannot extend the attempts: `"retry"` still parks the
   * delivery as dead once they run out.
   */
  readonly retry?: (error: ListenerFailure<any>) => RetryDecision;
  /**
   * A durable workflow that runs for each delivery, on the app's `events.world`.
   * The delivery counts as done once its run has started; the workflow retries
   * its own steps from there. A listener has this or `run`.
   */
  readonly workflow?: EventWorkflow<TPayload>;
  /** Attempts before the delivery is parked as dead. Defaults to the dispatcher's. */
  readonly maxAttempts?: number;
}

/**
 * What a workflow listener's workflow receives: the event and which listener it
 * is for. It has no `attempt`, because one delivery starts one run however many
 * times it is tried.
 */
export type WorkflowEvent<TPayload = any> = Omit<
  EventDelivery<TPayload>,
  "attempt"
>;

/**
 * A function marked `"use workflow"`, run once per delivery of the listener it is
 * given to.
 */
export type EventWorkflow<TPayload = any> = (
  event: WorkflowEvent<TPayload>,
) => Promise<unknown>;

/**
 * The world workflow listeners run on: the queue and storage behind the Workflow
 * SDK. `createWorld()` from `@brickkit/redis-world` or `@brickkit/bullmq-world`
 * makes one. Brick starts it with the app's events and closes it when they stop.
 */
export interface EventsWorld {
  /**
   * Names a run after its key so that starting it twice makes one run. A world
   * without it would start a second run when an event is delivered again, so
   * Brick refuses such a world.
   */
  createRunId?(options?: Readonly<Record<string, unknown>>): string;
  start?(): Promise<void>;
  close?(): Promise<void>;
  registerHandler?(
    prefix: any,
    handler: (request: Request) => Promise<Response>,
  ): void;
}

/**
 * Where the workflows of an app are built from. The CLI (`brick dev`,
 * `brick start`) writes the bundle to `<root>/.well-known/workflow/v1` before
 * events start, and events read it from there. A server compiled by
 * `brick build` reads the bundle shipped beside it instead.
 */
export interface WorkflowsOptions {
  /** The project root: where the Workflow SDK is installed. Default: the working directory. */
  root?: string;
}

/**
 * How the dispatcher delivers recorded events.
 */
export interface DispatchOptions {
  /**
   * Whether to look for due deliveries on a timer, and right after a commit.
   * Default `true`. With `false`, deliveries run only when something calls
   * `app.events.drain()`: a cron job, a worker you drive yourself, or a test.
   */
  timer?: boolean;
  /** How often to look for deliveries that are due, in milliseconds. Default 1000. */
  intervalMs?: number;
  /** Most deliveries claimed at once. Default 50. */
  batchSize?: number;
  /** Attempts before a delivery is parked as dead. Default 8. */
  maxAttempts?: number;
  /** How long a claimed delivery may run before another dispatcher takes it, in milliseconds. Default 60000. */
  claimTimeoutMs?: number;
  /** Longest wait before a retry, in milliseconds. Default 300000. */
  maxBackoffMs?: number;
  /** How long delivered rows are kept, in milliseconds. Default 86400000 (one day). 0 keeps none. */
  retainDeliveredMs?: number;
}

/**
 * The `events` option of `brick()`.
 */
export interface EventsOptions {
  /** The listeners of the app. */
  listeners?: readonly EventListener[];
  /**
   * Whether this process delivers recorded events. `true` (the default) starts a
   * dispatcher with the default settings, an object tunes it, and `false` only
   * records events, for an app whose events are delivered by another process.
   */
  dispatch?: boolean | DispatchOptions;
  /**
   * The world that runs `workflow` listeners. Required when any listener has one.
   * Brick starts it when the app's events start and closes it when they stop.
   */
  world?: EventsWorld;
  /** Where the workflow bundle lives. Only used with workflow listeners. */
  workflows?: WorkflowsOptions;
}

/**
 * Records an event inside the transaction it was given. The event is committed
 * with the write, or not at all.
 */
export type EventRecorder = (name: string, payload: unknown) => Promise<void>;

/**
 * What a service with events offers the code that writes to its database. A
 * service has it once `brick({ events })` is set up and its database holds an
 * outbox table.
 */
export interface ServiceEvents {
  /** Whether any listener wants the event, so a write can skip recording one. */
  wants(name: string): boolean;
  /**
   * Run `fn` in a database transaction. Events it records are committed with
   * whatever else it wrote, or not at all, and are delivered after the commit.
   */
  transaction<T>(
    db: unknown,
    context: { traceId?: string; source?: string },
    fn: (tx: any, record: EventRecorder) => Promise<T>,
  ): Promise<T>;
  /**
   * Record an event in a transaction the caller already has open. It is
   * committed with that transaction. Nothing tells Brick when the caller commits,
   * so delivery waits for the dispatcher's next poll.
   */
  record(
    tx: unknown,
    context: { traceId?: string; source?: string },
    name: string,
    payload: unknown,
  ): Promise<void>;
}
