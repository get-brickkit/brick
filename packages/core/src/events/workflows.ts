import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_DEPS, runWithDeps } from "../deps";
import type {
  EventDelivery,
  EventListener,
  EventsWorld,
  WorkflowEvent,
  WorkflowsOptions,
} from "./types";

/** `getQueueTopicPrefix("workflow")` from `@workflow/world`: the queue the runtime reads. */
const WORKFLOW_QUEUE_PREFIX = "__wkf_workflow_";
const BUNDLE_DIR = ".well-known/workflow/v1";
const STOPPED = "The events were stopped, so workflows can no longer run";
/** Where the SDK builds the URL of a webhook: the route `handleWebhook` serves. */
export const WEBHOOK_ROUTE = "/.well-known/workflow/v1/webhook/*";
/** Where the transform and the bundle register steps by id. The SDK's own generated code uses it. */
const STEP_REGISTRY = Symbol.for("@workflow/core//registeredSteps");

interface WorkflowSdk {
  start(
    workflow: unknown,
    args: unknown[],
    options: Record<string, unknown>,
  ): Promise<{ runId: string }>;
  setWorld(world: unknown): void;
}

interface BundleManifest {
  steps?: Record<string, unknown>;
  workflows?: Record<string, Record<string, { workflowId?: string }>>;
}

/**
 * Where the workflow bundle is read from, and the project it is built from.
 *
 * @param options - The `events.workflows` option.
 * @returns Absolute `root` and `dir`. The bundle cannot live elsewhere: the
 * builder finds the SDK from where it writes, and skips only this directory when it
 * looks for workflows.
 */
export function resolveWorkflowPaths(options: WorkflowsOptions = {}): {
  root: string;
  dir: string;
} {
  const root = resolve(options.root ?? process.cwd());
  return { root, dir: join(root, BUNDLE_DIR) };
}

/**
 * Runs workflow listeners: wires the world into the Workflow SDK, serves the
 * built bundle from this process, and starts one run for each delivery.
 *
 * Nothing is loaded until it is needed, so an app without workflow listeners
 * never imports the SDK.
 */
export class WorkflowRuntime {
  readonly root: string;
  readonly dir: string;
  private ready: Promise<WorkflowSdk> | undefined;
  private connected: Promise<WorkflowSdk> | undefined;
  private closed = false;

  constructor(
    readonly world: EventsWorld,
    options: WorkflowsOptions | undefined,
    private readonly listeners: readonly EventListener[],
    private readonly deps: Record<string, unknown> = {},
  ) {
    ({ root: this.root, dir: this.dir } = resolveWorkflowPaths(options));
  }

