import type { TSchema } from "@sinclair/typebox";
import type {
  Action,
  ActionConfigWithAuthorize,
  ActionConfigWithoutAuthorize,
  ActionContext,
  ActionErrorDefinition,
  BaseContext,
  Resource,
  Service,
} from "./types";
import { getGlobalRegistry } from "./registry";
import { defineAction } from "./action";
import { joinRoute, ownerPath } from "./routes";

export type PluginRouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type PluginRouteScope = "app" | "service" | "resource";
export type PluginRoutes<S extends PluginRouteScope = PluginRouteScope> =
  | false
  | Readonly<Record<string, false | { path?: string; scope?: S }>>;

type ContextOf<S> =
  S extends Service<infer D, infer C> ? BaseContext<D> & C : never;

export interface PluginEndpointContext<
  C extends ActionContext = ActionContext,
> {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  headers: Record<string, string>;
  request: Request;
  set: { status?: number; headers: Record<string, string> };
  ctx: C;
}

export interface PluginRouteRegistrar<
  C extends ActionContext = ActionContext,
  S extends PluginRouteScope = PluginRouteScope,
> {
  action<
    I extends TSchema | undefined = undefined,
    O extends TSchema | undefined = undefined,
    E extends Record<string, ActionErrorDefinition> = Record<
      string,
      ActionErrorDefinition
    >,
  >(
    config: ActionConfigWithAuthorize<I, O, E, C> & {
      path: string;
      method: PluginRouteMethod;
      scope?: S;
    },
  ): Action<I, O, E, C>;
  action<
    I extends TSchema | undefined = undefined,
    O extends TSchema | undefined = undefined,
    E extends Record<string, ActionErrorDefinition> = Record<
      string,
      ActionErrorDefinition
    >,
  >(
    config: ActionConfigWithoutAuthorize<I, O, E, C> & {
      path: string;
      method: PluginRouteMethod;
      scope?: S;
    },
  ): Action<I, O, E, C>;
  endpoint(config: {
    name: string;
    path: string;
    method: PluginRouteMethod;
    scope?: S;
    handler: (context: PluginEndpointContext<C>) => unknown | Promise<unknown>;
    summary?: string;
    description?: string;
    tags?: string[];
  }): void;
}

export interface ServicePluginContext<
  S extends Service<any, any> = Service<any, any>,
> {
  service: S;
  routes: PluginRouteRegistrar<ContextOf<S>, "app" | "service">;
}
export interface ResourcePluginContext<
  S extends Service<any, any> = Service<any, any>,
  R extends Resource<any, any, any> = Resource<any, ContextOf<S>, any>,
> {
  service: S;
  resource: R;
  routes: PluginRouteRegistrar<ContextOf<S>>;
}

/** Plugins may specialize their returned API for the installation host. */
export interface ResourcePluginTypes {
  readonly table: unknown;
  readonly context: unknown;
  readonly resource: unknown;
  readonly api: object;
}
export type ResourcePluginAPI<P, T, C, R = unknown> = P extends {
  readonly types: infer H extends ResourcePluginTypes;
}
  ? (H & {
      readonly table: T;
      readonly context: C;
      readonly resource: R;
    })["api"]
  : P extends import("./define-plugin").PluginInstance<
        infer A extends object,
        any
      >
    ? A
    : P extends ResourcePlugin<any, any, infer A>
      ? A
      : never;

// Process-global like actionBindingKey, so descriptors survive a second core copy.
const pluginKind: unique symbol = Symbol.for("brickkit.plugin.kind");
/** `definePlugin` instances install on either host; see `define-plugin.ts`. */
export const pluginFinish: unique symbol = Symbol.for("brickkit.plugin.finish");
export interface ServicePlugin<S extends Service<any, any>, A> {
  readonly [pluginKind]: "service" | "plugin";
  readonly name: string;
  readonly routes?: PluginRoutes<"app" | "service">;
  readonly setup: (context: ServicePluginContext<S>) => A;
}
export interface ResourcePlugin<
  S extends Service<any, any>,
  R extends Resource<any, any, any>,
  A extends object,
