import {
  createMcpHandler,
  DASHBOARD_IDENTITY_HEADER,
  DASHBOARD_MCP_ROUTE,
  signDashboardIdentity,
  UnknownToolError,
  type DashboardIdentity,
  type McpRegistry,
  type McpToolDefinition,
} from "@brickkit/core";
import cliPkg from "../package.json";
import {
  ATTR,
  SPAN,
  type HistoryFacets,
  type HistorySummary,
  type HistoryTrace,
  type Outcome,
  type TraceSpan,
  type TraceSummary,
} from "./dashboard-protocol";
import {
  applyFilters,
  computeFacets,
  findException,
  OUTCOMES,
  outcomeOf,
  SERVER_ERROR,
  stringAttribute,
  summarizeRows,
  toRow,
  type HistoryQuery,
} from "./dashboard-query";
import type { DevHistory } from "./dev-history";
import type { DevTelemetryStore } from "./dev-telemetry-store";

/*
 * The dashboard's data for a coding agent, over MCP at `/mcp`. Every tool only
 * reads, for every caller, a signed-in user included: log lines carry what end
 * users typed, and an agent that reads them must not be able to act on them.
 */

const MINUTE = 60_000;
const UNITS = { s: 1000, m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE };
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;
const SLOWEST_ENDPOINTS = 5;
/** A `get_trace` answer is cut to about this many characters of JSON. */
export const MAX_TRACE_CHARS = 50_000;
/** From mildest to harshest: the first that fits the cap is the answer. */
const TRACE_LEVELS = [
  { text: 2000, attributes: 40, events: 50, spans: 300 },
  { text: 500, attributes: 20, events: 20, spans: 150 },
  { text: 200, attributes: 10, events: 5, spans: 60 },
  { text: 100, attributes: 5, events: 2, spans: 30 },
] as const;

type Args = Record<string, unknown>;

/** Where the queries read: stored history when there is some, else what is in memory. */
interface Source {
  name: "history" | "memory";
  summary(query: HistoryQuery): HistorySummary;
  traces(query: HistoryQuery): { total: number; traces: HistoryTrace[] };
  facets(query: HistoryQuery): HistoryFacets;
  trace(traceId: string): TraceSummary | undefined;
}

/** The same rules the Requests view runs over its live requests. */
function memorySource(store: DevTelemetryStore): Source {
  const rows = (query: HistoryQuery) =>
    store
      .snapshot()
      .traces.map(toRow)
      .filter((row) => row.startMs >= query.from && row.startMs <= query.to);
  return {
    name: "memory",
    summary: (query) => summarizeRows(applyFilters(rows(query), query)),
    traces(query) {
      const found = applyFilters(rows(query), query);
      const offset = query.offset ?? 0;
      return {
        total: found.length,
        traces: found.slice(offset, offset + (query.limit ?? found.length)),
      };
    },
    facets: (query) => computeFacets(rows(query), query),
    trace: (traceId) =>
      store.snapshot().traces.find((trace) => trace.traceId === traceId),
  };
}

function sourceOf(store: DevTelemetryStore, history?: DevHistory): Source {
  if (!history) return memorySource(store);
  const memory = memorySource(store);
  return {
    name: "history",
    summary: (query) => history.summary(query),
    traces: (query) => history.traces(query),
    facets: (query) => history.facets(query),
    // A request still running is not on disk yet.
    trace: (traceId) => history.trace(traceId) ?? memory.trace(traceId),
  };
}

// ---------------------------------------------------------------------------
// Arguments

function time(value: unknown, name: string, now: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    if (/^\d+$/.test(value.trim())) return Number(value.trim());
    const ago = /^(\d+)\s*([smhd])$/.exec(value.trim());
    if (ago) return now - Number(ago[1]) * UNITS[ago[2] as keyof typeof UNITS];
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new Error(
    `${name} must be an ISO 8601 time, epoch milliseconds, or a time ago such as "30m", "2h" or "7d".`,
  );
}

