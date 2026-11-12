import { ATTR, SPAN } from "./telemetry-names";
import type { HttpMethod } from "./http";
import { Elysia } from "elysia";
import {
  compileBrickApplication,
  type CompiledApplication,
  type RouteIR,
} from "./compiler";
import { DuplicateNameError, type Service } from "./types";
import { getGlobalRegistry } from "./registry";
import { getPluginEndpoints, installedPlugins } from "./plugin";
import { pluginLifecycle, setupAppPlugins } from "./plugin-app";
import type { PluginInstance } from "./define-plugin";
import { OPENAPI_DEFAULTS, generateOpenApiSpec } from "./openapi";
import { resolveSecrets, type SecretSource } from "./secrets";
import {
  requestLoggingPlugin,
  type RequestLoggingOptions,
} from "./request-logger";
import {
  scalarDocsHTML,
  swaggerDocsHTML,
  type ApiDocument,
  type DocumentationOptions,
  type OpenApiDocument,
  type ReferenceOptions,
} from "./docs";
import { normalizeDashboard, type DashboardOptions } from "./dashboard";
import {
  createEndpointHandler,
  endpointPaths,
  type BrickApp,
  type EndpointDefinition,
} from "./endpoints";
import { instrumentDatabase, traceHttpRequest, withSpan } from "./telemetry";
import { EventsHub } from "./events/hub";
import { bindDeps } from "./deps";
import { WEBHOOK_ROUTE } from "./events/workflows";
import type { EventsOptions } from "./events/types";
import { localBroker, mountSockets, socketPath } from "./socket";
import { DEFAULT_PREFIX, routeKey } from "./routes";
import type { SocketBroker } from "./socket-types";
import { corsHook, type CorsOptions } from "./cors";
import { bodyLimitParser } from "./compiler/runtime";

export interface CreateServerOptions {
  port?: number;
  /** Run the plugins' preparations (such as CRUD's prepared queries) at startup (default true). */
  compiler?: boolean;
  /** Ahead-of-time handlers already bound to the supplied services. */
  compilation?: CompiledApplication;
  services?: Service<any, any>[];
  prefix?: string;
  title?: string;
  version?: string;
  description?: string;
  docs?: boolean;
  openApiPath?: string;
  docsPath?: string;
  swaggerPath?: string;
  requestLogging?: boolean | RequestLoggingOptions; // default true
  /**
   * `true` serves a Scalar page at /reference. Options serve one only with a
   * `path`; `documents` adds OpenAPI documents to the dashboard's APIs view.
   */
  reference?: boolean | ReferenceOptions; // default false
  secrets?: { source?: SecretSource; validate?: boolean };
  /** Raw endpoints (plain routes, not actions), mounted at startup. */
  endpoints?: EndpointDefinition[];
  /**
   * Record request, action, and RPC spans with OpenTelemetry (default false).
   * Spans go to the globally registered tracer provider; without one they are
   * no-ops. `brick dev` shows them in its dashboard.
   */
  telemetry?: boolean;
  /**
   * Developer documentation for the `brick dev` dashboard (its Docs tab): a
   * folder of `.md`/`.mdx` pages in Fumadocs' layout, with frontmatter and
   * `meta.json` for ordering. A string is the folder. Relative paths start at
   * the folder of the app entry, as they read in the file that sets them (from
   * `src/app.ts`, `"../docs"` is `docs/` at the project root). Needs
   * `fumadocs-core` and `@mdx-js/mdx` installed.
   */
  documentation?: string | DocumentationOptions;
  /**
   * Monitoring dashboard for `brick start`, on a port of its own and behind
   * `auth`. Setting it turns on `telemetry`. See `DashboardOptions`.
   */
  dashboard?: DashboardOptions;
  /**
   * Record events in the same database transaction as the writes that cause them,
   * and deliver them to listeners after the commit. Generated CRUD writes emit
   * `<resource>.create`, `<resource>.update` and `<resource>.delete`. A service
   * records events once its database holds an `outboxTable()`. Reads emit nothing,
   * and an app without this option behaves exactly as before. See `EventsOptions`.
   */
  events?: EventsOptions;
  /**
   * Socket fan-out. `broker` carries emits and kicks between processes
   * (default: this process only). See `redisBroker`. The app closes it on stop.
   * `secret` signs replay sequences; give every process the same one so a
   * client can resume on any of them (default: random per process).
   */
  sockets?: { broker?: SocketBroker; secret?: string };
  /**
   * The values of the services' declared `deps` (`port<T>()`), by name. Every
   * declared dep must be provided, and every provided one declared. Actions read
   * them as `ctx.deps`, listeners and workflow steps with `useDeps()`.
   */
  deps?: Record<string, unknown>;
  /**
   * App-wide plugins from `definePlugin`, in install order: their `app` part
   * adds start/stop lifecycle, middleware and listeners. Plugins installed with
   * `service.use()` or `resource.use()` take part too, before these.
   */
  plugins?: readonly PluginInstance<any, any>[];
  /**
   * CORS for browser callers on other origins. `true` allows the app's own
   * origin; a string, list or predicate names the allowed origins, compared
   * exactly. `{ origin, credentials }` adds `credentials: true` for cookies.
   * Other origins get no `Access-Control-Allow-Origin`. Preflights are answered.
   */
  cors?: false | CorsOptions;
}