> {
  readonly [pluginKind]: "resource" | "plugin";
  readonly name: string;
  readonly routes?: PluginRoutes;
  readonly setup: (context: ResourcePluginContext<S, R>) => A;
}

/**
 * Define a plugin that installs onto a service with `service.use(plugin)`. Its
 * `setup` receives the service and a `routes` registrar for adding actions and
 * raw HTTP endpoints, and returns the typed API that `service.use` hands back.
 *
 * @param definition - A unique `name`, optional `routes` controls that let the
 * user move or switch off the plugin's routes, and `setup`, which must be
 * synchronous.
 * @returns The plugin descriptor, frozen.
 * @throws When the name is empty or has surrounding whitespace.
 * @example
 * import { defineServicePlugin, t } from "@brickkit/core";
 *
 * export const greeting = (salutation = "Hello") =>
 *   defineServicePlugin({
 *     name: "example/greeting",
 *     setup({ routes }) {
 *       const hello = routes.action({
 *         name: "hello",
 *         input: t.Object({ name: t.String() }),
 *         output: t.String(),
 *         execute: ({ input }) => `${salutation}, ${input.name}!`,
 *       });
 *       return { hello };
 *     },
 *   });
 *
 * const api = greeterService.use(greeting("Welcome"));
 * await api.hello({ input: { name: "Ada" } });
 */
export function defineServicePlugin<
  S extends Service<any, any> = Service<any, any>,
  A = unknown,
>(
  definition: Omit<ServicePlugin<S, A>, typeof pluginKind> & {
    setup: (
      context: ServicePluginContext<S>,
    ) => A & (A extends PromiseLike<unknown> ? never : unknown);
  },
): ServicePlugin<S, A> {
  validateName(definition.name);
  return Object.freeze({
    ...definition,
    routes: copyControls(definition.routes),
    [pluginKind]: "service" as const,
  });
}
/**
 * Define a plugin that installs onto a resource (a table and its entity) with
 * `resource.use(plugin)`. Its `setup` receives the service, the resource, and a
 * `routes` registrar, whose routes mount under `${prefix}/${service}/${resource}`, and
 * returns the typed API that `resource.use` hands back. `crud` is built this way.
 *
 * @param definition - A unique `name`, optional `routes` controls, and `setup`,
 * which must be synchronous.
 * @returns The plugin descriptor, frozen.
 * @throws When the name is empty or has surrounding whitespace.
 */
export function defineResourcePlugin<
  S extends Service<any, any> = Service<any, any>,
  R extends Resource<any, any, any> = Resource<any, ContextOf<S>, any>,
  A extends object = object,
>(
  definition: Omit<ResourcePlugin<S, R, A>, typeof pluginKind> & {
    setup: (
      context: ResourcePluginContext<S, R>,
    ) => A & (A extends PromiseLike<unknown> ? never : unknown);
  },
): ResourcePlugin<S, R, A> {
  validateName(definition.name);
  return Object.freeze({
    ...definition,
    routes: copyControls(definition.routes),
    [pluginKind]: "resource" as const,
  });
}

function validateName(name: string) {
  if (!name || name.trim() !== name)
    throw new Error(
      "Plugin and route names must be nonempty and have no surrounding whitespace",
    );
}
function validatePath(path: string) {
  if (
    !path.startsWith("/") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("//") ||
    path.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(`Invalid plugin route path '${path}'`);
  }
}
function copyControls<S extends PluginRouteScope>(
  controls: PluginRoutes<S> | undefined,
): PluginRoutes<S> | undefined {
  if (controls === undefined || controls === false) return controls;
  const result: Record<string, false | { path?: string; scope?: S }> =
    Object.create(null);
  for (const [name, value] of Object.entries(controls)) {
    validateName(name);
    if (value === false) {
      result[name] = false;
      continue;
    }
    if (value.path !== undefined) validatePath(value.path);
    if (
      value.scope !== undefined &&
      !["app", "service", "resource"].includes(value.scope)
    )
      throw new Error(`Invalid plugin route scope '${value.scope}'`);
    result[name] = Object.freeze({ ...value });
  }
  return Object.freeze(result);
}

