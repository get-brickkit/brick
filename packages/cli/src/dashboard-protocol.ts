import type { Attributes } from "@opentelemetry/api";
import type { ArchitectureSchema } from "@brickkit/core";

/*
 * What the dashboard server and its page agree on: the routes, headers, event
 * names and the data they carry. Types and constants only, so the page can
 * import it without the server's code.
 */

// ---------------------------------------------------------------------------
// Span records: what the app's tracer reports, over IPC or `/api/ingest`

export interface SpanEventRecord {
  name: string;
  timeMs: number;
  attributes: Attributes;
}

export interface SpanStartRecord {
  phase: "start";
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  attributes: Attributes;
}

export interface SpanEndRecord {
  phase: "end";
  traceId: string;
  spanId: string;
  name: string;
  endMs: number;
  status: "unset" | "ok" | "error";
  statusMessage?: string;
  attributes: Attributes;
  events: SpanEventRecord[];
}

export type TelemetryRecord = SpanStartRecord | SpanEndRecord;

export type WorkerErrorPhase = "startup" | "uncaught" | "unhandled-rejection";

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

// ---------------------------------------------------------------------------
// Routes

interface RouteSpec {
  path: string;
  /** Also answers every path below `path`. */
  prefix?: boolean;
  /** The methods it answers; any when absent. */
  methods?: readonly string[];
  /** Served by the production dashboard; `"extension"`: only when it has one. */
  production: boolean | "extension";
  /** The page's view that needs it; a view whose routes production lacks is hidden there. */
  view?: string;
  /** It changes something, so the request must carry `CSRF_HEADER`. */
  csrf?: true;
}

const GET = ["GET"] as const;

/**
 * Every route the dashboard serves. The server dispatches from this table and
 * the page builds its URLs from it. Production serves only what is marked
 * `production`: the shell, live state and stored history. Nothing that
 * changes the app or reaches into it, and nothing from the project's source.
 */
export const ROUTES = {
  /** Open to everyone: uptime monitors cannot sign in. */
  health: { path: "/_health", methods: ["GET", "HEAD"], production: true },
  shell: { path: "/", methods: GET, production: true },
  assets: { path: "/assets", prefix: true, methods: GET, production: true },
  /** The app itself, for an extension's `appFetch`. */
  app: { path: "/app", prefix: true, production: "extension" },
  state: { path: "/api/state", methods: GET, production: true },
  events: { path: "/api/events", methods: GET, production: true },
  history: {
    path: "/api/history",
    prefix: true,
    methods: GET,
    production: true,
  },
  docs: {
    path: "/api/docs",
    prefix: true,
    methods: GET,
    production: false,
    view: "docs",
  },
  openapi: {
    path: "/api/openapi",
    methods: GET,
    production: false,
    view: "apis",
  },
  /** Try it in the APIs view; the app is another origin. */
  proxy: { path: "/api/proxy", production: false, view: "apis" },
  /** The workflow inspector the app serves on a port of its own. */
  workflows: {
    path: "/workflows",
    prefix: true,
    production: false,
    view: "workflows",
  },
  ingest: {
    path: "/api/ingest",
    methods: ["POST"],
    production: false,
    csrf: true,
  },
  restart: {
    path: "/api/restart",
    methods: ["POST"],
    production: false,
    csrf: true,
  },
} as const satisfies Record<string, RouteSpec>;

export type RouteName = keyof typeof ROUTES;

/** The route a request is for, or undefined when none answers it. */
export function matchRoute(
  method: string | undefined,
  pathname: string,
): RouteName | undefined {
  for (const [name, route] of Object.entries(ROUTES) as [
    RouteName,
    RouteSpec,
  ][]) {
    const at =
      pathname === route.path ||
      (route.prefix === true && pathname.startsWith(`${route.path}/`));
    if (at && (!route.methods || route.methods.includes(method ?? "")))
      return name;
  }
  return undefined;
}

/** Views the production dashboard hides: they need a route it does not serve. */
export const PRODUCTION_HIDDEN_VIEWS: ReadonlySet<string> = new Set(
  Object.values(ROUTES as Record<RouteName, RouteSpec>).flatMap((route) =>
    route.view && route.production === false ? [route.view] : [],
  ),
);

