import { PLUGIN_DEPS, runWithDeps } from "./deps";
import type { EventListener } from "./events/types";
import type {
  PluginInstallOptions,
  PluginInstance,
  PluginManifest,
} from "./define-plugin";
import type { InstalledPlugin } from "./plugin-types";

export const INTERNALS = Symbol.for("brickkit.plugin.internals");
interface Installation {
  scope: "app" | "service" | "resource";
  service?: string;
  resource?: string;
}
export interface Internals {
  manifest: PluginManifest<any, any, any, any, any, any, any>;
  options: Record<string, unknown>;
  deps: Readonly<Record<string, unknown>>;
  install: PluginInstallOptions;
  dashboard?: string;
  installs: Installation[];
  /** When it was first installed, to run `app` parts in install order. */
  order?: number;
}

export function isPluginInstance(value: unknown): value is PluginInstance {
  return (
    typeof value === "object" &&
    value !== null &&
    INTERNALS in (value as object)
  );
}
function internalsOf(value: unknown): Internals | undefined {
  return isPluginInstance(value)
    ? ((value as unknown as Record<symbol, Internals>)[INTERNALS] ?? undefined)
    : undefined;
}

/**
 * What `brick()` does with plugins: install those given in `plugins` on the
 * app, run every plugin's `app` part in install order, and return the
 * lifecycle, middleware and listeners they contributed.
 */
export function setupAppPlugins(
  installedOnServices: readonly object[],
  appPlugins: readonly unknown[],
) {
  const instances = new Set<PluginInstance>();
  for (const descriptor of installedOnServices)
    if (isPluginInstance(descriptor)) instances.add(descriptor);
  const ordered = [...instances].sort(
    (a, b) => (internalsOf(a)!.order ?? 0) - (internalsOf(b)!.order ?? 0),
  );
  const onApp = new Set<string>();
  for (const plugin of appPlugins) {
    const internals = internalsOf(plugin);
    if (!internals)
      throw new Error(
        "brick({ plugins }) takes instances from definePlugin(), such as audit()",
      );
    const { manifest } = internals;
    if (!manifest.app || manifest.tables || manifest.events)
      throw new Error(
        `${manifest.name} cannot be installed on the app; ${
          manifest.resource ? "use resource.use()" : "use service.use()"
        }`,
      );
    for (const required of manifest.requires ?? [])
      if (!onApp.has(required))
        throw new Error(
          `${manifest.name} requires ${required}, installed in brick({ plugins }) before it`,
        );
    if (onApp.has(manifest.name))
      throw new Error(`Plugin ${manifest.name} is installed on the app twice`);
    // Its `app` part already runs from the service or resource install; running it again would double every hook.
    const installed = ordered.find(
      (other) => internalsOf(other)!.manifest.name === manifest.name,
    );
    if (installed)
      throw new Error(
        `Plugin ${manifest.name} is already installed with ${internalsOf(
          installed,
        )!
          .installs.map((install) =>
            install.scope === "resource"
              ? `${install.service}.${install.resource}.use()`
              : `${install.service}.use()`,
          )
          .join(
            ", ",
          )}, which runs its app part too; remove it from brick({ plugins })`,
      );
    onApp.add(manifest.name);
    if (!internals.installs.some((item) => item.scope === "app"))
      internals.installs.push({ scope: "app" });
    ordered.push(plugin as PluginInstance);
  }

  const lifecycles: Lifecycle[] = [];
  const middleware: ((context: any) => unknown)[] = [];
  const listeners: EventListener[] = [];
  const listed: InstalledPlugin[] = [];
  for (const plugin of ordered) {
    const { manifest, options, deps, installs, dashboard } =
      internalsOf(plugin)!;
    for (const install of installs)
      listed.push(
        Object.freeze({
          name: manifest.name,
          ...(manifest.brick ? { brick: manifest.brick } : {}),
          ...install,
          ...(dashboard ? { dashboard } : {}),
        }),
      );
    if (!manifest.app) continue;
    const lifecycle = { options, secrets: manifest.secrets ?? {}, deps };
    // A plugin's start and stop pair up, so stop runs only after its start did.
    const own = { start: [] as Function[], stop: [] as Function[] };
    manifest.app({
      ...lifecycle,
      on(event, handler) {
        if (event !== "start" && event !== "stop")
          throw new Error(`${manifest.name}: on() takes "start" or "stop"`);
        own[event].push(handler);
      },
      middleware(handler) {
        middleware.push(handler);
      },
      listeners(...items) {
        // `useDeps()` in a plugin's listener returns the plugin's deps, not the app's.
        listeners.push(
          ...items.map((listener) => {
            const run = listener.run;
            // The workflow runtime runs this workflow's steps with these deps.
            if (!run) return { ...listener, [PLUGIN_DEPS]: deps };
            return {
              ...listener,
              run: (delivery: Parameters<typeof run>[0]) =>
                runWithDeps(deps, () => run(delivery)),
            };
          }),
        );
      },
    });
    lifecycles.push({
      start: async () => {
        for (const handler of own.start) await handler(lifecycle);
      },
      stop: async () => {
        for (const handler of own.stop) await handler(lifecycle);
      },
    });
  }
  return { lifecycles, middleware, listeners, plugins: listed };
}

interface Lifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start in install order. Stop what started, in reverse order; a start that
 * fails stops those before it and rethrows.
 */
export function pluginLifecycle(lifecycles: readonly Lifecycle[]) {
  let started: Promise<void> | undefined;
  const running: Lifecycle[] = [];
  const stopAll = async () => {
    const errors: unknown[] = [];
    for (const item of running.splice(0).reverse())
      try {
        await item.stop();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, "Plugins failed to stop");
  };
  return {
    start(): Promise<void> {
      return (started ??= (async () => {
        for (const item of lifecycles) {
          try {
            await item.start();
          } catch (error) {
            await stopAll().catch(() => undefined);
            started = undefined;
            throw error;
          }
          running.push(item);
        }
      })());
    },
    async stop(): Promise<void> {
      await started?.catch(() => undefined);
      started = undefined;
      await stopAll();
    },
  };
}
