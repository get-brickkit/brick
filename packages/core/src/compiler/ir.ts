import type { HttpMethod } from "../http";
import { DuplicateNameError, type Service, type Action } from "../types";
import { actionMeta } from "../action-meta";
import {
  DEFAULT_PREFIX,
  checkSegments,
  getActionRoute,
  inputSource,
  isReadLike,
  routeKey,
} from "../routes";
import { portOf } from "../service-port";
import { fileFields } from "../typebox";

const FORM_FIELDS_AND_FRAMING_BYTES = 1024 * 1024;

export type RouteMethod = HttpMethod;
/** How a string from a query or form field becomes the schema's type; objects travel as JSON. */
export type Coercion = "number" | "boolean" | "array" | "json";

function coercionOf(schema: any): Coercion | undefined {
  if (schema?.type === "number" || schema?.type === "integer") return "number";
  if (schema?.type === "boolean") return "boolean";
  if (schema?.type === "array") return "array";
  if (schema?.type === "object") return "json";
  return undefined;
}
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
    readonly type: Coercion;
    /** How each item of an `array` field is coerced. */
    readonly items?: Exclude<Coercion, "array">;
  }[];
  /** The most bytes a multipart body may declare (`Content-Length`) for an input with `t.File` fields. */
  readonly bodyLimit?: number;
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
  prefix = DEFAULT_PREFIX,
) {
  for (const service of services) service.build();
  return analyzeDeclaredApplication(services, prefix);
}

/** Inspect current declarations without closing service/plugin setup. */
export function analyzeDeclaredApplication(
  services: Service<any, any>[],
  prefix = DEFAULT_PREFIX,
) {
  if (!prefix.startsWith("/"))
    throw new Error("Brick compiler: prefix must start with '/'");
  const names = new Set<string>();
  for (const service of services) {
    if (names.has(service.name))
      throw new DuplicateNameError(
        `Brick compiler: duplicate service '${service.name}'`,
      );
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
        `${key}: '${service.name}.${action.name}' shadowed by '${previous.name}' (earlier service, then lower action name, wins)`,
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
  // Registration order follows module evaluation, which bundlers reorder (#107),
  // so routes are canonical: by route key, then service order, then action name.
  const candidates: [
    string,
    number,
    Service<any, any>,
    Action<any, any, any, any>,
    RouteMethod,
    string,
  ][] = [];
  for (const [index, service] of services.entries()) {
    checkSegments(service);
    for (const action of service.listActions()) {
      const route = getActionRoute(action, prefix);
      if (route === false) continue;
      candidates.push([
        routeKey(route.method, route.path),
        index,
        service,
        action,
        route.method,
        route.path,
      ]);
    }
  }
  candidates.sort(
    (a, b) =>
      compare(a[0], b[0]) || a[1] - b[1] || compare(a[3].name, b[3].name),
  );
  for (const [, , service, action, method, path] of candidates)
    add(service, action, method, path);
  const preparations = services.flatMap((service) =>
    portOf(service)
      .listPreparations()
      .map((contribution) => ({
        service: service.name,
        name: contribution.name,
        metadata: schemaSnapshot(contribution.describe?.()),
      }))
      .sort((a, b) => compare(a.name, b.name)),
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

/** Code-unit order, independent of locale. */
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What the compiler records about one action route. */
export function describeRoute(
  service: Service<any, any>,
  action: Action<any, any, any, any>,
  method: RouteMethod,
  path: string,
): RouteIR {
  const coercions: RouteIR["coercions"][number][] = [];
  for (const [key, prop] of Object.entries(
    action.config.input?.properties ?? {},
  ) as [string, any][]) {
    const type = coercionOf(prop);
    if (!type) continue;
    const items = type === "array" ? coercionOf(prop.items) : undefined;
    coercions.push(
      items && items !== "array" ? { key, type, items } : { key, type },
    );
  }
  const plugin = actionMeta(action).route?.plugin;
  const files = fileFields(action.config.input);
  const bodyLimit =
    files.length && files.every((field) => field.maxBytes !== undefined)
      ? files.reduce((sum, field) => sum + (field.maxBytes ?? 0), 0) +
        FORM_FIELDS_AND_FRAMING_BYTES
      : undefined;
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
    ...(bodyLimit === undefined ? {} : { bodyLimit }),
    inputSchema: schemaSnapshot(action.config.input),
    outputSchema: schemaSnapshot(action.config.output),
  };
}