/**
 * Create the HTTP application: an Elysia app that serves every service's
 * actions (and the tools that opt in with `http: true`) as routes, with
 * `/_health`, an OpenAPI document at `/openapi.json`, Scalar at `/docs`,
 * Swagger UI at `/swagger`, and the shape of the services at `/_brick/services`.
 *
 * Services come from the global registry unless `services` is given. The app
 * does not listen by itself: export it from your entry file, where `brick dev`,
 * `brick start`, and the Vite plugin load it, or call `app.listen(port)` in your
 * own server bootstrap.
 *
 * @param options - `prefix` for action routes (default `/api`), `services`,
 * `title`, `version`, and `description` for the OpenAPI document, `docs` and the
 * paths of its pages, `requestLogging`, `reference`, `endpoints`, `secrets`,
 * `telemetry`, `documentation`, `dashboard`, and `deps`. See `CreateServerOptions`.
 * @returns The app, with `definition` (its services, prefix, and routes),
 * `endpoint()` to add raw routes, and `listEndpoints()` to list them.
 * @throws When a required secret is missing, `documentation` or `dashboard`
 * is invalid, or `deps` misses a dep a service declares or has one none declares.
 * @example
 * import { brick } from "@brickkit/core";
 * import { pagesService } from "./services/pages";
 *
 * export default brick({
 *   services: [pagesService],
 *   title: "Pages API",
 *   telemetry: true,
 * });
 */
