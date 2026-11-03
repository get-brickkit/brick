import { Elysia } from "elysia";
import {
  compileBrickApplication,
  type CompiledApplication,
  type RouteIR,
} from "./compiler";
import type { Service } from "./types";
import { getGlobalRegistry } from "./registry";
import {
  getPluginActionRoute,
  getPluginEndpoints,
  installedPlugins,
} from "./plugin";
import {
  pluginLifecycle,
  setupAppPlugins,
  type PluginInstance,
} from "./define-plugin";
import { getActionRoute } from "./routes";
import { generateOpenApiSpec } from "./openapi";
import { resolveSecrets, type SecretSource } from "./secrets";
import {
  requestLoggingPlugin,
  type RequestLoggingOptions,
} from "./request-logger";
import {
  scalarDocsHTML,
  swaggerDocsHTML,
  registerReferenceRoute,
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
import {
  legacySocketPath,
  localBroker,
  mountSockets,
  socketPath,
} from "./socket";
import type { SocketBroker } from "./socket-types";
import type { AuthOptions } from "./access";
import { createMcpRegistry, createMcpRoute, type McpOptions } from "./mcp";

export interface CreateServerOptions {
  port?: number;
  /** Generate specialized handlers once at startup (default true). */
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
  /** Raw endpoints (outside the JSON action mesh), mounted at startup. */
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
   * Also serve the v0.10 paths (CRUD at `${prefix}/${resource}/...`, service
   * actions and sockets at `${prefix}/${service}/${name}` as declared, and
   * explicit paths that still start with the prefix) with the same handlers.
   * Their responses carry `Deprecation: true` and a `Link` to the new path, and
   * their spans `brick.legacy_route`. OpenAPI and the client describe only the
   * new paths. Removed in v0.12.
   */
  legacyRoutes?: boolean;
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
   * App-level authentication for any provider. `resolve` turns a request into
   * the principal actions read as `ctx.user` (HTTP actions, socket handshakes
   * and MCP requests); `handler` serves the provider's own routes. See `AuthOptions`.
   */
  auth?: AuthOptions;
  /**
   * Serve every tool (`service.tool()`) over MCP (streamable HTTP, stateless
   * JSON) at `path` (default `/mcp`). `authorize` gates each request. See `McpOptions`.
   */
  mcp?: boolean | McpOptions;
}

export {
  compileRoutePlan,
  executeCompiledRoute,
  createActionHandler,
} from "./action-handler";

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
  const prefix = options.prefix ?? options.compilation?.ir.prefix ?? "/api";
  const title = options.title ?? "Brick-TS API Mesh";
  const version = options.version ?? "1.0.0";
  const compiled = options.compiler !== false;
  const enableDocs = options.docs ?? true;
  const openApiPath = options.openApiPath ?? "/openapi.json";
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
  for (const handler of plugins.middleware) app.request(handler);

  // App-level auth: the provider's routes first, then the principal per request.
  const authHandler = options.auth?.handler;
  if (authHandler) app.request(({ request }) => authHandler(request));
  const resolveUser = options.auth?.resolve;

  // Diagnostics & health
  app.get("/_health", () => ({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
  }));

  // Request logging first so every route below is timed.
  const requestLogging = options.requestLogging ?? true;
  if (requestLogging !== false) {
    const pluginOpts = requestLogging === true ? {} : requestLogging;
    if (pluginOpts.enabled !== false) {
      app.use(requestLoggingPlugin(pluginOpts));
    }
  }

  // Scalar API reference page (opt-in): `reference: true`, or options with a path.
  const reference = options.reference ?? false;
  const referenceOptions: ReferenceOptions =
    typeof reference === "object" ? reference : {};
  const referencePath =
    reference === true ? "/reference" : referenceOptions.path;
  if (referencePath !== undefined) {
    const settings = {
      path: referencePath,
      title: referenceOptions.title ?? title,
      specUrl: referenceOptions.specUrl ?? openApiPath,
    };
    if (compiled)
      app.get(
        settings.path,
        htmlResponse(scalarDocsHTML(settings.specUrl, settings.title)),
      );
    else registerReferenceRoute(app, settings);
  }

  const byName = new Map<string, unknown>();
  for (const service of services) {
    if ((byName.get(service.name) ?? service) !== service)
      throw new Error(`Brick: duplicate service "${service.name}" in brick()`);
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

  // Precompute plans and freeze immutable plans across all services
  for (const service of services) {
    if (typeof (service as any).build === "function") {
      (service as any).build();
    }
  }

  // Raw endpoints declared via options or app.endpoint() (declaration order).
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

  // OpenAPI 3.1 & Interactive Documentation Endpoints
  if (enableDocs) {
    app.get(
      openApiPath,
      compiled
        ? cachedJsonRoute(
            buildSpec,
            () =>
              [
                getGlobalRegistry(),
                getGlobalRegistry().revision + endpointRevision,
              ] as const,
          )
        : buildSpec,
    );

    if (compiled) {
      app.get(docsPath, htmlResponse(scalarDocsHTML(openApiPath, title)));
      app.get(swaggerPath, htmlResponse(swaggerDocsHTML(openApiPath, title)));
    } else {
      app.get(docsPath, ({ set }) => {
        set.headers["content-type"] = "text/html; charset=utf-8";
        return scalarDocsHTML(openApiPath, title);
      });

      app.get(swaggerPath, ({ set }) => {
        set.headers["content-type"] = "text/html; charset=utf-8";
        return swaggerDocsHTML(openApiPath, title);
      });
    }
  }

  // Dedicated Route Registry
  const registeredRoutes = new Map<string, boolean>();
  const routeKey = (method: string, path: string) =>
    `${method} ${path.replace(/:[^/]+/g, ":param")}`;
  registeredRoutes.set(routeKey("GET", "/_health"), false);
  registeredRoutes.set(routeKey("GET", "/_brick/services"), false);
  if (enableDocs) {
    for (const path of [openApiPath, docsPath, swaggerPath])
      registeredRoutes.set(routeKey("GET", path), false);
  }
  if (referencePath !== undefined)
    registeredRoutes.set(routeKey("GET", referencePath), false);

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
      throw new Error(`Brick: duplicate socket route '${socket.path}'`);
    socketRoutes.add(key);
  }
  // v0.10 socket routes, where they are free; the upgrade carries no headers.
  const legacySockets = options.legacyRoutes
    ? services.flatMap((service) =>
        service.listSockets().flatMap((definition) => {
          const path = legacySocketPath(prefix, service.name, definition);
          if (path === undefined) return [];
          const key = routeKey("GET", path);
          if (registeredRoutes.has(key) || socketRoutes.has(key)) return [];
          socketRoutes.add(key);
          return [{ service: service.name, path, definition }];
        }),
      )
    : [];

  // v0.10 paths, mounted after every current route so they never take one.
  const legacyRoutes: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    successor: string;
    handler: (context: any) => unknown;
  }[] = [];
  const addLegacy = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string | undefined,
    successor: string,
    handler: (context: any) => unknown,
  ) => {
    if (options.legacyRoutes && path !== undefined && path !== successor)
      legacyRoutes.push({ method, path, successor, handler });
  };

  const mountRoute = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    handler: any,
    plugin = false,
  ) => {
    const key = routeKey(method, path);
    if (socketRoutes.has(key))
      throw new Error(
        `Brick: route '${method} ${path}' conflicts with a socket`,
      );
    if (registeredRoutes.has(key)) {
      if (plugin || registeredRoutes.get(key))
        throw new Error(`Brick: duplicate plugin route '${method} ${path}'`);
      return false;
    }
    switch (method) {
      case "GET":
        app.get(path, handler);
        break;
      case "POST":
        app.post(path, handler);
        break;
      case "PUT":
        app.put(path, handler);
        break;
      case "PATCH":
        app.patch(path, handler);
        break;
      case "DELETE":
        app.delete(path, handler);
        break;
    }
    registeredRoutes.set(key, plugin);
    return true;
  };

  // Raw endpoints (outside the JSON action mesh).
  const mountEndpoint = (
    def: EndpointDefinition,
    plugin = false,
    legacyPath?: string,
  ) => {
    const handler = createEndpointHandler(def, services);
    addLegacy(def.method, legacyPath, def.path, handler);
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
      mountEndpoint(def, true, def.legacyPath);
  }

  for (const def of options.endpoints ?? []) {
    mountEndpoint(def);
  }

  const brickApp = app as unknown as BrickApp;
  brickApp.endpoint = (def: EndpointDefinition) => {
    mountEndpoint(def);
  };
  brickApp.listEndpoints = () => [...endpointDefs];
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
    const service = services.find(
      (candidate) => candidate.name === route.ir.service,
    )!;
    const action = service
      .listActions()
      .find((candidate) => candidate.name === route.ir.action)!;
    // The handler reads the principal off the route context as `ctx.user`.
    const handle = resolveUser
      ? async (context: any) => {
          context.user = await resolveUser(context.request);
          return route.handler(context);
        }
      : route.handler;
    const invoke = (context: any) => {
      const result = telemetry
        ? withSpan(
            `action ${route.ir.service}.${route.ir.action}`,
            {
              "brick.service": route.ir.service,
              "brick.action": route.ir.action,
            },
            () => handle(context),
          )
        : handle(context);
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
      getPluginActionRoute(action, prefix) !== undefined,
    );
    if (mounted) {
      mountedRoutes.push(route.ir);
      const current = getActionRoute(action, prefix);
      if (current)
        addLegacy(route.ir.method, current.legacyPath, route.ir.path, invoke);
    }
  }

  for (const legacy of legacyRoutes) {
    const key = routeKey(legacy.method, legacy.path);
    // A current route or socket owns the path: the old one is not served.
    if (registeredRoutes.has(key) || socketRoutes.has(key)) continue;
    const handle = (context: any) => {
      context.set.headers["deprecation"] = "true";
      context.set.headers["link"] = `<${legacy.successor.replace(
        /:([^/]+)/g,
        (match, name: string) =>
          context.params?.[name] === undefined
            ? match
            : encodeURIComponent(context.params[name]),
      )}>; rel="successor-version"`;
      return legacy.handler(context);
    };
    mountRoute(
      legacy.method,
      legacy.path,
      telemetry
        ? (context: any) =>
            traceHttpRequest(
              context,
              legacy.method,
              legacy.path,
              () => handle(context),
              { "brick.legacy_route": true },
            )
        : handle,
    );
  }

  // MCP: every registered tool, behind auth.resolve and mcp.authorize.
  if (options.mcp) {
    const mcp = options.mcp === true ? {} : options.mcp;
    const mcpPath = mcp.path ?? "/mcp";
    const serve = createMcpRoute({
      ...mcp,
      registry: createMcpRegistry({ services }),
      serverInfo: { name: title, version },
      resolveUser,
    });
    for (const method of ["POST", "GET"] as const)
      mountRoute(
        method,
        mcpPath,
        // Named fields only: Elysia then leaves the body for the handler to read.
        telemetry
          ? ({ request, headers, set }: any) =>
              traceHttpRequest({ request, headers, set }, method, mcpPath, () =>
                serve(request),
              )
          : ({ request }: { request: Request }) => serve(request),
        true, // a clash with another route throws
      );
  }

  mountSockets(
    app,
    [...sockets, ...legacySockets],
    options.sockets?.broker ?? localBroker(),
    options.sockets?.secret,
    resolveUser,
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
  brickApp.listen = ((...args: Parameters<typeof listen>) => {
    lifecycle
      .start()
      .catch((error) =>
        console.error("[Brick-TS] A plugin failed to start:", error),
      );
    return listen(...args);
  }) as typeof brickApp.listen;
  brickApp.stop = (async (closeActiveConnections?: boolean) => {
    try {
      await stop(closeActiveConnections);
    } finally {
      await lifecycle.stop();
    }
  }) as typeof brickApp.stop;
  getGlobalRegistry().setApplicationRoutes(definition);

  // Serialize stable metadata once; registry changes invalidate the snapshot.
  app.get(
    "/_brick/services",
    compiled
      ? cachedJsonRoute(
          () => getGlobalRegistry().exportArchitecture(definition),
          () => {
            const registry = getGlobalRegistry();
            return [registry, registry.revision] as const;
          },
        )
      : () => getGlobalRegistry().exportArchitecture(definition),
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