interface Binding {
  service: Service<any, any>;
  resource?: Resource<any, any, any>;
  /** Owning plugin descriptor name (e.g. `@brickkit/crud`). Kept separate from the public action name. */
  plugin: string;
  path: string;
  method: PluginRouteMethod;
  scope: PluginRouteScope;
  enabled: boolean;
  clientPath?: string[];
}
interface RawBinding extends Binding {
  handler: (context: PluginEndpointContext<any>) => unknown | Promise<unknown>;
  summary?: string;
  description?: string;
  tags?: string[];
}
interface Installation {
  descriptor: object;
  status: "installing" | "installed";
  api?: unknown;
}
interface PluginState {
  hosts: Map<object, Map<string, Installation>>;
  actions: Map<Action<any, any, any, any>, Binding>;
  endpoints: RawBinding[];
}
const states = new WeakMap<object, PluginState>();
const actionBindings = new WeakMap<Action<any, any, any, any>, Binding>();
/**
 * Cross-copy binding protocol. Bundler SSR runtimes (Vite, Nitro, Vitest)
 * may load a second copy of core that owns a different WeakMap, while the
 * action objects themselves cross the boundary by reference. The binding
 * travels on the action under a process-global symbol so route lookups
 * (including disabled-route suppression) keep working there.
 */
const actionBindingKey = Symbol.for("brickkit.plugin.actionBinding");
function stateOf(service: Service<any, any>): PluginState {
  let state = states.get(service);
  if (!state) {
    state = { hosts: new Map(), actions: new Map(), endpoints: [] };
    states.set(service, state);
  }
  return state;
}
export function isInstallingPlugin(service: Service<any, any>): boolean {
  return [...(states.get(service)?.hosts.values() ?? [])].some(
    (installations) =>
      [...installations.values()].some((item) => item.status === "installing"),
  );
}

function pathOf(binding: Binding, prefix: string) {
  return joinRoute(
    binding.scope === "app"
      ? ownerPath(prefix)
      : ownerPath(
          prefix,
          binding.service.name,
          binding.scope === "resource" ? binding.resource!.name : undefined,
        ),
    binding.path,
  );
}
/**
 * Where a plugin mounted an action over HTTP, for the OpenAPI generator, the
 * compiler, and the typed client.
 *
 * @param action - An action.
 * @param prefix - The application's route prefix (default `/api`).
 * @returns `undefined` when no plugin bound the action (it uses its own route),
 * `false` when the plugin's route was switched off, otherwise the route's
 * `path`, `method`, the `clientPath` the typed client uses, and the owning
 * `plugin` and `resource`.
 */
export function getPluginActionRoute(
  action: Action<any, any, any, any>,
  prefix = "/api",
) {
  const binding =
    (action as unknown as Record<symbol, Binding | undefined>)[
      actionBindingKey
    ] ?? actionBindings.get(action);
  if (!binding) return undefined;
  if (!binding.enabled) return false;
  return {
    path: pathOf(binding, prefix),
    method: binding.method,
    clientPath: binding.clientPath,
    plugin: binding.plugin,
    resource: binding.resource?.name,
  };
}
/**
 * The raw HTTP endpoints plugins registered on a service, ready to mount on the
 * application. Each handler resolves the service's context before it runs.
 *
 * @param service - The service plugins were installed on.
 * @param prefix - The application's route prefix (default `/api`).
 * @returns The enabled endpoints: `path`, `method`, `handler`, and the
 * `summary`, `description`, and `tags` for OpenAPI.
 */
export function getPluginEndpoints(
  service: Service<any, any>,
  prefix = "/api",
) {
  return stateOf(service)
    .endpoints.filter((binding) => binding.enabled)
    .map((binding) => ({
      path: pathOf(binding, prefix),
      method: binding.method,
      service,
      plugin: binding.plugin,
      summary: binding.summary,
      description: binding.description,
      tags: binding.tags,
      handler: async (context: Omit<PluginEndpointContext, "ctx">) =>
        binding.handler({
          ...context,
          ctx: await service.resolveContext({ request: context.request }),
        }),
    }));
}

