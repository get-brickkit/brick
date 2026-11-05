import type { HttpMethod } from "../http";
import { DuplicateNameError, type Service, type Action } from "../types";
import { actionMeta } from "../action-meta";
import {
  checkSegments,
  getActionRoute,
  inputSource,
  isReadLike,
  routeKey,
} from "../routes";
import { portOf } from "../service-port";

export type RouteMethod = HttpMethod;
export interface RouteIR {
  readonly method: RouteMethod;
  readonly path: string;
  readonly service: string;
  readonly action: string;
  readonly kind: "action";
  /** The plugin that registered the action, if one did. */
  readonly plugin?: string;
  readonly input: boolean;
  readonly output: boolean;
  readonly context: boolean;
  readonly authorize: boolean;
  /** Whether the server reads the query first (else path parameters, then body). */
  readonly readLike: boolean;
  /** Where callers send the input: the query (GET, DELETE) or the body. */
  readonly inputSource: "query" | "body";
  readonly coercions: readonly {
    readonly key: string;
    readonly type: "number" | "boolean" | "array";
  }[];
  /** JSON projection for inspection and stale-artifact detection, not runtime validation. */
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}
export interface BrickIR {
  readonly version: 1;
  readonly target: "bun-elysia";
  readonly prefix: string;
  readonly services: readonly string[];
  readonly routes: readonly RouteIR[];
  readonly preparations: readonly {
    service: string;
    name: string;
    metadata: unknown;
  }[];
  readonly diagnostics: readonly string[];
}
export interface RouteBinding {
  readonly service: Service<any, any>;
  readonly action: Action<any, any, any, any>;
}

export function freezeIR<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeIR(child);
    Object.freeze(value);
  }
  return value;
}

function schemaSnapshot(schema: unknown): unknown {
  return schema === undefined ? undefined : JSON.parse(JSON.stringify(schema));
}

export function analyzeApplication(
  services: Service<any, any>[],
  prefix = "/api",
) {
  for (const service of services) service.build();
  return analyzeDeclaredApplication(services, prefix);
}

/** Inspect current declarations without closing service/plugin setup. */
export function analyzeDeclaredApplication(
  services: Service<any, any>[],
  prefix = "/api",
) {
  if (!prefix.startsWith("/"))
    throw new Error("Brick compiler: prefix must start with '/'");
  const names = new Set<string>();
  for (const service of services) {
    if (names.has(service.name))
      throw new DuplicateNameError(`Brick compiler: duplicate service '${service.name}'`);
    names.add(service.name);
  }
  const routes: RouteIR[] = [];
  const bindings: RouteBinding[] = [];
  const registered = new Map<string, { name: string; plugin: boolean }>();
  const diagnostics: string[] = [];
  const add = (
    service: Service<any, any>,
    action: Action<any, any, any, any>,
    method: RouteMethod,
    path: string,
  ) => {
    if (!path.startsWith("/"))
      throw new Error(`Brick compiler: invalid route '${method} ${path}'`);
    const route = describeRoute(service, action, method, path);
    const key = routeKey(method, path);
    const previous = registered.get(key);
    if (previous) {
      if (route.plugin || previous.plugin)
        throw new DuplicateNameError(
          `Brick compiler: duplicate plugin route '${method} ${path}'`,
        );
      diagnostics.push(
        `${key}: '${service.name}.${action.name}' shadowed by '${previous.name}' (first registration wins)`,
      );
      return;
    }
    if (typeof action.config.execute !== "function")
      throw new Error(
        `Brick compiler: '${service.name}.${action.name}' has no execute handler`,
      );
    registered.set(key, {
      name: `${service.name}.${action.name}`,
      plugin: Boolean(route.plugin),
    });
    routes.push(route);
    bindings.push({ service, action });
  };
  for (const service of services) {
    checkSegments(service);
    for (const action of service.listActions()) {
      const route = getActionRoute(action, prefix);
      if (route === false) continue;
      add(service, action, route.method, route.path);
    }
  }
  const preparations = services.flatMap((service) =>
    portOf(service)
      .listPreparations()
      .map((contribution) => ({
        service: service.name,
        name: contribution.name,
        metadata: schemaSnapshot(contribution.describe?.()),
      })),
  );
  const ir: BrickIR = freezeIR({
    version: 1,
    target: "bun-elysia",
    prefix,
    services: [...names],
    routes,
    preparations,
    diagnostics,
  });
  return { ir, bindings };
}

/** What the compiler records about one action route. */
export function describeRoute(
  service: Service<any, any>,
  action: Action<any, any, any, any>,
  method: RouteMethod,
  path: string,
): RouteIR {
  const coercions: { key: string; type: "number" | "boolean" | "array" }[] = [];
  for (const [key, prop] of Object.entries(
    action.config.input?.properties ?? {},
  ) as [string, any][]) {
    if (prop.type === "number" || prop.type === "integer")
      coercions.push({ key, type: "number" });
    else if (prop.type === "boolean") coercions.push({ key, type: "boolean" });
    else if (prop.type === "array") coercions.push({ key, type: "array" });
  }
  const plugin = actionMeta(action).route?.plugin;
  return {
    method,
    path,
    service: service.name,
    action: action.name,
    kind: "action",
    ...(plugin ? { plugin } : {}),
    input: Boolean(action.config.input),
    output: Boolean(action.config.output),
    context: typeof service.options.context === "function",
    authorize: typeof action.config.authorize === "function",
    readLike: isReadLike(method, action.name),
    inputSource: inputSource(method),
    coercions,
    inputSchema: schemaSnapshot(action.config.input),
    outputSchema: schemaSnapshot(action.config.output),
  };
}