  /** Begin loading the runtime now rather than at the first delivery. */
  warmUp(): void {
    this.ensure().catch((error) =>
      console.error(
        `[Brick-TS] The workflow runtime did not start: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  /**
   * Start the run for a delivery.
   *
   * The run is named after the delivery id, so a delivery that is tried again
   * finds the run it already started instead of starting another.
   *
   * @param listener - The workflow listener the delivery is for.
   * @param delivery - The delivery.
   * @returns The run id.
   */
  async startRun(
    listener: EventListener,
    delivery: EventDelivery,
  ): Promise<string> {
    const sdk = await this.ensure();
    const { attempt: _attempt, ...event } = delivery;
    const run = await sdk.start(
      listener.workflow,
      [event satisfies WorkflowEvent],
      {
        world: this.world,
        runKey: delivery.deliveryId,
        runKeyTime: Date.parse(delivery.occurredAt),
      },
    );
    return run.runId;
  }

  /**
   * Answer a request to a webhook a workflow created with `createWebhook`, by
   * resuming the workflow that waits on it. Needs the world but not the queue
   * consumer, so a process that only records events (`dispatch: false`) serves
   * webhooks too.
   *
   * @param request - The request to `/.well-known/workflow/v1/webhook/<token>`.
   * @returns The response the bundle's webhook handler gives.
   */
  async handleWebhook(request: Request): Promise<Response> {
    await this.connect();
    const file = join(this.dir, "webhook.mjs");
    if (!existsSync(file))
      throw new Error(
        `No webhook bundle at ${file}. brick dev and brick start build it; ` +
          "in a test or script, call buildWorkflows() from @brickkit/cli/workflows first.",
      );
    const handlers = await import(pathToFileURL(file).href);
    const handler = handlers[request.method];
    if (typeof handler !== "function")
      return new Response(null, { status: 405 });
    return handler(request);
  }

  /** Stop the world. The runtime cannot be started again afterwards. */
  async close(): Promise<void> {
    this.closed = true;
    await this.ready?.catch(() => {});
    await this.connected?.catch(() => {});
    await this.world.close?.();
  }

  private ensure(): Promise<WorkflowSdk> {
    if (this.closed) return Promise.reject(new Error(STOPPED));
    this.ready ??= this.initialize().catch((error) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  /** Load the SDK and give it the world: all a webhook needs. */
  private connect(): Promise<WorkflowSdk> {
    if (this.closed) return Promise.reject(new Error(STOPPED));
    this.connected ??= this.loadSdk()
      .then((sdk) => {
        sdk.setWorld(this.world);
        return sdk;
      })
      .catch((error) => {
        this.connected = undefined;
        throw error;
      });
    return this.connected;
  }

  private async initialize(): Promise<WorkflowSdk> {
    if (typeof this.world.createRunId !== "function")
      throw new Error(
        "This world cannot name a run after its key, so an event delivered twice would start two runs. " +
          "Use the world from @brickkit/redis-world or @brickkit/bullmq-world.",
      );
    const sdk = await this.connect();
    const flow = join(this.dir, "flow.mjs");
    if (!existsSync(flow))
      throw new Error(
        `No workflow bundle at ${flow}. brick dev and brick start build it; ` +
          "in a test or script, call buildWorkflows() from @brickkit/cli/workflows first.",
      );
    const manifest = this.readManifest();
    const depsOf = this.checkListeners(manifest);
    const bundle = await this.loadBundle(flow);
    if (typeof bundle.POST !== "function")
      throw new Error(`${flow} does not export a POST handler`);
    const post = bundle.POST;
    // Steps run inside this handler, so `useDeps()` in a step finds the deps of
    // the app, or of the plugin whose listener runs the workflow. The queue is
    // named after the workflow: `__wkf_workflow_<workflowId>`.
    this.world.registerHandler?.(WORKFLOW_QUEUE_PREFIX, (request: Request) => {
      const queue = request.headers.get("x-vqs-queue-name") ?? "";
      const deps =
        depsOf.get(queue.slice(WORKFLOW_QUEUE_PREFIX.length)) ?? this.deps;
      return runWithDeps(deps, () => post(request));
    });
    await this.world.start?.();
    return sdk;
  }

  private async loadSdk(): Promise<WorkflowSdk> {
    const from = createRequire(join(this.root, "package.json"));
    const load = async (specifier: string) => {
      let path: string;
      try {
        path = from.resolve(specifier);
      } catch {
        throw new Error(
          `The Workflow SDK is not installed in ${this.root} (could not resolve '${specifier}'). Add it with: bun add workflow`,
        );
      }
      return import(pathToFileURL(path).href);
    };
    const [api, runtime] = await Promise.all([
      load("workflow/api"),
      load("workflow/runtime"),
    ]);
    return { start: api.start, setWorld: runtime.setWorld };
  }

  /**
   * The bundle holds its own copy of every step and registers them all when it
   * loads, replacing the ones the app registered. A copy has its own module state:
   * a step would find no database connection, no config, none of what the app set
   * up. So the app's steps are put back, and the bundle's copies serve only the
   * steps the app never loaded.
   */
  private async loadBundle(
    flow: string,
  ): Promise<{ POST?: (request: Request) => Promise<Response> }> {
    const registry = () =>
      (globalThis as Record<symbol, unknown>)[STEP_REGISTRY] as
        | Map<string, unknown>
        | undefined;
    const app = new Map(registry());
    const bundle = await import(pathToFileURL(flow).href);
    const registered = registry();
    if (registered) for (const [id, step] of app) registered.set(id, step);
    return bundle;
  }

  private readManifest(): BundleManifest | undefined {
    const path = join(this.dir, "manifest.json");
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as BundleManifest;
  }

  /**
   * A listener's workflow must carry the id the transform gives it, and the bundle
   * must know that id: a function that was never transformed, or a bundle built
   * before the workflow existed, would fail on its first delivery with a less
   * helpful message.
   *
   * @returns The deps each workflow's steps run with, by workflow id.
   * @throws When one workflow is run by listeners with different deps (an app
   * and a plugin, or two plugin installs): its steps could see only one set.
   */
  private checkListeners(
    manifest: BundleManifest | undefined,
  ): Map<string, Record<string, unknown>> {
    const depsOf = new Map<string, Record<string, unknown>>();
    const known = new Set<string>();
    for (const file of Object.values(manifest?.workflows ?? {}))
      for (const entry of Object.values(file))
        if (entry.workflowId) known.add(entry.workflowId);
    for (const listener of this.listeners) {
      const id = (listener.workflow as { workflowId?: unknown } | undefined)
        ?.workflowId;
      if (typeof id !== "string")
        throw new Error(
          `The workflow of listener '${listener.name}' was not transformed. ` +
            "Run the app with brick dev or brick start, or call registerWorkflowTransform() from @brickkit/cli/workflows before importing it.",
        );
      if (manifest && !known.has(id))
        throw new Error(
          `The workflow bundle does not contain '${id}' (listener '${listener.name}'). Rebuild it with brick dev or brick start.`,
        );
      const deps =
        ((listener as unknown as Record<symbol, unknown>)[PLUGIN_DEPS] as
          | Record<string, unknown>
          | undefined) ?? this.deps;
      if ((depsOf.get(id) ?? deps) !== deps)
        throw new Error(
          `Workflow '${id}' is run by listeners with different deps (listener '${listener.name}'); give each app or plugin install its own workflow.`,
        );
      depsOf.set(id, deps);
    }
    return depsOf;
  }
}