/** Descriptor identity is scoped to the service or resource installation host. */
export function installPlugin(
  service: Service<any, any>,
  resource: Resource<any, any, any> | undefined,
  descriptor: ServicePlugin<any, any> | ResourcePlugin<any, any, any>,
) {
  if (service.isBuilt)
    throw new Error("Plugins must be installed before service build");
  if (
    descriptor[pluginKind] !== (resource ? "resource" : "service") &&
    descriptor[pluginKind] !== "plugin"
  )
    throw new Error("Plugin does not support this installation host");
  const state = stateOf(service);
  const host = resource ?? service;
  const existing = state.hosts.get(host)?.get(descriptor.name);
  if (existing) {
    if (existing.status === "installing")
      throw new Error(`Plugin dependency cycle at '${descriptor.name}'`);
    if (existing.descriptor !== descriptor)
      throw new Error(
        `Plugin '${descriptor.name}' already installed with a different descriptor; reuse the original descriptor`,
      );
    return resource ?? existing.api;
  }
  const snapshots = {
    actions: new Map(service.actions),
    tools: new Map(service.tools),
    tables: new Map(service.tables),
    resources: new Map(service.resources),
    preparations: new Map(service.preparations),
    hosts: new Map(
      [...state.hosts].map(([key, installations]) => [
        key,
        new Map(installations),
      ]),
    ),
    bindings: new Map(state.actions),
    endpoints: [...state.endpoints],
    properties: new Map(
      [...service.resources.values()].map((item) => [
        item,
        Object.getOwnPropertyDescriptors(item),
      ]),
    ),
  };
  const installations =
    state.hosts.get(host) ?? new Map<string, Installation>();
  state.hosts.set(host, installations);
  installations.set(descriptor.name, { descriptor, status: "installing" });
  const names = new Set<string>();
  const ownedActions = new Set<Action<any, any, any, any>>();
  let active = true;
  const bindingFor = (config: {
    name: string;
    path: string;
    method: PluginRouteMethod;
    scope?: PluginRouteScope;
  }): Binding => {
    if (!active || service.isBuilt)
      throw new Error("Plugin routes can only be registered during setup");
    validateName(config.name);
    validatePath(config.path);
    if (names.has(config.name))
      throw new Error(`Duplicate plugin route name '${config.name}'`);
    names.add(config.name);
    const control =
      descriptor.routes === false ? false : descriptor.routes?.[config.name];
    const scope =
      (control && control.scope) ||
      config.scope ||
      (resource ? "resource" : "service");
    if (scope === "resource" && !resource)
      throw new Error("Service plugin routes cannot use resource scope");
    if (!["app", "service", "resource"].includes(scope))
      throw new Error(`Invalid plugin route scope '${scope}'`);
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(config.method))
      throw new Error(`Invalid plugin route method '${config.method}'`);
    const path = (control && control.path) || config.path;
    validatePath(path);
    return {
      service,
      resource,
      plugin: descriptor.name,
      path,
      method: config.method,
      scope,
      enabled: control !== false,
    };
  };
  const routes: PluginRouteRegistrar<any> = {
    action(config: any) {
      const binding = bindingFor(config);
      for (const match of binding.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
        if (
          !config.input?.properties ||
          !Object.hasOwn(config.input.properties, match[1]!)
        )
          throw new Error(
            `Plugin action path parameter '${match[1]}' must be declared in its input schema`,
          );
      }
      // Public contract name: resource/operation only (e.g. `page.list`).
      // The owning plugin stays in binding metadata (`plugin`) and on the
      // action (`plugin`/`resource`) so it never leaks into exported names,
      // OpenAPI, or client contracts.
      const name = `${resource ? `${resource.name}.` : ""}${config.name}`;
      if (service.actions.has(name))
        throw new Error(
          `Duplicate plugin action '${name}' (from plugin '${descriptor.name}')`,
        );
      const { scope: _scope, ...actionConfig } = config;
      const action = defineAction({ ...actionConfig, name });
      (action as unknown as Record<string, unknown>).plugin = descriptor.name;
      if (resource)
        (action as unknown as Record<string, unknown>).resource = resource.name;
      service.action(action);
      ownedActions.add(action);
      state.actions.set(action, binding);
      actionBindings.set(action, binding);
      // Same object travels across bundler module copies; see actionBindingKey.
      (action as unknown as Record<symbol, Binding>)[actionBindingKey] =
        binding;
      return action;
    },
    endpoint(config) {
      const binding = bindingFor(config);
      state.endpoints.push({
        ...binding,
        handler: config.handler,
        summary: config.summary,
        description: config.description,
        tags: config.tags,
      });
    },
  };
  try {
    const api = resource
      ? (descriptor as ResourcePlugin<any, any, any>).setup({
          service,
          resource,
          routes,
        })
      : (descriptor as ServicePlugin<any, any>).setup({ service, routes });
    if (api && typeof api === "object" && "then" in api)
      throw new Error("Plugin setup must be synchronous");
    if (
      descriptor.routes &&
      Object.keys(descriptor.routes).some((name) => !names.has(name))
    )
      throw new Error(
        `Plugin '${descriptor.name}' has an override for an unknown route`,
      );
    const walk = (value: unknown, path: string[], ancestors: Set<object>) => {
      if (typeof value === "function") {
        const binding = state.actions.get(value as Action<any, any, any, any>);
        if (binding && ownedActions.has(value as Action<any, any, any, any>)) {
          if (binding.clientPath)
            throw new Error("Plugin actions must have one returned API path");
          binding.clientPath = resource
            ? [service.name, resource.name, ...path]
            : [service.name, ...path];
        }
      } else if (value && typeof value === "object" && !ancestors.has(value)) {
        const next = new Set(ancestors).add(value);
        for (const [key, child] of Object.entries(value))
          walk(child, [...path, key], next);
      }
    };
    walk(api, [], new Set());
    if (resource) {
      if (!api || typeof api !== "object" || Array.isArray(api))
        throw new Error("Resource plugins must return named API contributions");
      for (const key of Object.keys(api)) {
        if (
          key in resource ||
          ["__proto__", "prototype", "constructor"].includes(key)
        )
          throw new Error(
            `Resource plugin contribution '${key}' collides with an existing property`,
          );
      }
      Object.assign(resource, api);
    }
    state.hosts.get(host)!.set(descriptor.name, {
      descriptor,
      status: "installed",
      api,
    });
    finish(descriptor, true);
    getGlobalRegistry().touch();
    return resource ?? api;
  } catch (error) {
    finish(descriptor, false);
    for (const action of state.actions.keys())
      if (!snapshots.bindings.has(action)) {
        actionBindings.delete(action);
        delete (action as unknown as Record<symbol, unknown>)[actionBindingKey];
      }
    restoreMap(service.actions, snapshots.actions);
    restoreMap(service.tools, snapshots.tools);
    restoreMap(service.tables, snapshots.tables);
    restoreMap(service.resources, snapshots.resources);
    restoreMap(service.preparations, snapshots.preparations);
    state.hosts = snapshots.hosts;
    state.actions = snapshots.bindings;
    state.endpoints = snapshots.endpoints;
    for (const [item, properties] of snapshots.properties) {
      for (const key of Reflect.ownKeys(item))
        if (!Object.hasOwn(properties, key)) Reflect.deleteProperty(item, key);
      Object.defineProperties(item, properties);
    }
    getGlobalRegistry().touch();
    throw error;
  } finally {
    active = false;
  }
}
function finish(descriptor: object, installed: boolean) {
  (descriptor as { [pluginFinish]?: (installed: boolean) => void })[
    pluginFinish
  ]?.(installed);
}
/** Whether a plugin named `name` is installed on `host` (the service or a resource). */
export function hasPlugin(
  service: Service<any, any>,
  host: object,
  name: string,
): boolean {
  return (
    states.get(service)?.hosts.get(host)?.get(name)?.status === "installed"
  );
}
/** Every descriptor installed on the service or its resources, in install order per host. */
export function installedPlugins(service: Service<any, any>): object[] {
  return [...(states.get(service)?.hosts.values() ?? [])].flatMap(
    (installations) =>
      [...installations.values()]
        .filter((item) => item.status === "installed")
        .map((item) => item.descriptor),
  );
}
function restoreMap<K, V>(target: Map<K, V>, snapshot: Map<K, V>) {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}