export function brick(options: CreateServerOptions = {}): BrickApp {
  const prefix =
    options.prefix ?? options.compilation?.ir.prefix ?? DEFAULT_PREFIX;
  const title = options.title ?? OPENAPI_DEFAULTS.title;
  const version = options.version ?? OPENAPI_DEFAULTS.version;
  const enableDocs = options.docs ?? true;
  const openApiPath = options.openApiPath ?? OPENAPI_DEFAULTS.path;
  const docsPath = options.docsPath ?? "/docs";
  const swaggerPath = options.swaggerPath ?? "/swagger";
  const dashboard = normalizeDashboard(options.dashboard);
  // The dashboard shows what is traced, so having one means tracing.
  const telemetry = options.telemetry === true || dashboard !== undefined;

  const app = new Elysia();

  // Fail fast on missing required secrets before serving anything.
  // No-op when no secrets are registered.
  if (options.secrets?.validate !== false) {
    resolveSecrets({ source: options.secrets?.source });
  }

  const services = options.services ?? getGlobalRegistry().list();
  const plugins = setupAppPlugins(
    services.flatMap((service) => installedPlugins(service)),
    options.plugins ?? [],
  );
  // CORS first, so preflights are answered and its headers reach responses
  // from middleware, which skips the later lifecycle hooks.
  if (options.cors) app.onRequest(corsHook(options.cors));
  for (const handler of plugins.middleware) app.onRequest(handler);

  // Mounted and registered in one call, so actions and sockets can't shadow them.
  const registeredRoutes = new Map<string, boolean>();
  const builtIn = (path: string, handler: any) => {
    app.get(path, handler);
    registeredRoutes.set(routeKey("GET", path), false);
  };

  builtIn("/_health", () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
  }));

  // Request logging first so every route below is timed.
  const requestLogging = options.requestLogging ?? true;
  if (requestLogging !== false)
    app.use(
      requestLoggingPlugin(requestLogging === true ? {} : requestLogging),
    );

  // Scalar API reference page (opt-in): `reference: true`, or options with a path.
  const reference = options.reference ?? false;
  const referenceOptions: ReferenceOptions =
    typeof reference === "object" ? reference : {};
  const referencePath =
    reference === true ? "/reference" : referenceOptions.path;
  if (referencePath !== undefined) {
    builtIn(
      referencePath,
      htmlResponse(
        scalarDocsHTML(
          referenceOptions.specUrl ?? openApiPath,
          referenceOptions.title ?? title,
        ),
      ),
    );
  }

  const byName = new Map<string, unknown>();
  for (const service of services) {
    if ((byName.get(service.name) ?? service) !== service)
      throw new DuplicateNameError(
        `Brick: duplicate service "${service.name}" in brick()`,
      );
    byName.set(service.name, service);
  }
  bindDeps(services, options.deps);
  const eventsOptions = plugins.listeners.length
    ? {
        ...options.events,
        listeners: [...(options.events?.listeners ?? []), ...plugins.listeners],
      }
    : options.events;
  const events = eventsOptions
    ? new EventsHub(eventsOptions, options.deps).attach(services)
    : undefined;
  if (events?.workflows)
    app.all(WEBHOOK_ROUTE, ({ request }) => events.webhook(request));
  if (telemetry) {
    for (const service of services) instrumentDatabase(service.getDb());
  }

  // Close declarations before anything reads them.
  for (const service of services) service.build();

  const endpointDefs: EndpointDefinition[] = [];
  let endpointRevision = 0;

  const buildSpec = () => {
    const spec = generateOpenApiSpec({
      title,
      version,
      description: options.description,
      prefix,
      services,
    });
    const paths = { ...spec.paths };
    for (const [path, operations] of Object.entries(
      endpointPaths(endpointDefs),
    ))
      paths[path] = { ...paths[path], ...operations };
    return { ...spec, paths };
  };

  if (enableDocs) {
    builtIn(
      openApiPath,
      cachedJsonRoute(
        buildSpec,
        () =>
          [
            getGlobalRegistry(),
            getGlobalRegistry().revision + endpointRevision,
          ] as const,
      ),
    );
    builtIn(docsPath, htmlResponse(scalarDocsHTML(openApiPath, title)));
    builtIn(swaggerPath, htmlResponse(swaggerDocsHTML(openApiPath, title)));
  }
  // Built from `definition`, below.
  builtIn("/_brick/services", (context: any) => architecture(context));

  const sockets = services.flatMap((service) =>
    service.listSockets().map((definition) => ({
      service: service.name,
      path: socketPath(prefix, service.name, definition),
      definition,
    })),
  );
  const socketRoutes = new Set<string>();
  for (const socket of sockets) {
    const key = routeKey("GET", socket.path);
    if (registeredRoutes.has(key) || socketRoutes.has(key))
      throw new DuplicateNameError(
        `Brick: duplicate socket route '${socket.path}'`,
      );
    socketRoutes.add(key);
  }
  const mountRoute = (
    method: HttpMethod,
    path: string,
    handler: any,
    plugin = false,
    hook?: object,
  ) => {
    const key = routeKey(method, path);
    if (socketRoutes.has(key))
      throw new DuplicateNameError(
        `Brick: route '${method} ${path}' conflicts with a socket`,
      );
    if (registeredRoutes.has(key)) {
      if (plugin || registeredRoutes.get(key))
        throw new DuplicateNameError(
          `Brick: duplicate plugin route '${method} ${path}'`,
        );
      return false;
    }
    if (hook) app.route(method, path, hook, handler);
    else app.route(method, path, handler);
    registeredRoutes.set(key, plugin);
    return true;
  };

  const mountEndpoint = (def: EndpointDefinition, plugin = false) => {
    const handler = createEndpointHandler(def, services);
    mountRoute(
      def.method,
      def.path,
      telemetry
        ? (context: any) =>
            traceHttpRequest(context, def.method, def.path, () =>
              handler(context),
            )
        : handler,
      plugin,
    );
    endpointDefs.push(def);
    endpointRevision++;
  };

  for (const service of services) {
    for (const def of getPluginEndpoints(service, prefix))
      mountEndpoint(def, true);
  }

  for (const def of options.endpoints ?? []) {
    mountEndpoint(def);
  }

  const brickApp = app as unknown as BrickApp;
  brickApp.endpoint = (def: EndpointDefinition) => {
    mountEndpoint(def);
  };
  brickApp.listEndpoints = () => [...endpointDefs];
  brickApp.openApiDocument = buildSpec;
  brickApp.referenceDocuments = async () => {
    const documents: ApiDocument[] = enableDocs
      ? [{ title, document: buildSpec() as unknown as OpenApiDocument }]
      : [];
    for (const extra of referenceOptions.documents ?? []) {
      try {
        const document =
          typeof extra.document === "function"
            ? await extra.document()
            : extra.document;
        documents.push({ title: extra.title, document });
      } catch (error) {
        console.warn(
          `[Brick-TS] Skipping the "${extra.title}" API document: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return documents;
  };

  const compilation =
    options.compilation ??
    compileBrickApplication({
      services,
      prefix,
      mode: options.compiler === false ? "generic" : "specialized",
    });
  if (
    compilation.ir.prefix !== prefix ||
    JSON.stringify(compilation.ir.services) !==
      JSON.stringify(services.map((service) => service.name))
  ) {
    throw new Error(
      "Brick compiler: server services/prefix differ from the bound compilation",
    );
  }
  const mountedRoutes: RouteIR[] = [];
  for (const route of compilation.routes) {
    const invoke = (context: any) => {
      const result = telemetry
        ? withSpan(
            `${SPAN.actionPrefix}${route.ir.service}.${route.ir.action}`,
            {
              [ATTR.service]: route.ir.service,
              [ATTR.action]: route.ir.action,
            },
            () => route.handler(context),
          )
        : route.handler(context);
      return result &&
        typeof (result as PromiseLike<unknown>).then === "function"
        ? Promise.resolve(result).then(jsonActionResult)
        : jsonActionResult(result);
    };
    const mounted = mountRoute(
      route.ir.method,
      route.ir.path,
      telemetry
        ? (context: any) =>
            traceHttpRequest(context, route.ir.method, route.ir.path, () =>
              invoke(context),
            )
        : invoke,
      Boolean(route.ir.plugin),
      route.ir.bodyLimit
        ? { parse: bodyLimitParser(route.ir.bodyLimit) }
        : undefined,
    );
    if (mounted) mountedRoutes.push(route.ir);
  }

  mountSockets(
    app,
    sockets,
    options.sockets?.broker ?? localBroker(),
    options.sockets?.secret,
  );
  const definition = Object.freeze({
    services: Object.freeze([...services]),
    prefix,
    routes: Object.freeze(mountedRoutes),
    sockets: Object.freeze(
      sockets.map(({ service, path, definition }) => ({
        ...definition.schema,
        service,
        path,
      })),
    ),
    telemetry,
    documentation: normalizeDocumentation(options.documentation),
    dashboard,
    ...(events ? { events: events.describe() } : {}),
    plugins: Object.freeze(plugins.plugins),
  });
  Object.defineProperty(brickApp, "definition", { value: definition });
  Object.defineProperty(brickApp, "events", { value: events });
  // Plugin lifecycle: start before serving, stop after the server stops.
  const lifecycle = pluginLifecycle(plugins.lifecycles);
  const listen = app.listen.bind(app);
  const stop = app.stop.bind(app);
  Object.defineProperty(brickApp, "start", { value: lifecycle.start });
  // One rule with serve(): an app whose plugins fail to start does not serve.
  // listen() is synchronous, so it stops the server it already opened.
  brickApp.listen = ((...args: Parameters<typeof listen>) => {
    lifecycle.start().catch((error) => {
      console.error("[Brick-TS] A plugin failed to start:", error);
      return stop(true);
    });
    return listen(...args);
  }) as typeof brickApp.listen;
  brickApp.stop = (async (closeActiveConnections?: boolean) => {
    try {
      await stop(closeActiveConnections);
    } finally {
      await lifecycle.stop();
    }
  }) as typeof brickApp.stop;
  Object.defineProperty(brickApp, "serve", {
    value: async ({ port }: { port: number }) => {
      await lifecycle.start();
      listen(port);
      events?.start();
      return brickApp;
    },
  });
  Object.defineProperty(brickApp, "shutdown", {
    value: async (closeActiveConnections?: boolean) => {
      await events?.stop();
      await brickApp.stop(closeActiveConnections);
    },
  });

  // Serialize stable metadata once; registry changes invalidate the snapshot.
  const architecture = cachedJsonRoute(
    () => getGlobalRegistry().exportArchitecture(definition),
    () => {
      const registry = getGlobalRegistry();
      return [registry, registry.revision] as const;
    },
  );

  return brickApp;
}

function normalizeDocumentation(
  documentation: string | DocumentationOptions | undefined,
): DocumentationOptions | undefined {
  if (documentation === undefined) return undefined;
  const options =
    typeof documentation === "string" ? { dir: documentation } : documentation;
  if (typeof options.dir !== "string" || options.dir === "")
    throw new Error("Brick: documentation needs a folder, such as './docs'.");
  return Object.freeze({
    dir: options.dir,
    ...(options.components ? { components: options.components } : {}),
  });
}

function jsonActionResult(value: unknown): unknown {
  return value === null
    ? new Response("null", { headers: { "content-type": "application/json" } })
    : value;
}

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/** Reuse serialized JSON, without sharing a mutable response body between requests. */
function cachedJsonRoute(
  build: () => unknown,
  revision: () => readonly [unknown, number],
) {
  let [owner, version] = revision();
  let json = JSON.stringify(build());
  return ({ set }: { set: { headers: Record<string, unknown> } }) => {
    const [currentOwner, currentVersion] = revision();
    if (currentOwner !== owner || currentVersion !== version) {
      json = JSON.stringify(build());
      owner = currentOwner;
      version = currentVersion;
    }
    set.headers["content-type"] = "application/json;charset=utf-8";
    return json;
  };
}
