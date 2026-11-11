import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ConfigError } from "./config";
import type { DevDocs } from "./dev-docs";
import type { DevHistory } from "./dev-history";
import { decodeHistoryQuery, type HistoryQuery } from "./dashboard-query";
import type { DevTelemetryStore } from "./dev-telemetry-store";
import { dashboardShell } from "./dev-dashboard-shell";
import type { DashboardAuth } from "@brickkit/core";
import {
  createAccess,
  isLoopbackHost,
  requestProtocol,
} from "./dashboard-access";
import {
  ASSETS,
  CSRF_HEADER,
  CSRF_VALUE,
  DOCS_PATHS,
  INSPECTOR_TOKEN_HEADER,
  matchRoute,
  ROUTES,
  type DashboardEvents,
  type DashboardSnapshot,
  type HistoryResponses,
  type IngestPayload,
  type RouteName,
} from "./dashboard-protocol";
import {
  assetsDirectory,
  DashboardExtensions,
  type PluginDashboard,
  themeCss,
  type DashboardExtensionOptions,
} from "./dashboard-extension";

const KEEPALIVE_MS = 15_000;
const MAX_INGEST_BYTES = 5 * 1024 * 1024;
const MAX_PROXY_BYTES = 10 * 1024 * 1024;
// Request headers that describe one hop or the dashboard's own page, and
// response headers that fetch has already applied or that mean nothing here.
const NOT_FORWARDED = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "content-length",
  "accept-encoding",
  "origin",
  "referer",
  "cookie",
]);
const NOT_RETURNED = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "set-cookie",
]);

const PRODUCTION_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  // Requests and logs are private: nothing caches them on the way.
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** How long `/_health` waits for the app before calling it down. */
const PROBE_TIMEOUT_MS = 3000;

export interface DevDashboardOptions {
  port: number;
  /**
   * The address to listen on; loopback by default. Any other address needs
   * `auth`, and the server refuses to start without it.
   */
  host?: string;
  /**
   * `"production"` is the read-only monitoring dashboard of `brick start`: it
   * serves only the routes marked `production`, with security headers, and
   * tells its page to hide the tabs that need a developer's machine.
   */
  mode?: "dev" | "production";
  /** Who may use the dashboard, checked before anything but `/_health`. */
  auth?: DashboardAuth;
  /** Whether the app answers; `/_health` reports it, for uptime monitors. */
  probe?: () => Promise<boolean>;
  store: DevTelemetryStore;
  /** Requests kept on disk; omit to serve live data only. The page hides its History view. */
  history?: DevHistory;
  /** The app's developer documentation, when it has any, as of this request. */
  docs?: () => DevDocs | undefined;
  /** Omit when the host cannot restart the application; the page hides its button. */
  restart?: () => void;
  /**
   * The project's extension and theme. In dev mode the extension is rebuilt as
   * its folder changes, and the page reloads; production serves it as built.
   */
  dashboard?: DashboardExtensionOptions;
  /**
   * The app's plugins, whose extensions are built and served before the
   * dashboard listens. Dev learns them later, with `setPluginExtensions`.
   */
  plugins?: readonly PluginDashboard[];
  /** Where `/app/*` goes; the app the store's API documents name otherwise. */
  appUrl?: string;
  /** How the host's user picks another port, added when the port is taken. */
  portHint?: string;
}

export interface DevDashboard {
  readonly port: number;
  /** Build and serve the dashboard extensions the app's plugins ship. */
  setPluginExtensions(plugins: readonly PluginDashboard[]): Promise<void>;
  stop(): void;
}

/**
 * Serve the dashboard, on loopback unless told otherwise. On loopback requests
 * must name a local host (blocks DNS rebinding), and restart requires a header
 * that cross-origin pages cannot send without a preflight. Elsewhere `auth` is
 * required and decides who gets in. Uses node:http, so it runs under Bun and
 * under Node (Vite's dev server runs under Node).
 */
