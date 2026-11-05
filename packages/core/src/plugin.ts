import {
  DuplicateNameError,
  type Action,
  type Resource,
  type Service,
} from "./types";
import {
  PLUGIN_KIND,
  PLUGIN_COMMIT,
  type PluginEndpointContext,
  type PluginRouteMethod,
  type PluginRouteRegistrar,
  type PluginRoutes,
  type PluginRouteScope,
  type ContextOf,
  type ResourcePlugin,
  type ResourcePluginContext,
  type ServicePlugin,
  type ServicePluginContext,
} from "./plugin-types";
import { defineAction } from "./action";
import { actionMeta, type PluginRouteBinding } from "./action-meta";
import { kebabCase, pluginRoutePath } from "./routes";
import { HTTP_METHODS } from "./http";
import { portOf } from "./service-port";

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
  definition: Omit<ServicePlugin<S, A>, typeof PLUGIN_KIND> & {
    setup: (
      context: ServicePluginContext<S>,
    ) => A & (A extends PromiseLike<unknown> ? never : unknown);
  },
): ServicePlugin<S, A> {
  validateName(definition.name);
  return Object.freeze({
    ...definition,
    routes: copyControls(definition.routes),
    [PLUGIN_KIND]: "service" as const,
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
  definition: Omit<ResourcePlugin<S, R, A>, typeof PLUGIN_KIND> & {
    setup: (
      context: ResourcePluginContext<S, R>,
    ) => A & (A extends PromiseLike<unknown> ? never : unknown);
  },
): ResourcePlugin<S, R, A> {
  validateName(definition.name);
  return Object.freeze({
    ...definition,
    routes: copyControls(definition.routes),
    [PLUGIN_KIND]: "resource" as const,
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

type Binding = PluginRouteBinding;
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
  /** The URL segments under each resource that its plugins claim, and which plugin. */
  claims: Map<object, Map<string, string>>;
}
const states = new WeakMap<object, PluginState>();
function stateOf(service: Service<any, any>): PluginState {
  let state = states.get(service);
  if (!state) {
    state = {
      hosts: new Map(),
      actions: new Map(),
      endpoints: [],
      claims: new Map(),
    };
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
      path: pluginRoutePath(binding, prefix),
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

/** The plugin that claimed `segment` under `resource`, if one did. */
export function segmentClaimant(
  service: Service<any, any>,
  resource: object,
  segment: string,
): string | undefined {
  return states.get(service)?.claims.get(resource)?.get(segment);
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
    descriptor[PLUGIN_KIND] !== (resource ? "resource" : "service") &&
    descriptor[PLUGIN_KIND] !== "plugin"
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
  const restore = portOf(service).snapshot();
  const snapshots = {
    hosts: new Map(
      [...state.hosts].map(([key, installations]) => [
        key,
        new Map(installations),
      ]),
    ),
    bindings: new Map(state.actions),
    endpoints: [...state.endpoints],
  };
  const installations =
    state.hosts.get(host) ?? new Map<string, Installation>();
  state.hosts.set(host, installations);
  installations.set(descriptor.name, { descriptor, status: "installing" });
  const names = new Set<string>();
  const commits: (() => void)[] = [];
  const ownedActions = new Set<Action<any, any, any, any>>();
  let active = true;
  const claimed: string[] = [];
  const claim = (segment: string) => {
    if (!resource) throw new Error("Only resource plugins claim URL segments");
    const claims = state.claims.get(resource) ?? new Map<string, string>();
    state.claims.set(resource, claims);
    if (claims.has(segment)) return;
    const taken = service.listActions().find((action) => {
      const info = actionMeta(action).resourceAction;
      return (
        info?.resource === resource.name && kebabCase(info.name) === segment
      );
    });
    if (taken)
      throw new DuplicateNameError(
        `Brick: duplicate name "${taken.name}" in service "${service.name}": "${segment}" is a ${descriptor.name} route`,
      );
    claims.set(segment, descriptor.name);
    claimed.push(segment);
  };
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
      throw new DuplicateNameError(
        `Duplicate plugin route name '${config.name}'`,
      );
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
    if (!HTTP_METHODS.includes(config.method))
      throw new Error(`Invalid plugin route method '${config.method}'`);
    const path = (control && control.path) || config.path;
    validatePath(path);
    const segment = path.split("/")[1]!;
    if (scope === "resource" && segment && !segment.startsWith(":"))
      claim(segment);
    return {
      service: service.name,
      resource: resource?.name,
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
      if (service.getAction(name))
        throw new DuplicateNameError(
          `Duplicate plugin action '${name}' (from plugin '${descriptor.name}')`,
        );
      const {
        scope: _scope,
        runtimeOutput,
        checkInput,
        ...actionConfig
      } = config;
      const action = defineAction({ ...actionConfig, name });
      Object.assign(actionMeta(action), {
        route: binding,
        runtimeOutput,
        checkInput,
      });
      service.action(action);
      ownedActions.add(action);
      state.actions.set(action, binding);
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
    claim,
  };
  try {
    const context = {
      service,
      ...(resource ? { resource } : {}),
      routes,
      [PLUGIN_COMMIT]: (commit: () => void) => commits.push(commit),
    };
    const api = resource
      ? (descriptor as ResourcePlugin<any, any, any>).setup(
          context as typeof context & { resource: Resource<any, any, any> },
        )
      : (descriptor as ServicePlugin<any, any>).setup(context);
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
    for (const commit of commits) commit();
    return resource ?? api;
  } catch (error) {
    for (const action of state.actions.keys())
      if (!snapshots.bindings.has(action)) delete actionMeta(action).route;
    restore();
    state.hosts = snapshots.hosts;
    state.actions = snapshots.bindings;
    state.endpoints = snapshots.endpoints;
    for (const segment of claimed) state.claims.get(resource!)?.delete(segment);
    throw error;
  } finally {
    active = false;
  }
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
