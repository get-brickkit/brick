import type { HttpMethod } from "./http";
import type { RouteIR } from "./compiler/ir";
import type { Elysia } from "elysia";
import type { Logger, Service } from "./types";
import type { DatabaseHandle } from "./db/define";
import type { ApiDocument, DocumentationOptions } from "./docs";
import type { DashboardOptions } from "./dashboard";
import type { EventsDefinition, EventsHub } from "./events/hub";
import { toErrorResponse } from "./error-response";
import { pathParamNames, toOpenApiPath } from "./routes";
import { createLogger } from "./logger";
import { requestIds } from "./context";
import { ActionExecutionError, ValidationError } from "./types";
import type { BrickSocketSchema } from "./socket-types";
import type { InstalledPlugin } from "./plugin-types";

export type EndpointMethod = HttpMethod;

/** The logger handed to endpoint handlers (the same one actions get). */
export type EndpointLogger = Logger;

/** Context for raw endpoint handlers: Elysia route fields + Brick extras. */
export interface EndpointContext {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  headers: Record<string, string>;
  request: Request;
  /** Elysia response setter (status/headers). Mutate like in `app.get`. */
  set: { status?: number; headers: Record<string, string> };
  /** Drizzle db from `service` (or first service with one); `undefined` when none. */
  db: any;
  logger: EndpointLogger;
  traceId: string;
  requestId: string;
}

export interface EndpointDefinition {
  method: EndpointMethod;
  /** Elysia-style path, e.g. `/p/:slug`. */
  path: string;
  handler: (ctx: EndpointContext) => unknown | Promise<unknown>;
  /** Db source: instance or registered service name. Defaults to first service with a db. */
  service?: Service<any, any> | string;
  /** Explicit database handle, independent of a service. */
  database?: DatabaseHandle<unknown>;
  summary?: string;
  description?: string;
  tags?: string[];
  /** The plugin that contributed it; OpenAPI labels it `x-brick-plugin`. */
  plugin?: string;
}

/** Resolve the db for an endpoint: explicit service first, else first service holding one. */
export function resolveEndpointDb(
  service: Service<any, any> | string | undefined,
  services: Service<any, any>[],
): any {
  if (service) {
    const svc =
      typeof service === "string"
        ? services.find((s) => s.name === service)
        : (service as Service<any, any>);
    return svc?.getDb();
  }
  for (const svc of services) {
    const db = svc.getDb();
    if (db) return db;
  }
  return undefined;
}

/** Wrap a raw handler with trace ids, logger, db, and mesh-consistent error mapping. */
export function createEndpointHandler(
  def: EndpointDefinition,
  services: Service<any, any>[],
): (elysiaCtx: any) => Promise<unknown> {
  const tag = `endpoint:${def.method} ${def.path}`;
  const logger = createLogger(`[${tag}]`);
  return async ({ params, body, query, headers, request, set }: any) => {
    const { traceId, requestId } = requestIds(headers, set);

    const ctx: EndpointContext = {
      body,
      db: def.database
        ? def.database.getDb()
        : resolveEndpointDb(def.service, services),
      headers: headers ?? {},
      logger,
      params: params ?? {},
      query: query ?? {},
      request:
        request instanceof Request
          ? request
          : new Request(`http://localhost${def.path}`, {
              headers: new Headers((headers as Record<string, string>) ?? {}),
              method: def.method,
            }),
      requestId,
      set,
      traceId,
    };

    try {
      return await def.handler(ctx);
    } catch (err) {
      const failure =
        !(
          err instanceof ActionExecutionError || err instanceof ValidationError
        ) &&
        err !== null &&
        typeof err === "object" &&
        "status" in err &&
        typeof err.status === "number" &&
        Number.isInteger(err.status) &&
        err.status >= 400 &&
        err.status < 500
          ? new ActionExecutionError(
              "HTTP_ERROR",
              "message" in err && typeof err.message === "string"
                ? err.message
                : "Endpoint error",
              err.status,
              undefined,
              { cause: err },
            )
          : err;
      const response = toErrorResponse(failure, {
        logger: ctx.logger,
        requestId,
      });
      set.status = response.status;
      return response;
    }
  };
}

/** OpenAPI `paths` fragment for declared endpoints (raw HTML included). */
export function endpointPaths(defs: EndpointDefinition[]): Record<string, any> {
  const paths: Record<string, any> = {};
  for (const def of defs) {
    const openApiPath = toOpenApiPath(def.path);
    if (!paths[openApiPath]) paths[openApiPath] = {};
    const params = pathParamNames(def.path).map((name) => ({
      in: "path",
      name,
      required: true,
      schema: { type: "string" },
    }));
    paths[openApiPath][def.method.toLowerCase()] = {
      ...(def.summary ? { summary: def.summary } : {}),
      ...(def.description ? { description: def.description } : {}),
      ...(def.tags ? { tags: def.tags } : {}),
      ...(def.plugin ? { "x-brick-plugin": def.plugin } : {}),
      ...(params.length > 0 ? { parameters: params } : {}),
      responses: { 200: { description: "Successful response" } },
    };
  }
  return paths;
}

/** The app object returned by `brick`: Elysia plus `endpoint()`. */
export type BrickApp = Elysia<any, any, any, any, any, any, any> & {
  /** Service definitions, prefix, and telemetry setting chosen at construction. */
  readonly definition: {
    readonly routes: readonly RouteIR[];
    readonly sockets: readonly (BrickSocketSchema & {
      service: string;
      path: string;
    })[];
    readonly services: readonly Service<any, any>[];
    readonly prefix: string;
    readonly telemetry: boolean;
    readonly documentation?: DocumentationOptions;
    /** What `brick start` serves for monitoring; its `auth` is not enumerable. */
    readonly dashboard?: DashboardOptions;
    /** The listeners and settings of `events`, as plain data. */
    readonly events?: EventsDefinition;
    /** Every `definePlugin` installation, in install order. */
    readonly plugins?: readonly InstalledPlugin[];
  };
  /**
   * Run the plugins' `on("start")` handlers in install order, once. `listen`
   * calls it; `brick dev` and `brick start` await it before serving. `stop()`
   * runs their `on("stop")` handlers in reverse order.
   */
  start(): Promise<void>;
  /**
   * Start the plugins, listen on `port`, then start event delivery. What
   * `brick dev`, `brick start` and a built server run.
   */
  serve(options: { port: number }): Promise<BrickApp>;
  /**
   * Stop event delivery (finishing deliveries in flight), then the server, then
   * the plugins. `closeActiveConnections` is passed to `stop()`.
   */
  shutdown(closeActiveConnections?: boolean): Promise<void>;
  /**
   * The events of this app, when `events` is set: start and stop delivery, drain
   * what is due, and see or retry what is parked. `brick dev` and `brick start`
   * start it for you.
   */
  readonly events?: EventsHub;
  /** Register a raw endpoint (a plain route, not an action). */
  endpoint(def: EndpointDefinition): void;
  /**
   * The OpenAPI documents behind the dashboard's APIs view: this app's own
   * unless `docs` is false, then those from `reference.documents`.
   */
  referenceDocuments(): Promise<ApiDocument[]>;
  /** This app's OpenAPI document, as `/openapi.json` serves it (also when `docs` is false). */
  openApiDocument(): Record<string, any>;
  /** All endpoints registered via `endpoint()` (declaration order). */
  listEndpoints(): EndpointDefinition[];
};