export type HistoryEndpoint =
  | "summary"
  | "traces"
  | "facets"
  | "volume"
  | "export";

/** A history query's address; with no endpoint, what the history holds. */
export const historyUrl = (
  endpoint?: HistoryEndpoint,
  params?: URLSearchParams,
): string =>
  `${ROUTES.history.path}${endpoint ? `/${endpoint}` : ""}${params ? `?${params}` : ""}`;

/** One stored request with its spans. */
export const historyTraceUrl = (traceId: string): string =>
  `${historyUrl("traces")}/${encodeURIComponent(traceId)}`;

/** The Docs tab's data: tree, search, compiled pages, files, components. */
export const DOCS_PATHS = {
  info: ROUTES.docs.path,
  search: `${ROUTES.docs.path}/search`,
  components: `${ROUTES.docs.path}/components.js`,
  page: `${ROUTES.docs.path}/page`,
  files: `${ROUTES.docs.path}/files`,
} as const;

/** A path segment as written, when it is not valid percent-encoding. */
export function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The page's address of a docs page, optionally at one of its headings. */
export function docsHref(path: string[], anchor?: string): string {
  const pages = encodePath(path);
  return `#/docs${pages ? `/${pages}` : ""}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
}

const encodePath = (path: string[]): string =>
  path.map(encodeURIComponent).join("/");

/** Where a file in the docs folder is served, by its path inside it. */
export const docsFileUrl = (path: string): string =>
  `${DOCS_PATHS.files}/${encodePath(path.split("/"))}`;

/** Where a compiled docs page is served, by its slugs. */
export const docsPageUrl = (path: string[]): string =>
  `${DOCS_PATHS.page}/${encodePath(path)}`;

/** Where the docs search answers `query`. */
export const docsSearchUrl = (query: string): string =>
  `${DOCS_PATHS.search}?q=${encodeURIComponent(query)}`;

/** Whether a link names a scheme (`https:`, `mailto:`) and so leaves the dashboard. */
export const isExternalHref = (href: string): boolean =>
  /^[a-z][a-z\d+.-]*:/i.test(href);

/**
 * Sent with every request that changes something (restart, ingest). A page on
 * another site cannot send it without a preflight, which the server never
 * answers.
 */
export const CSRF_HEADER = "x-brick-dashboard";
export const CSRF_VALUE = "1";

/** The header that proves a request to the workflow inspector comes from the dashboard. */
export const INSPECTOR_TOKEN_HEADER = "x-brick-inspector";

/** What a process that cannot share memory with the dashboard posts to `/api/ingest`. */
export interface IngestPayload {
  /** Span records, of the newest generation. */
  records?: TelemetryRecord[];
  /** A notice that the app loaded: a new generation begins. */
  worker?: string;
}

// ---------------------------------------------------------------------------
// The shell and its assets

/** The files the shell loads from `ROUTES.assets.path`. `app.*` come from the dashboard's build. */
export const ASSETS = {
  app: "app.js",
  appCss: "app.css",
  /** The project's extension, or the list of parts when plugins have one too. */
  extension: "extension.js",
  extensionCss: "extension.css",
  /** The project's theme tokens; see `themeCss`. */
  theme: "brick-theme.css",
} as const;

/** Where an asset is served. */
export const assetUrl = (file: string): string =>
  `${ROUTES.assets.path}/${file}`;

/**
 * What the shell tells the page in its markup: a `<meta name="brick-extension"
 * data-revision data-src>` for the extension, and the theme's `<link>`.
 */
export const SHELL = {
  extensionMeta: 'meta[name="brick-extension"]',
  themeLink: "link[data-brick-theme]",
} as const;

// ---------------------------------------------------------------------------
// Modules the page shares with the project's own

/**
 * What the dashboard supplies to the project's docs components and dashboard
 * extension, so there is one copy of React and of the UI kit on the page: the
 * bundler leaves `specifier` external, the shell's import map points it at
 * `/assets/<file>`, and `file` hands over the page's `globalThis.__brickDashboard[global]`.
 */
export const SHARED_MODULES = [
  { specifier: "react", file: "react.js", global: "React" },
  {
    specifier: "react/jsx-runtime",
    file: "react-jsx-runtime.js",
    global: "jsxRuntime",
  },
  {
    specifier: "react/jsx-dev-runtime",
    file: "react-jsx-runtime.js",
    global: "jsxRuntime",
  },
  { specifier: "react-dom", file: "react-dom.js", global: "ReactDOM" },
  {
    specifier: "react-dom/client",
    file: "react-dom-client.js",
    global: "ReactDOMClient",
  },
  // The UI kit is a module of the dashboard's own build.
  { specifier: "@brickkit/cli/dashboard", file: "kit.js" },
] as const;

export type SharedGlobal = Extract<
  (typeof SHARED_MODULES)[number],
  { global: string }
>["global"];

/**
 * One of several dashboard extensions (the app's and its plugins'), as
 * `/assets/extension.js` lists them in `export const parts`.
 */
export interface ExtensionPart {
  name: string;
  /** Relative to `extension.js`. */
  src: string;
  /** A plugin's: its pages without a place go under a section named after it. */
  plugin: boolean;
}

/** Where the page keeps the chosen theme; the shell applies it before first paint. */
export const THEME_STORAGE_KEY = "brick-dashboard-theme";

// ---------------------------------------------------------------------------
// Span names and attribute keys core sets, read here and on the page

export { SPAN, ATTR } from "@brickkit/core/client";

// ---------------------------------------------------------------------------
// Live data

/** How many of each the live state keeps, on the server and on the page. */
export const LIVE_LIMITS = { traces: 200, failures: 200, reloads: 100 };

export type SpanOutcome = "running" | "ok" | "error" | "interrupted";

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs?: number;
  status: SpanOutcome;
  statusMessage?: string;
  attributes: Attributes;
  events: SpanEventRecord[];
}

export interface TraceSummary {
  traceId: string;
  name: string;
  method?: string;
  route?: string;
  /** The request's actual path, which differs from a wildcard route template. */
  path?: string;
  httpStatus?: number;
  generation: number;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  status: SpanOutcome;
  truncated: boolean;
  /** The service and action that handled the request, when it ran one. */
  service?: string;
  action?: string;
  /** Why it failed, when it did. */
  message?: string;
  spans: TraceSpan[];
}

export interface FailureSummary {
  id: number;
  at: number;
  phase: "request" | WorkerErrorPhase;
  code: string;
  message: string;
  status?: number;
  stack?: string;
  traceId?: string;
  route?: string;
  service?: string;
  action?: string;
  generation: number;
}

export type ReloadKind = "started" | "restarting" | "exited" | "contract-ready";

export interface ReloadSummary {
  id: number;
  at: number;
  kind: ReloadKind;
  generation: number;
  detail?: string;
}

/** Services, actions, and routes of the application as last started. */
export interface ArchitectureSnapshot {
  generation: number;
  schema: ArchitectureSchema;
}

/** The OpenAPI documents the app offers, for the dashboard's APIs view. */
export interface ApiSnapshot {
  /** Changes each time the documents are replaced, so views know to reload. */
  revision: number;
  /** Where the app listens; Try it in the APIs view sends requests here. */
  appUrl?: string;
  /** Names of the documents, in order. */
  titles: string[];
}

/** What the dashboard knows about the app's developer documentation. */
export type DocsSnapshot =
  | {
      status: "ready";
      /** Changes whenever the pages change, so the Docs tab reloads. */
      revision: number;
      title: string;
      /** Whether the project supplied components of its own. */
      components: boolean;
    }
  /** The packages the docs need are not installed. */
  | { status: "missing"; packages: string[]; message: string }
  /** Why the docs cannot be shown. */
  | { status: "error"; message: string };

/** The project's dashboard extension as last built. */
export interface ExtensionBuild {
  revision: number;
  /** Why the last build failed. */
  error?: string;
}

export type DevTelemetryEvent =
  | { type: "trace"; trace: TraceSummary }
  | { type: "failure"; failure: FailureSummary }
  | { type: "reload"; reload: ReloadSummary }
  | { type: "architecture"; architecture: ArchitectureSnapshot }
  | { type: "api"; api: ApiSnapshot }
  | { type: "docs"; docs: DocsSnapshot | null }
  | { type: "inspector"; inspector: boolean };

export interface DevTelemetrySnapshot {
  traces: TraceSummary[];
  failures: FailureSummary[];
  reloads: ReloadSummary[];
  architecture: ArchitectureSnapshot | null;
  api: ApiSnapshot | null;
  /** Null when the app has no `documentation`. */
  docs: DocsSnapshot | null;
  /** Whether the app serves the workflow inspector the dashboard can show. */
  inspector: boolean;
}

/** `/api/state`, and the first event of `/api/events`: the store's snapshot and the server's own fields. */
export interface DashboardSnapshot extends DevTelemetrySnapshot {
  /** Whether the host can restart the app; the page shows the button. */
  canRestart: boolean;
  /** Days of requests kept on disk; zero when history is off. */
  historyDays: number;
  /** `production` is the read-only monitoring dashboard of `brick start`. */
  mode: "dev" | "production";
  /** The project's extension; null when it has none. */
  extension: ExtensionBuild | null;
}

/** The server-sent events of `/api/events`, by name, with the data each carries. */
export type DashboardEvents = {
  snapshot: DashboardSnapshot;
  /** A rebuilt extension: the page reloads to run it. */
  extension: ExtensionBuild | null;
} & { [E in DevTelemetryEvent as E["type"]]: E };

/** The store's event names; each event is sent under its `type`. */
export const TELEMETRY_EVENTS = Object.keys({
  trace: true,
  failure: true,
  reload: true,
  architecture: true,
  api: true,
  docs: true,
  inspector: true,
} satisfies Record<
  DevTelemetryEvent["type"],
  true
>) as DevTelemetryEvent["type"][];

// ---------------------------------------------------------------------------
// Stored history

/** A finished request without its spans; fetch the full trace by id. */
export type HistoryTrace = Omit<TraceSummary, "spans"> & {
  /** "GET /api/page/:id" when the method and route are known, else the span name. */
  endpoint: string;
};

/** How a request ended: a 5xx or crash, a 4xx, or neither. */
export type Outcome = "ok" | "client" | "server";

/** Rows in one page of `/api/history/traces`, unless the query asks for another number. */
export const HISTORY_PAGE_SIZE = 100;

export interface VolumeBucket {
  start: number;
  ok: number;
  client: number;
  server: number;
}

/** The numbers behind the cards at the top of the log, for what matches. */
export interface HistorySummary {
  total: number;
  clientErrors: number;
  serverErrors: number;
  medianMs: number;
  p95Ms: number;
}

export interface FacetValue {
  value: string;
  count: number;
}

/** What is in the range, counted for each filter as if it were not applied. */
export interface HistoryFacets {
  outcome: FacetValue[];
  method: FacetValue[];
  service: FacetValue[];
  endpoint: FacetValue[];
}

export interface HistoryInfo {
  days: number;
  count: number;
  oldestMs?: number;
}

// ---------------------------------------------------------------------------
// Docs

/** One entry of the docs sidebar. */
export type DocsNode =
  | { type: "page"; name: string; url: string; description?: string }
  | {
      type: "folder";
      name: string;
      index?: { name: string; url: string };
      children: DocsNode[];
      defaultOpen?: boolean;
    }
  | { type: "separator"; name?: string };

export interface DocsTree {
  name: string;
  children: DocsNode[];
}

export interface DocsHeading {
  title: string;
  url: string;
  depth: number;
}

/** A page ready to run in the browser. */
export interface DocsPage {
  title: string;
  description?: string;
  /** The file, relative to the docs folder. */
  path: string;
  slugs: string[];
  toc: DocsHeading[];
  /** MDX compiled to a function body; see `runMdx` in the dashboard. */
  code: string;
  /** Set instead of `code` when the page does not compile. */
  error?: string;
}

export interface DocsSearchHit {
  id: string;
  type: "page" | "heading" | "text";
  content: string;
  /** Route within the docs, with a `#heading` when the hit is inside a page. */
  url: string;
}

export interface DocsInfo {
  tree: DocsTree;
  /** Whether the project supplied components of its own. */
  components: boolean;
  revision: number;
}