export function startDevDashboard(
  options: DevDashboardOptions,
): Promise<DevDashboard> {
  const host = options.host ?? "127.0.0.1";
  const loopback = isLoopbackHost(host);
  const production = options.mode === "production";
  if (!loopback && !options.auth) {
    return Promise.reject(
      new ConfigError(
        `Brick: the dashboard would listen on ${host}, where others can reach it, so it needs access control. Set dashboard.auth with a token or an authorize function.`,
      ),
    );
  }
  let theme: string;
  try {
    theme = themeCss(options.dashboard?.theme);
  } catch (error) {
    return Promise.reject(error);
  }
  // In dev, plugins' extensions can join later (`setPluginExtensions`).
  const extension =
    options.dashboard?.extension ||
    !production ||
    options.plugins?.some((plugin) => plugin.dashboard)
      ? new DashboardExtensions(options.dashboard?.extension, (message) =>
          console.warn(message),
        )
      : undefined;
  const access = options.auth
    ? createAccess(options.auth, (error) =>
        console.error("[Brick-TS] The dashboard sign-in check failed:", error),
      )
    : undefined;
  let allowedHosts = new Set<string>();
  const server = createServer((request, response) => {
    respond(request, response).catch((error: unknown) => {
      console.error("[Brick-TS] The dashboard failed to answer:", error);
      if (response.headersSent) response.end();
      else send(response, 500, "Server error");
    });
  });

  async function respond(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (production)
      for (const [name, value] of Object.entries(PRODUCTION_HEADERS))
        response.setHeader(name, value);
    if (loopback && !allowedHosts.has(request.headers.host ?? "")) {
      send(response, 403, "Forbidden");
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = matchRoute(request.method, url.pathname);
    if (route === "health") {
      await health(response);
      return;
    }
    if (access) {
      const decision = await access(request);
      if (!decision.allowed) {
        send(response, decision.status, decision.body, decision.headers);
        return;
      }
    }
    if (!route || (production && !servedInProduction(route))) {
      send(response, 404, "Not found");
      return;
    }
    if (
      "csrf" in ROUTES[route] &&
      request.headers[CSRF_HEADER] !== CSRF_VALUE
    ) {
      send(response, 403, "Forbidden");
      return;
    }
    await handlers[route](request, response, url);
  }

  function servedInProduction(route: RouteName): boolean {
    const served: boolean | "extension" = ROUTES[route].production;
    return served === "extension" ? Boolean(extension?.active) : served;
  }

  /** 200 while the app answers its own health check, 503 when it does not. */
  async function health(response: ServerResponse): Promise<void> {
    const probe = options.probe;
    let up = true;
    if (probe) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      up = await Promise.race([
        probe().catch(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    send(
      response,
      up ? 200 : 503,
      JSON.stringify({
        status: up ? "ok" : "degraded",
        ...(probe ? { app: up ? "up" : "down" } : {}),
      }),
      { "content-type": "application/json", "cache-control": "no-store" },
    );
  }

  type Handler = (
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ) => void | Promise<void>;

  const handlers: Record<Exclude<RouteName, "health">, Handler> = {
    shell: (_request, response) =>
      send(
        response,
        200,
        dashboardShell({
          extension: extension?.active
            ? {
                revision: extension.revision,
                js: Boolean(extension.built),
                css: Boolean(extension.built?.css),
              }
            : undefined,
          theme: theme !== "",
          mode: production ? "production" : "dev",
        }),
        {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      ),
    assets(_request, response, url) {
      const name = url.pathname.slice(ROUTES.assets.path.length + 1);
      // The project's own files, kept in memory beside the dashboard's.
      const own = name === ASSETS.theme ? theme : extension?.asset(name);
      if (own !== undefined)
        send(response, 200, own, {
          "content-type": assetType(name),
          "cache-control": "no-store",
        });
      else serveAsset(response, name);
    },
    app,
    state: (_request, response) => json(response, snapshot()),
    events: eventStream,
    history(_request, response, url) {
      if (options.history)
        history(options.history, url.pathname, url.searchParams, response);
      else send(response, 404, "Not found");
    },
    docs: (_request, response, url) =>
      docsRoute(response, url.pathname, url.searchParams),
    openapi: (_request, response) =>
      json(response, options.store.apiDocuments()),
    proxy,
    workflows(request, response, url) {
      // Only the dashboard may frame it: framed by another site, a click could
      // land on Cancel or Replay. The rest of the dashboard may be embedded.
      frameOnlyHere(response);
      return inspector(request, response, url);
    },
    schedules: (request, response, url) => inspector(request, response, url),
    ingest,
    restart(request, response) {
      if (!options.restart) {
        send(response, 404, "Not found");
        return;
      }
      options.restart();
      send(response, 202, "");
    },
  };

  function snapshot(): DashboardSnapshot {
    return {
      ...options.store.snapshot(),
      canRestart: Boolean(options.restart),
      historyDays: options.history?.days ?? 0,
      mode: production ? "production" : "dev",
      extension: extension?.active
        ? { revision: extension.revision, error: extension.error }
        : null,
    };
  }

  /**
   * Accept telemetry from an application process that cannot share memory with
   * the dashboard, such as a dev server worker: span batches, and a notice when
   * the app loads.
   */
  async function ingest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readBytes(request, MAX_INGEST_BYTES);
    if (!body) {
      tooLarge(response);
      return;
    }
    let payload: IngestPayload | null;
    try {
      payload = JSON.parse(Buffer.from(body).toString("utf8")) as IngestPayload;
    } catch {
      payload = null;
    }
    if (payload === null || typeof payload !== "object") {
      send(response, 400, "Bad request");
      return;
    }
    if (Array.isArray(payload.records)) {
      options.store.ingest(payload.records, options.store.latestGeneration);
    }
    if (typeof payload.worker === "string") {
      options.store.startGeneration(payload.worker);
    }
    send(response, 204, "");
  }

  async function docsRoute(
    response: ServerResponse,
    pathname: string,
    params: URLSearchParams,
  ): Promise<void> {
    const docs = options.docs?.();
    if (!docs) {
      send(response, 404, "The app has no documentation.");
      return;
    }
    try {
      if (pathname === DOCS_PATHS.info) return json(response, docs.info());
      if (pathname === DOCS_PATHS.search)
        return json(response, await docs.search(params.get("q") ?? ""));
      if (pathname === DOCS_PATHS.components) {
        const code = await docs.components();
        if (code === undefined) return send(response, 404, "No components.");
        return send(response, 200, code, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
      }
      const pagePrefix = DOCS_PATHS.page;
      if (pathname === pagePrefix || pathname.startsWith(`${pagePrefix}/`)) {
        const slugs = pathname
          .slice(pagePrefix.length)
          .split("/")
          .filter(Boolean)
          .map(decodeURIComponent);
        const page = await docs.page(slugs);
        return page
          ? json(response, page)
          : send(response, 404, "No such page.");
      }
      const filePrefix = `${DOCS_PATHS.files}/`;
      if (pathname.startsWith(filePrefix)) {
        const file = await docs.file(
          pathname
            .slice(filePrefix.length)
            .split("/")
            .map(decodeURIComponent)
            .join("/"),
        );
        if (!file) return send(response, 404, "No such file.");
        return send(response, 200, file.body, {
          "content-type": file.type,
          "cache-control": "no-store",
          // An image in a page; a document opened directly cannot run scripts.
          "content-security-policy": "sandbox",
        });
      }
      send(response, 404, "Not found");
    } catch (error) {
      send(
        response,
        error instanceof URIError ? 400 : 500,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Pass a request to the workflow inspector, which the app serves on a port of
   * its own, and stream its answer back (it follows a run's output as it
   * grows). Anyone who can open the dashboard may look, but a change must come
   * from the dashboard's own page: the inspector can cancel runs and resume
   * hooks, and a page on another site could otherwise post to it.
   */
  async function inspector(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    const target = options.store.inspectorTarget();
    if (!target) {
      send(
        response,
        503,
        "The workflow inspector and schedules are not being served. The app may be restarting, or it may have neither workflows nor schedules.",
        { "content-type": "text/plain; charset=utf-8" },
      );
      return;
    }
    if (!isBodyless(request) && !fromOwnPage(request)) {
      send(response, 403, "Forbidden");
      return;
    }
    await forward(
      request,
      response,
      `http://127.0.0.1:${target.port}${url.pathname}${url.search}`,
      (headers) => headers.set(INSPECTOR_TOKEN_HEADER, target.token),
      "Could not reach the workflow inspector.",
    );
  }

  /**
   * Pass `/app/*` to the app, so the extension's pages read it from the
   * dashboard's own origin. Only the dashboard's page may use it, as with the
   * API proxy. A credential for the dashboard itself is not passed on.
   */
  async function app(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!fromOwnPage(request)) {
      send(response, 403, "Forbidden");
      return;
    }
    const appUrl = options.appUrl ?? options.store.apiSnapshot()?.appUrl;
    if (!appUrl) {
      send(response, 503, "The app is not running yet.");
      return;
    }
    // Framed by an extension's iframe page, and by nothing else.
    frameOnlyHere(response);
    await forward(
      request,
      response,
      `${new URL(appUrl).origin}${url.pathname.slice(ROUTES.app.path.length) || "/"}${url.search}`,
      (headers) => {
        if (access) headers.delete("authorization");
      },
      "Could not reach the app.",
    );
  }

  /**
   * Send the request on to `target` and stream its answer back. `body`: the
   * request's body when the caller already read it; else it is streamed.
   */
  async function forward(
    request: IncomingMessage,
    response: ServerResponse,
    target: string,
    adjust: (headers: Headers) => void,
    unreachable: string,
    body?: Uint8Array,
  ): Promise<void> {
    const headers = forwardedHeaders(request);
    adjust(headers);
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        redirect: "manual",
        signal: abort.signal,
        ...(isBodyless(request)
          ? {}
          : body
            ? { body: body as BodyInit }
            : {
                body: Readable.toWeb(request) as unknown as BodyInit,
                duplex: "half",
              }),
      } as RequestInit);
      response.writeHead(upstream.status, returnedHeaders(upstream));
      if (!upstream.body || request.method === "HEAD") {
        response.end();
        return;
      }
      await pipeline(Readable.fromWeb(upstream.body as never), response);
    } catch {
      if (response.headersSent) response.destroy();
      else send(response, 502, unreachable);
    }
  }

  /**
   * Send a request on to the app for the APIs view, which cannot call the app
   * directly: it is another origin. Only the dashboard's own page may use this,
   * and only to reach the app being shown. The address to call is `?url=`; a
   * `?cookie=` is the cookie parameters the reader typed into Try it, and the
   * only cookie the app is sent (the dashboard's own are never forwarded).
   */
  async function proxy(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (!fromOwnPage(request)) {
      send(response, 403, "Forbidden");
      return;
    }
    let target: URL | undefined;
    try {
      target = new URL(url.searchParams.get("url") ?? "");
    } catch {
      // Not an address; refused below.
    }
    const appUrl = options.store.apiSnapshot()?.appUrl;
    if (!target || !appUrl || target.origin !== new URL(appUrl).origin) {
      send(
        response,
        403,
        "Only the app shown in the dashboard can be reached.",
      );
      return;
    }
    const body = await readBytes(request, MAX_PROXY_BYTES);
    if (!body) {
      tooLarge(response);
      return;
    }
    const cookie = url.searchParams.get("cookie");
    await forward(
      request,
      response,
      target.href,
      (headers) => {
        if (cookie) headers.set("cookie", cookie);
      },
      "Could not reach the app.",
      body,
    );
  }

  function eventStream(request: IncomingMessage, response: ServerResponse) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // So a proxy in front passes events on as they come.
      "x-accel-buffering": "no",
    });
    const write = (chunk: string) => {
      if (response.writableEnded || response.destroyed) return;
      response.write(chunk);
    };
    const emit = <K extends keyof DashboardEvents>(
      name: K,
      data: DashboardEvents[K],
    ) => write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    emit("snapshot", snapshot());
    const unsubscribe = options.store.subscribe((event) =>
      emit(event.type, event),
    );
    const unwatch = extension?.onChange(() =>
      emit("extension", snapshot().extension),
    );
    const keepalive = setInterval(() => write(": keepalive\n\n"), KEEPALIVE_MS);
    request.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
      unwatch?.();
    });
  }

  // The first build finishes before the page can be asked for; a failed one
  // is shown on the page, and does not stop the dashboard.
  const ready = extension
    ? Promise.all([
        extension.load(),
        options.plugins && extension.setPlugins(options.plugins),
      ])
    : Promise.resolve();
  return ready.then(() => listen());

  function listen(): Promise<DevDashboard> {
    return new Promise((resolve, reject) => {
      server.once("error", (error) => {
        extension?.close();
        reject(
          new Error(
            `Brick: dashboard port ${options.port} is unavailable.${options.portHint ? ` ${options.portHint}` : ""}`,
            { cause: error },
          ),
        );
      });
      server.listen(options.port, host, () => {
        const address = server.address();
        const port =
          typeof address === "object" && address !== null
            ? address.port
            : options.port;
        allowedHosts = new Set([
          `127.0.0.1:${port}`,
          `localhost:${port}`,
          `[::1]:${port}`,
        ]);
        if (!production) extension?.watch();
        resolve({
          port,
          setPluginExtensions: (plugins) =>
            extension?.setPlugins(plugins) ?? Promise.resolve(),
          stop() {
            extension?.close();
            server.close();
            server.closeAllConnections();
          },
        });
      });
    });
  }
}