function window(args: Args, defaultSpanMs: number) {
  const now = Date.now();
  const to = time(args.to, "to", now) ?? now;
  const from = time(args.from, "from", now) ?? to - defaultSpanMs;
  if (from > to) throw new Error("from must not be after to.");
  return { from, to };
}

function integer(
  args: Args,
  name: string,
  min: number,
  max: number,
  fallback?: number,
): number | undefined {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${name} must be a whole number.`);
  return Math.min(Math.max(value, min), max);
}

function text(args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value.trim() || undefined;
}

// ---------------------------------------------------------------------------
// Output

const iso = (ms: number) => new Date(ms).toISOString();
const round = (ms: number | undefined) =>
  ms === undefined ? undefined : Math.round(ms * 10) / 10;
const cut = (value: string | undefined, limit: number) =>
  value !== undefined && value.length > limit
    ? `${value.slice(0, limit)}… [${value.length - limit} more characters]`
    : value;
/** Compact JSON: an agent pays for every space. */
const out = (value: unknown) => JSON.stringify(value);

function row(trace: HistoryTrace) {
  return {
    traceId: trace.traceId,
    time: iso(trace.startMs),
    endpoint: trace.endpoint,
    path: trace.path,
    status: trace.httpStatus,
    outcome: outcomeOf(trace),
    state: trace.status,
    durationMs: round(trace.durationMs),
    service: trace.service,
    action: trace.action,
    message: cut(trace.message, 300),
  };
}

interface Cuts {
  text: number;
  attributes: number;
  events: number;
  spans: number;
}

/** The trace as a tree of spans, within `limits`; `cuts` counts what was left out. */
function traceTree(
  trace: TraceSummary,
  limits: (typeof TRACE_LEVELS)[number],
  cuts: Cuts,
) {
  const shorten = (value: string | undefined) => {
    const short = cut(value, limits.text);
    if (short !== value) cuts.text += 1;
    return short;
  };
  const attributes = (source: TraceSpan["attributes"]) => {
    const entries = Object.entries(source).filter(([, v]) => v !== undefined);
    cuts.attributes += Math.max(entries.length - limits.attributes, 0);
    return Object.fromEntries(
      entries
        .slice(0, limits.attributes)
        .map(([key, value]) => [
          key,
          typeof value === "string"
            ? shorten(value)
            : Array.isArray(value)
              ? shorten(JSON.stringify(value))
              : value,
        ]),
    );
  };
  const spans = [...trace.spans].sort((a, b) => a.startMs - b.startMs);
  cuts.spans += Math.max(spans.length - limits.spans, 0);
  const nodes = new Map<
    string,
    Record<string, unknown> & { children: any[] }
  >();
  const roots: unknown[] = [];
  for (const span of spans.slice(0, limits.spans)) {
    const exception = findException(span.events);
    const shown = span.events.filter(
      (event) => event.name !== SPAN.exceptionEvent,
    );
    cuts.events += Math.max(shown.length - limits.events, 0);
    const node = {
      spanId: span.spanId,
      name: span.name,
      startMs: Math.round(span.startMs - trace.startMs),
      durationMs:
        span.endMs === undefined ? undefined : round(span.endMs - span.startMs),
      status: span.status,
      statusMessage: shorten(span.statusMessage),
      error: exception && {
        type: stringAttribute(exception, "exception.type"),
        message: shorten(stringAttribute(exception, ATTR.exceptionMessage)),
        stack: shorten(stringAttribute(exception, ATTR.exceptionStack)),
      },
      attributes: attributes(span.attributes),
      // A log line is an event named `log`.
      events: shown.slice(0, limits.events).map((event) =>
        event.name === SPAN.logEvent
          ? {
              atMs: Math.round(event.timeMs - trace.startMs),
              name: event.name,
              level: stringAttribute(event.attributes, ATTR.logLevel),
              message: shorten(
                stringAttribute(event.attributes, ATTR.logMessage),
              ),
            }
          : {
              atMs: Math.round(event.timeMs - trace.startMs),
              name: event.name,
              attributes: attributes(event.attributes),
            },
      ),
      children: [] as unknown[],
    };
    nodes.set(span.spanId, node);
    // A span whose parent was cut, or never reported, goes at the top.
    const parent = span.parentSpanId && nodes.get(span.parentSpanId);
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

function traceAnswer(trace: TraceSummary): string {
  let answer = "";
  for (const limits of TRACE_LEVELS) {
    const cuts: Cuts = { text: 0, attributes: 0, events: 0, spans: 0 };
    const row = toRow(trace);
    const cutAny = () => Object.values(cuts).some((count) => count > 0);
    const body = {
      traceId: trace.traceId,
      endpoint: row.endpoint,
      path: trace.path,
      status: trace.httpStatus,
      outcome: outcomeOf(trace),
      state: trace.status,
      time: iso(trace.startMs),
      durationMs: round(trace.durationMs),
      service: trace.service,
      action: trace.action,
      message: cut(trace.message, limits.text),
      // `startMs` and `atMs` below count from the start of the request.
      spans: traceTree(trace, limits, cuts),
      truncated: undefined as unknown,
    };
    if (trace.truncated || cutAny())
      body.truncated = {
        note: `Cut to fit about ${MAX_TRACE_CHARS / 1000} KB. Left out: ${cuts.spans} spans, ${cuts.events} events, ${cuts.attributes} attributes; shortened ${cuts.text} long strings.${trace.truncated ? " The app itself also stopped recording spans of this request, which was very large." : ""}`,
        ...cuts,
      };
    answer = out(body);
    if (answer.length <= MAX_TRACE_CHARS) break;
  }
  return answer;
}

// ---------------------------------------------------------------------------
// The tools

const TIME_HELP =
  'An ISO 8601 time, epoch milliseconds, or a time ago such as "30m", "2h" or "7d".';

const READ_ONLY = { readOnlyHint: true } as const;

const TOOLS: McpToolDefinition[] = [
  {
    name: "summary",
    description:
      "How the app is doing over a time window: request count, how many failed (client errors 4xx, server errors 5xx or thrown), the share that failed on the server, median and p95 duration, and the slowest endpoints. Start here to see whether something is wrong. Default window: the last hour.",
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: `Window start. ${TIME_HELP} Default: an hour before \`to\`.`,
        },
        to: {
          type: "string",
          description: `Window end. ${TIME_HELP} Default: now.`,
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "list_requests",
    description:
      "Requests the app served, newest first (or slowest first), one row each: trace id, time, endpoint, path, HTTP status, outcome (ok, client error, server error), duration, service and action, and the failure message. Rows only; call get_trace with a trace id for the spans and log lines. Default window: the last 24 hours.",
    inputSchema: {
      type: "object",
      properties: {
        outcome: {
          type: "string",
          enum: [...OUTCOMES],
          description:
            "ok (below 400), client (4xx), or server (5xx or thrown).",
        },
        endpoint: {
          type: "string",
          description:
            'Exactly as the rows show it, such as "GET /api/pages/:id".',
        },
        method: {
          type: "string",
          description: 'An HTTP method, such as "POST".',
        },
        service: { type: "string", description: "A service name." },
        query: {
          type: "string",
          description:
            "Text to look for in the endpoint, path, span name, action or failure message.",
        },
        min_ms: {
          type: "integer",
          minimum: 1,
          description: "Only requests at least this slow.",
        },
        sort: {
          type: "string",
          enum: ["recent", "slowest"],
          description: "Default: recent.",
        },
        from: {
          type: "string",
          description: `Window start. ${TIME_HELP} Default: a day before \`to\`.`,
        },
        to: {
          type: "string",
          description: `Window end. ${TIME_HELP} Default: now.`,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          description: `Rows to return. Default ${DEFAULT_LIST_LIMIT}.`,
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Rows to skip, to page through.",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "get_trace",
    description:
      'One request in full, by trace id: the tree of spans with each one\'s name, timing (milliseconds from the start of the request), status, attributes (such as SQL text), events and any error with its stack. Log lines are events named "log" with a level and message. The answer is cut to about 50 KB, and says what was left out.',
    inputSchema: {
      type: "object",
      properties: {
        trace_id: {
          type: "string",
          description: "From list_requests or list_errors.",
        },
      },
      required: ["trace_id"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "list_errors",
    description:
      'Recent failures, newest first: failed requests (server errors, 5xx or thrown) and crashes of the app process, with the message, the route, the service and action, a stack when there is one, and the trace id to open with get_trace. Covers what the dashboard has seen since it started (the last 200). For older server errors use list_requests with outcome "server".',
    inputSchema: {
      type: "object",
      properties: {
        from: {
          type: "string",
          description: `Only failures after this. ${TIME_HELP}`,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIST_LIMIT,
          description: `Default ${DEFAULT_LIST_LIMIT}.`,
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "app_overview",
    description:
      "How the app is built, not what it is doing: its services with their actions (and the HTTP route of each), MCP tools, sockets, events and database tables; the event listeners and schedules, with the workflows among them; and the installed plugins.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
];

/** The tools the dashboard offers a coding agent. Every one only reads. */
export function createDashboardMcpRegistry(options: {
  store: DevTelemetryStore;
  history?: DevHistory;
  mode: "dev" | "production";
}): McpRegistry {
  const { store, history } = options;
  const calls: Record<string, (args: Args) => string> = {
    summary(args) {
      const { from, to } = window(args, 60 * MINUTE);
      const source = sourceOf(store, history);
      const query: HistoryQuery = { from, to };
      const total = source.summary(query);
      // Per endpoint, among the busiest: the facets list at most 30.
      const slowest = source
        .facets(query)
        .endpoint.map(({ value }) => ({
          endpoint: value,
          ...source.summary({ ...query, endpoints: [value] }),
        }))
        .sort((a, b) => b.p95Ms - a.p95Ms)
        .slice(0, SLOWEST_ENDPOINTS);
      return out({
        window: { from: iso(from), to: iso(to) },
        source: source.name,
        requests: total.total,
        clientErrors: total.clientErrors,
        serverErrors: total.serverErrors,
        errorRate: total.total
          ? Math.round((total.serverErrors / total.total) * 10_000) / 10_000
          : 0,
        medianMs: round(total.medianMs),
        p95Ms: round(total.p95Ms),
        slowestEndpoints: slowest.map((endpoint) => ({
          endpoint: endpoint.endpoint,
          requests: endpoint.total,
          serverErrors: endpoint.serverErrors,
          medianMs: round(endpoint.medianMs),
          p95Ms: round(endpoint.p95Ms),
        })),
      });
    },
    list_requests(args) {
      const { from, to } = window(args, 24 * 60 * MINUTE);
      const outcome = text(args, "outcome");
      if (outcome && !OUTCOMES.includes(outcome as Outcome))
        throw new Error(`outcome must be one of: ${OUTCOMES.join(", ")}.`);
      const sort = text(args, "sort");
      if (sort && sort !== "recent" && sort !== "slowest")
        throw new Error("sort must be recent or slowest.");
      const one = (name: string) => {
        const value = text(args, name);
        return value ? [value] : undefined;
      };
      const limit = integer(
        args,
        "limit",
        1,
        MAX_LIST_LIMIT,
        DEFAULT_LIST_LIMIT,
      )!;
      const offset = integer(args, "offset", 0, Number.MAX_SAFE_INTEGER, 0)!;
      const source = sourceOf(store, history);
      const found = source.traces({
        from,
        to,
        endpoints: one("endpoint"),
        methods: one("method")?.map((method) => method.toUpperCase()),
        services: one("service"),
        outcomes: outcome ? [outcome as Outcome] : undefined,
        minMs: integer(args, "min_ms", 1, Number.MAX_SAFE_INTEGER),
        query: text(args, "query"),
        sort: sort === "slowest" ? "slowest" : "recent",
        limit,
        offset,
      });
      return out({
        window: { from: iso(from), to: iso(to) },
        source: source.name,
        total: found.total,
        offset,
        ...(offset + found.traces.length < found.total
          ? { nextOffset: offset + found.traces.length }
          : {}),
        requests: found.traces.map(row),
      });
    },
    get_trace(args) {
      const id = text(args, "trace_id");
      if (!id) throw new Error("trace_id is required.");
      const trace = sourceOf(store, history).trace(id);
      if (!trace)
        throw new Error(
          `No request with trace id ${id}. The dashboard keeps ${history ? `${history.days} days of requests` : "only the last 200 requests, and history is off"}.`,
        );
      return traceAnswer(trace);
    },
    list_errors(args) {
      const since = time(args.from, "from", Date.now());
      const limit = integer(
        args,
        "limit",
        1,
        MAX_LIST_LIMIT,
        DEFAULT_LIST_LIMIT,
      )!;
      // A client error (4xx) is not a failure here; list_requests has them.
      const failures = store
        .snapshot()
        .failures.filter(
          (failure) =>
            (since === undefined || failure.at >= since) &&
            (failure.status ?? SERVER_ERROR) >= SERVER_ERROR,
        );
      return out({
        total: failures.length,
        errors: failures.slice(0, limit).map((failure) => ({
          time: iso(failure.at),
          code: failure.code,
          kind: failure.phase,
          message: cut(failure.message, 500),
          status: failure.status,
          route: failure.route,
          service: failure.service,
          action: failure.action,
          traceId: failure.traceId,
          stack: cut(failure.stack, 1500),
        })),
      });
    },
    app_overview() {
      const { architecture } = store.snapshot();
      if (!architecture)
        return out({
          note: "The app has not reported its architecture yet. It may still be starting.",
        });
      const { schema } = architecture;
      const events = schema.events;
      const workflows = [
        ...(events?.listeners ?? []).filter((item) => item.kind === "workflow"),
        ...(events?.schedules ?? []).filter((item) => item.kind === "workflow"),
      ].map((item) => item.name);
      return out({
        mode: options.mode,
        historyDays: history?.days ?? 0,
        version: schema.version,
        services: schema.services.map((service) => ({
          name: service.name,
          database: service.databaseConfig,
          actions: service.actions.map((action) => ({
            name: action.name,
            route:
              action.method && action.path
                ? `${action.method} ${action.path}`
                : undefined,
            description: cut(action.description, 200),
            access: action.accessPolicy,
            emits: action.emits,
          })),
          tools: service.tools?.map((tool) => tool.name),
          sockets: service.sockets?.map((socket) => socket.name),
          events: service.events?.map((event) => event.name),
          resources: service.resources?.map((resource) => resource.name),
        })),
        listeners: events?.listeners,
        schedules: events?.schedules,
        workflows,
        plugins: schema.plugins?.map((plugin) => plugin.name),
      });
    },
  };
  return {
    listTools: () => TOOLS,
    async callTool(name, args = {}) {
      const call = Object.hasOwn(calls, name) ? calls[name] : undefined;
      if (!call) throw new UnknownToolError(name);
      return call(args);
    },
  };
}

/** Core's mark on an output schema that wraps a value that is not an object. */
const WRAP_RESULT = "x-brick-wrap-result";
const LIST_TIMEOUT_MS = 5000;
const CALL_TIMEOUT_MS = 30_000;
const BUILT_IN = new Set(TOOLS.map((tool) => tool.name));

/** A tool the app offers is a write tool unless its author says it only reads. */
const writes = (tool: McpToolDefinition) =>
  tool.annotations?.readOnlyHint !== true;

interface AppTools {
  /** The app's `dashboard: true` tools, when it answered. */
  tools: McpToolDefinition[];
  /** Why it did not. */
  failed?: string;
}

/**
 * The app's MCP for the dashboard, over its HTTP, signed as the dashboard's
 * `/app` is: the tool runs as for an extension page, with `ctx.dashboard` set,
 * and its own `authorize`, rate limit, sensitive-field removal and audit apply.
 */
async function askApp(
  appUrl: string,
  identity: DashboardIdentity,
  method: string,
  params: unknown,
  timeoutMs: number,
) {
  const answer = await fetch(
    `${new URL(appUrl).origin}${DASHBOARD_MCP_ROUTE}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DASHBOARD_IDENTITY_HEADER]: signDashboardIdentity(identity),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
  return (await answer.json()) as {
    result?: {
      content?: { text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
      tools?: McpToolDefinition[];
    };
    error?: { message: string };
  };
}

/** The built-in tools, and the app's own beside them, for one caller. */
function withAppTools(
  base: McpRegistry,
  app: AppTools | undefined,
  caller: {
    identity: DashboardIdentity;
    appUrl: string | undefined;
    mayChange: boolean;
  },
): McpRegistry {
  const own = (app?.tools ?? []).filter((tool) => !BUILT_IN.has(tool.name));
  return {
    listTools: () => [
      ...base.listTools(),
      ...own
        // A tool that can change data is offered only to one who may change it.
        .filter((tool) => !writes(tool) || caller.mayChange)
        .map((tool) =>
          writes(tool)
            ? {
                ...tool,
                annotations: {
                  ...tool.annotations,
                  destructiveHint: tool.annotations?.destructiveHint ?? true,
                },
              }
            : tool,
        ),
    ],
    async callTool(name, args) {
      if (BUILT_IN.has(name)) return base.callTool(name, args);
      if (app?.failed)
        throw new Error(
          `The app did not answer (${app.failed}), so its tools are unavailable. It may be restarting.`,
        );
      const tool = own.find((item) => item.name === name);
      if (!tool || !caller.appUrl) throw new UnknownToolError(name);
      if (writes(tool) && !caller.mayChange)
        throw new Error(
          `${name} can change data, so only a signed-in user may call it: dashboard.auth.authorize must return { user }. A token, or authorize returning true, can only read.`,
        );
      const answer = await askApp(
        caller.appUrl,
        caller.identity,
        "tools/call",
        { name, arguments: args ?? {} },
        CALL_TIMEOUT_MS,
      );
      const text = answer.result?.content?.map((part) => part.text).join("\n");
      if (answer.error || answer.result?.isError)
        throw new Error(answer.error?.message ?? text);
      const structured = answer.result?.structuredContent;
      if (structured === undefined) return text ?? "";
      return (tool.outputSchema as Record<string, unknown> | undefined)?.[
        WRAP_RESULT
      ]
        ? (structured as { result: unknown }).result
        : structured;
    },
  };
}

/**
 * The MCP endpoint's handler: the dashboard's five tools, and the app's tools
 * marked `dashboard: true`. Those that are not `readOnlyHint: true` can change
 * data, and go only to a caller `mayChange` allows.
 */
export function createDashboardMcp(
  options: Parameters<typeof createDashboardMcpRegistry>[0] & {
    /** Where the app listens, when it does. */
    appUrl: () => string | undefined;
    /** Whether this caller may use tools that change data. */
    mayChange: (identity: DashboardIdentity) => boolean;
  },
): (request: Request, identity: DashboardIdentity) => Promise<Response> {
  const base = createDashboardMcpRegistry(options);
  return async (request, identity) => {
    // Only a list, or a call to a tool that is not the dashboard's own, asks the app.
    const rpc = (await request
      .clone()
      .json()
      .catch(() => undefined)) as
      | { method?: unknown; params?: { name?: unknown } }
      | undefined;
    const appUrl = options.appUrl();
    let app: AppTools | undefined;
    if (
      appUrl &&
      (rpc?.method === "tools/list" ||
        (rpc?.method === "tools/call" &&
          typeof rpc.params?.name === "string" &&
          !BUILT_IN.has(rpc.params.name)))
    ) {
      try {
        const answer = await askApp(
          appUrl,
          identity,
          "tools/list",
          undefined,
          LIST_TIMEOUT_MS,
        );
        app = { tools: answer.result?.tools ?? [] };
      } catch (error) {
        app = {
          tools: [],
          failed: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return createMcpHandler({
      registry: withAppTools(base, app, {
        identity,
        appUrl,
        mayChange: options.mayChange(identity),
      }),
      serverInfo: {
        name: "brick-dashboard",
        title: "Brick dashboard",
        version: cliPkg.version,
      },
    })(request);
  };
}
