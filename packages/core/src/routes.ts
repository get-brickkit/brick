import { DuplicateNameError, type Action, type Service } from "./types";
import type { HttpMethod } from "./http";
import { actionMeta, type PluginRouteBinding } from "./action-meta";
import { kebabCase } from "./kebab";

export { kebabCase };
export type { ResourceActionInfo } from "./action-meta";

/**
 * The route every name of an owner mounts under: `${prefix}`,
 * `${prefix}/${service}`, or `${prefix}/${service}/${resource}`, in kebab-case.
 */
export function ownerPath(
  prefix: string,
  service?: string,
  resource?: string,
): string {
  let path = prefix.replace(/\/$/, "");
  if (service !== undefined) path += `/${kebabCase(service)}`;
  if (resource !== undefined) path += `/${kebabCase(resource)}`;
  return path;
}

/** Joins a path relative to its owner. `/` is the owner's own route. */
export function joinRoute(base: string, path: string): string {
  return `${base}${path === "/" ? "" : path}` || "/";
}

export interface ActionRoute {
  method: HttpMethod;
  path: string;
}

/** Where a plugin route mounts: under the app prefix, its service, or its resource. */
export function pluginRoutePath(
  binding: PluginRouteBinding,
  prefix: string,
): string {
  return joinRoute(
    binding.scope === "app"
      ? ownerPath(prefix)
      : ownerPath(
          prefix,
          binding.service,
          binding.scope === "resource" ? binding.resource : undefined,
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
  const binding = actionMeta(action).route;
  if (!binding) return undefined;
  if (!binding.enabled) return false;
  return {
    path: pluginRoutePath(binding, prefix),
    method: binding.method,
    clientPath: binding.clientPath,
    plugin: binding.plugin,
    resource: binding.resource,
  };
}

/**
 * Where an action is served over HTTP: its method and its path under the owner
 * tree (`${prefix}/${service}/${action}`, a plugin's route, or a resource
 * action's `${prefix}/${service}/${resource}[/:id]/${action}`).
 *
 * @param action - An action registered on a service.
 * @param prefix - The application's route prefix (default `/api`).
 * @returns `false` when a plugin switched the route off, otherwise the route.
 */
export function getActionRoute(
  action: Action<any, any, any, any>,
  prefix = "/api",
): ActionRoute | false {
  return actionRoute(action, action.serviceName ?? "", prefix);
}

/** `getActionRoute` for an action that may not be registered yet, under `service`. */
export function actionRoute(
  action: Action<any, any, any, any>,
  service: string,
  prefix: string,
): ActionRoute | false {
  const plugin = getPluginActionRoute(action, prefix);
  if (plugin === false) return false;
  if (plugin) return { method: plugin.method, path: plugin.path };
  const method = action.config.method ?? "POST";
  const { resourceAction } = actionMeta(action);
  if (resourceAction) {
    const base = ownerPath(prefix, service, resourceAction.resource);
    return {
      method,
      path:
        action.config.path !== undefined
          ? joinRoute(base, action.config.path)
          : `${base}${resourceAction.record ? "/:id" : ""}/${kebabCase(resourceAction.name)}`,
    };
  }
  const base = ownerPath(prefix, service);
  return {
    method,
    path:
      action.config.path !== undefined
        ? joinRoute(base, action.config.path)
        : `${base}/${kebabCase(action.name)}`,
  };
}

/** The owning plugin and resource of an action, for OpenAPI, introspection and the client contract. */
export function actionOwners(action: Action<any, any, any, any>): {
  plugin?: string;
  resource?: string;
} {
  const { route, resourceAction } = actionMeta(action);
  const resource = route?.resource ?? resourceAction?.resource;
  return {
    ...(route ? { plugin: route.plugin } : {}),
    ...(resource ? { resource } : {}),
  };
}

/** Read-like actions read their input from the query first. */
export function isReadLike(method: HttpMethod, name: string): boolean {
  return (
    method === "GET" ||
    name.startsWith("get") ||
    name.endsWith(".get") ||
    name.startsWith("list") ||
    name.endsWith(".list") ||
    name.startsWith("find") ||
    name.startsWith("read")
  );
}

/** Where a caller sends an action's input (the server merges all sources). */
export function inputSource(method: HttpMethod): "query" | "body" {
  return method === "GET" || method === "DELETE" ? "query" : "body";
}

/** Two routes collide when their keys are equal: the same method and path, whatever the parameter names. */
export function routeKey(method: string, path: string): string {
  return `${method} ${path.replace(/:[^/]+/g, ":param")}`;
}

/**
 * The URL segments after the service that its resources, sockets and actions
 * claim, in that order. An explicit path, a resource action or a plugin route
 * claims none. Two claims of one segment collide.
 */
export function claimedSegments(
  service: Service<any, any>,
): { segment: string; owner: string }[] {
  return [
    ...service.listResources().map((resource) => ({
      segment: kebabCase(resource.name),
      owner: `resource "${resource.name}"`,
    })),
    ...service
      .listSockets()
      .filter((socket) => socket.schema.path === undefined)
      .map((socket) => ({
        segment: kebabCase(socket.schema.name),
        owner: `socket "${socket.schema.name}"`,
      })),
    ...service
      .listActions()
      .filter((action) => {
        const meta = actionMeta(action);
        return (
          action.config.path === undefined &&
          !meta.resourceAction &&
          !meta.route
        );
      })
      .map((action) => ({
        segment: kebabCase(action.name),
        owner: `action "${action.name}"`,
      })),
  ];
}

/** @throws When two of a service's declarations claim the same URL segment. */
export function checkSegments(service: Service<any, any>): void {
  const owners = new Map<string, string>();
  for (const { segment, owner } of claimedSegments(service)) {
    const previous = owners.get(segment);
    if (previous)
      throw new DuplicateNameError(
        `Brick: duplicate name "${segment}" in service "${service.name}": ${previous} and ${owner} share the URL segment`,
      );
    owners.set(segment, owner);
  }
}