/** The whole request body, or undefined when it is larger than `limit`. */
function readBytes(
  request: IncomingMessage,
  limit: number,
): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        // Stop buffering; tooLarge() answers and closes the connection.
        request.removeAllListeners("data");
        request.resume();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    request.on("error", () => resolve(undefined));
  });
}

function history(
  store: DevHistory,
  pathname: string,
  params: URLSearchParams,
  response: ServerResponse,
): void {
  const queries: {
    [K in keyof HistoryResponses]: (query: HistoryQuery) => HistoryResponses[K];
  } = {
    summary: (query) => store.summary(query),
    traces: (query) => store.traces(query),
    facets: (query) => store.facets(query),
    volume: (query) => store.volume(query),
  };
  try {
    const endpoint = pathname.slice(ROUTES.history.path.length + 1);
    if (endpoint === "") return json(response, store.info());
    if (endpoint === "export") {
      return send(response, 200, store.exportCsv(decodeHistoryQuery(params)), {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="brick-requests.csv"',
        "cache-control": "no-store",
      });
    }
    if (Object.hasOwn(queries, endpoint))
      return json(
        response,
        queries[endpoint as keyof typeof queries](decodeHistoryQuery(params)),
      );
    const prefix = "traces/";
    if (endpoint.startsWith(prefix)) {
      const trace = store.trace(
        decodeURIComponent(endpoint.slice(prefix.length)),
      );
      if (trace) return json(response, trace);
    }
    send(response, 404, "Not found");
  } catch (error) {
    // A malformed `%` in the trace id is the caller's mistake.
    if (error instanceof URIError) return send(response, 400, error.message);
    console.error("[Brick-TS] A dashboard history query failed:", error);
    send(response, 500, "History query failed");
  }
}

