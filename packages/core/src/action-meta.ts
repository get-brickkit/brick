import type { HttpMethod } from "./http";
import type { ActionAccessPolicy, ResourceActionAccess } from "./types";
import type { ServicePort } from "./service-port";

/** Where a plugin mounted one of its actions or endpoints. */
export interface PluginRouteBinding {
  /** Owning plugin descriptor name (e.g. `@brickkit/crud`). Kept separate from the public action name. */
  plugin: string;
  service: string;
  resource?: string;
  path: string;
  method: HttpMethod;
  scope: "app" | "service" | "resource";
  enabled: boolean;
  /** The action's path in the plugin's returned API, for the typed client. */
  clientPath?: string[];
}

/** Set on actions declared with `resource.action(...)`. */
export interface ResourceActionInfo {
  resource: string;
  /** The declared name, without the `resource.` prefix. */
  name: string;
  record: boolean;
  /** A record action's own access rule. */
  access?: ResourceActionAccess;
}

export interface ActionAccessInfo {
  hasAuthorize: boolean;
  hasScope: boolean;
  policy: ActionAccessPolicy;
}

/** What Brick knows about an action besides its config. */
export interface ActionMeta {
  /** The service the action is registered on. */
  service?: ServicePort<any, any>;
  /** Set when a plugin registered the action. */
  route?: PluginRouteBinding;
  resourceAction?: ResourceActionInfo;
  /** How the action is protected, when a plugin checks access inside `execute`. */
  access?: ActionAccessInfo;
  /** The deps of the plugin install that created the action, and when they were bound. */
  deps?: { values: Readonly<Record<string, unknown>>; at: number };
}

/**
 * The slot that holds an action's `ActionMeta`. Process-global, so a second copy
 * of core (bundler SSR, Vitest) reads what the first wrote on the same action.
 */
export const ACTION_META: unique symbol = Symbol.for("brickkit.action.meta");

/** An action's metadata, created empty on first use. */
export function actionMeta(action: object): ActionMeta {
  return ((action as { [ACTION_META]?: ActionMeta })[ACTION_META] ??= {});
}
