import {
  compactJson,
  cut,
  DAY,
  integer,
  iso,
  READ_ONLY,
  text,
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
import { MAX_SCANNED_REQUESTS } from "./dev-history";

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

/** What the Logs view lists, and what the Reloads view lists. */
export function logTools(sources: McpSources): BuiltInTool[] {
  return [
    {
      definition: {
        name: "search_logs",
        description: `Log lines written with ctx.logger or console during requests, newest first: time, level, message, trace id, endpoint and the span that wrote it. Search by text and level, then open a trace id with get_trace for the whole request. The window is on when the request started (default: the last 24 hours). Text matching ignores case, and for non-ASCII letters only when history is off. With history it searches the newest ${MAX_SCANNED_REQUESTS} requests of the window, and says when it left some out.`,
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
  ];
}

export const LOG_TOOL_NAMES = ["search_logs"] as const;
