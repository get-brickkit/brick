import type { HttpMethod } from "./http";
import type { TSchema } from "@sinclair/typebox";
import type { PluginInstance } from "./define-plugin";
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

export type PluginRouteMethod = HttpMethod;
export type PluginRouteScope = "app" | "service" | "resource";
export type PluginRoutes<S extends PluginRouteScope = PluginRouteScope> =
  | false
  | Readonly<Record<string, false | { path?: string; scope?: S }>>;

export type ContextOf<S> =
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
  : P extends PluginInstance<infer A extends object, any>
    ? A
    : P extends ResourcePlugin<any, any, infer A>
      ? A
      : never;

/** Which host a plugin descriptor installs on. Process-global, so descriptors survive a second core copy. */
export const PLUGIN_KIND: unique symbol = Symbol.for("brickkit.plugin.kind");
/**
 * The setup context's slot where a `definePlugin` setup hands over what to do
 * once its install succeeds; a failed install drops it.
 */
export const PLUGIN_COMMIT: unique symbol = Symbol.for(
  "brickkit.plugin.commit",
);
export interface ServicePlugin<S extends Service<any, any>, A> {
  readonly [PLUGIN_KIND]: "service" | "plugin";
  readonly name: string;
  readonly routes?: PluginRoutes<"app" | "service">;
  readonly setup: (context: ServicePluginContext<S>) => A;
}
export interface ResourcePlugin<
  S extends Service<any, any>,
  R extends Resource<any, any, any>,
  A extends object,
> {
  readonly [PLUGIN_KIND]: "resource" | "plugin";
  readonly name: string;
  readonly routes?: PluginRoutes;
  readonly setup: (context: ResourcePluginContext<S, R>) => A;
}

/** A plugin as `app.definition.plugins` lists it. */
export interface InstalledPlugin {
  readonly name: string;
  readonly brick?: string;
  readonly scope: "app" | "service" | "resource";
  readonly service?: string;
  readonly resource?: string;
  /** The plugin's dashboard extension, an absolute path. */
  readonly dashboard?: string;
}