const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

const assetType = (name: string): string =>
  ASSET_TYPES[extname(name)] ?? "application/octet-stream";

function serveAsset(response: ServerResponse, name: string): void {
  // Plain file names only: no separators, so a request cannot leave the folder.
  if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) {
    send(response, 404, "Not found");
    return;
  }
  const directory = assetsDirectory();
  if (!directory) {
    send(
      response,
      503,
      "Dashboard assets are missing. Build them with: bun run --filter @brickkit/cli build",
    );
    return;
  }
  readFile(join(directory, name)).then(
    (body) =>
      send(response, 200, body, {
        "content-type": assetType(name),
        "cache-control": "no-store",
      }),
    () => send(response, 404, "Not found"),
  );
}

function tooLarge(response: ServerResponse): void {
  // Closing after the 413 stops the rest of the upload being read.
  send(response, 413, "Payload too large", {
    "content-type": "text/plain; charset=utf-8",
    connection: "close",
  });
}

function send(
  response: ServerResponse,
  status: number,
  body: string | Uint8Array,
  headers: Record<string, string | string[]> = {
    "content-type": "text/plain; charset=utf-8",
  },
): void {
  response.writeHead(status, headers);
  response.end(body);
}

function json(response: ServerResponse, body: unknown): void {
  send(response, 200, JSON.stringify(body), {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
}

const isBodyless = (request: IncomingMessage) =>
  request.method === "GET" || request.method === "HEAD";

/**
 * Whether a request comes from the dashboard's own page, as far as the browser
 * says: the same site, and the same origin as the address it was sent to.
 * Behind a proxy that terminates TLS that address is https.
 */
function fromOwnPage(request: IncomingMessage): boolean {
  const site = request.headers["sec-fetch-site"];
  const origin = request.headers.origin;
  return (
    (site === undefined || site === "same-origin") &&
    (origin === undefined ||
      origin === `${requestProtocol(request)}://${request.headers.host}`)
  );
}

function frameOnlyHere(response: ServerResponse): void {
  response.setHeader("content-security-policy", "frame-ancestors 'self'");
  response.setHeader("x-frame-options", "SAMEORIGIN");
}

/** The request's headers to send on, without those of this hop or this page. */
function forwardedHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || NOT_FORWARDED.has(name)) continue;
    if (name.startsWith("sec-")) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

function returnedHeaders(upstream: Response): Record<string, string> {
  const returned: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!NOT_RETURNED.has(name)) returned[name] = value;
  });
  return returned;
}
