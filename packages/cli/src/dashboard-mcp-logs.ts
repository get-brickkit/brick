import {
  compactJson,
  cut,
  DAY,
  DEFAULT_LIST_LIMIT,
  integer,
  iso,
  MAX_LIST_LIMIT,
  READ_ONLY,
  text,
  time,
  TIME_HELP,
  window,
  type BuiltInTool,
  type McpSources,
} from "./dashboard-mcp-args";
import {
  LOG_LEVELS,
  searchLogLines,
  type LogLevel,
  type LogLine,
  type LogSearch,
} from "./dashboard-query";
import { MAX_SCANNED_LOG_LINES, MAX_SCANNED_REQUESTS } from "./dev-history";

const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;
const MAX_MESSAGE_CHARS = 500;

function hit(line: LogLine) {
  return {
    time: iso(line.timeMs),
    level: line.level,
    message: cut(line.message, MAX_MESSAGE_CHARS),
    traceId: line.traceId,
    endpoint: line.endpoint,
    span: line.span,
  };
}

function searchLogs(sources: McpSources, args: Record<string, unknown>) {
  const { from, to } = window(args, DAY);
  const level = text(args, "level");
  if (level && !LOG_LEVELS.includes(level as LogLevel))
    throw new Error(`level must be one of: ${LOG_LEVELS.join(", ")}.`);
  const search: LogSearch = {
    from,
    to,
    query: text(args, "query"),
    level: level as LogLevel | undefined,
    service: text(args, "service"),
    endpoint: text(args, "endpoint"),
  };
  const limit = integer(args, "limit", 1, MAX_LOG_LIMIT, DEFAULT_LOG_LIMIT)!;
  const offset = integer(args, "offset", 0, Number.MAX_SAFE_INTEGER, 0)!;
  // One line more than asked for tells whether there is a next page.
  const { history, store } = sources;
  let found: LogLine[];
  let note: string | undefined;
  if (history) {
    const stored = history.searchLogLines(search, {
      limit: limit + 1,
      offset,
    });
    found = stored.lines;
    if (stored.requestsInWindow > MAX_SCANNED_REQUESTS)
      note = `The window holds ${stored.requestsInWindow} requests and only the newest ${MAX_SCANNED_REQUESTS} were searched. Narrow from and to to search older ones.`;
    if (stored.linesCapped)
      note = `${note ? `${note} ` : ""}The text was looked for in the newest ${MAX_SCANNED_LOG_LINES} log lines only. Narrow from and to, or add level, service or endpoint, to search older ones.`;
  } else {
    found = searchLogLines(store.snapshot().traces, search).slice(
      offset,
      offset + limit + 1,
    );
  }
  const lines = found.slice(0, limit);
  return compactJson({
    window: { from: iso(from), to: iso(to) },
    source: history ? "history" : "memory",
    offset,
    ...(found.length > limit ? { nextOffset: offset + limit } : {}),
    ...(note ? { note } : {}),
    lines: lines.map(hit),
  });
}

const MAX_STACK_CHARS = 1500;
const MAX_CRASH_MESSAGE_CHARS = 500;

function listReloads(sources: McpSources, args: Record<string, unknown>) {
  const since = time(args.from, "from", Date.now());
  const limit = integer(args, "limit", 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT)!;
  const { reloads, failures } = sources.store.snapshot();
  const recent = <T extends { at: number }>(items: T[]) =>
    items.filter((item) => since === undefined || item.at >= since);
  return compactJson({
    mode: sources.mode,
    reloads: recent(reloads)
      .slice(0, limit)
      .map((reload) => ({
        time: iso(reload.at),
        kind: reload.kind,
        generation: reload.generation,
        detail: reload.detail,
      })),
    // A request's failure is in list_errors; these are the process's own.
    crashes: recent(failures.filter((failure) => failure.phase !== "request"))
      .slice(0, limit)
      .map((crash) => ({
        time: iso(crash.at),
        kind: crash.phase,
        code: crash.code,
        message: cut(crash.message, MAX_CRASH_MESSAGE_CHARS),
        stack: cut(crash.stack, MAX_STACK_CHARS),
        generation: crash.generation,
      })),
  });
}

/** What the Logs view and the Reloads view list. */
export function logTools(sources: McpSources): BuiltInTool[] {
  return [
    {
      definition: {
        name: "search_logs",
        description: `Log lines written with ctx.logger or console during requests, newest first: time, level, message, trace id, endpoint and the span that wrote it. Search by text and level, then open a trace id with get_trace for the whole request. The window is on when the request started (default: the last 24 hours). Text matching ignores case, for any letters. With history it searches the newest ${MAX_SCANNED_REQUESTS} requests of the window, and for text the newest ${MAX_SCANNED_LOG_LINES} lines of them, and says when it left some out.`,
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Text the message contains, in any case.",
            },
            level: {
              type: "string",
              enum: [...LOG_LEVELS],
              description: "Only lines of this level.",
            },
            service: {
              type: "string",
              description: "Only requests handled by this service.",
            },
            endpoint: {
              type: "string",
              description:
                'Only this endpoint, as list_requests shows it: "GET /api/pages/:id".',
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
              maximum: MAX_LOG_LIMIT,
              description: `Default ${DEFAULT_LOG_LIMIT}.`,
            },
            offset: {
              type: "integer",
              minimum: 0,
              description: "Lines to skip, to page through.",
            },
          },
          additionalProperties: false,
        },
        annotations: READ_ONLY,
      },
      run: (args) => searchLogs(sources, args),
    },
    {
      definition: {
        name: "list_reloads",
        description:
          'What the Reloads view shows, newest first: each time the app started, restarted or exited (kind "started", "restarting", "exited" or "contract-ready"), why, and which generation of the process it was, and the crashes of the process itself with their error and stack: a failed startup, an uncaught exception, an unhandled rejection. Check it when the app seems to restart or does not come up. Under `brick start` the dashboard sees only the process it runs in, so it lists the one start of that process and no crashes.',
        inputSchema: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: `Only events after this. ${TIME_HELP}`,
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_LIST_LIMIT,
              description: `Of each list. Default ${DEFAULT_LIST_LIMIT}.`,
            },
          },
          additionalProperties: false,
        },
        annotations: READ_ONLY,
      },
      run: (args) => listReloads(sources, args),
    },
  ];
}

export const LOG_TOOL_NAMES = ["search_logs", "list_reloads"] as const;
