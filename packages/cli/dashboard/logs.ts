import {
  ATTR,
  SPAN,
  type TraceSpan,
  type TraceSummary,
} from "../src/dashboard-protocol";

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVELS: readonly LogLevel[] = [
  "debug",
  "info",
  "warn",
  "error",
];

/** One line an action, tool, or endpoint logged while handling a request. */
export interface LogEntry {
  id: string;
  timeMs: number;
  level: LogLevel;
  message: string;
  traceId: string;
  /** The span it was logged in, such as `action users.create`. */
  span: string;
  /** The request: its route or path, and method. */
  route: string;
  method?: string;
}

/**
 * Lines are span events named `log` with `log.level` and `log.message`, which
 * `ctx.logger` in @brickkit/core writes. A span that kept only part of them
 * says how many it left out in `brick.logs.dropped`.
 */
const EVENT = SPAN.logEvent;

/**
 * Terminal colors and styles, which a line logged before capture removed them
 * (or by another emitter) may still carry; they show as stray characters here.
 */
// oxlint-disable no-control-regex
const ANSI =
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\))/g;
// oxlint-enable no-control-regex

function levelOf(value: unknown): LogLevel {
  return LOG_LEVELS.find((level) => level === value) ?? "info";
}

function entriesOf(
  trace: TraceSummary,
  span: TraceSpan,
  route: string,
): LogEntry[] {
  const entries: LogEntry[] = [];
  span.events.forEach((event, index) => {
    if (event.name !== EVENT) return;
    entries.push({
      id: `${trace.traceId}:${span.spanId}:${index}`,
      timeMs: event.timeMs,
      level: levelOf(event.attributes[ATTR.logLevel]),
      message: String(event.attributes[ATTR.logMessage] ?? "").replace(
        ANSI,
        "",
      ),
      traceId: trace.traceId,
      span: span.name,
      route,
      method: trace.method,
    });
  });
  return entries;
}

const routeOf = (trace: TraceSummary): string => {
  const wildcard = trace.route?.includes("*") && trace.path;
  return (wildcard ? trace.path : trace.route) ?? trace.name;
};

/** The lines of one request in the order they were logged, and how many were left out. */
export function logsOfTrace(trace: TraceSummary): {
  entries: LogEntry[];
  dropped: number;
} {
  const route = routeOf(trace);
  const entries: LogEntry[] = [];
  let dropped = 0;
  for (const span of trace.spans) {
    entries.push(...entriesOf(trace, span, route));
    const left = span.attributes[ATTR.logsDropped];
    if (typeof left === "number") dropped += left;
  }
  entries.sort((a, b) => a.timeMs - b.timeMs);
  return { entries, dropped };
}

/** The lines of all the requests given, newest first, up to `limit`. */
export function collectLogs(traces: TraceSummary[], limit = 1000): LogEntry[] {
  const all = traces.flatMap((trace) => logsOfTrace(trace).entries);
  all.sort((a, b) => b.timeMs - a.timeMs);
  return all.slice(0, limit);
}

const FIELDS = ["level", "route", "action", "method", "trace"] as const;
type Field = (typeof FIELDS)[number];

/** One condition of a search: a word or phrase anywhere, or a field's value. */
export interface LogMatcher {
  field?: Field;
  /** Lower case. */
  value: string;
  negate: boolean;
}

/**
 * A search is words that must all appear, `"an exact phrase"`, `-word` to
 * leave lines out, and `field:value` for one part of a line: `level:error`
 * (or `level:warn,error`), `route:/api/pages`, `action:pages.echo`,
 * `method:post`, `trace:2ef0d1` (the start of a trace id). Any of them can be
 * negated with `-`, and a value with spaces can be quoted: `route:"/a b"`.
 */
export function parseLogQuery(text: string): LogMatcher[] {
  const matchers: LogMatcher[] = [];
  for (const raw of text.match(/-?(?:[a-z]+:)?"[^"]*"|\S+/gi) ?? []) {
    let token = raw;
    let negate = false;
    if (token.length > 1 && token.startsWith("-")) {
      negate = true;
      token = token.slice(1);
    }
    let field: Field | undefined;
    const colon = token.indexOf(":");
    if (colon > 0) {
      const name = token.slice(0, colon).toLowerCase();
      const known = FIELDS.find((item) => item === name);
      if (known) {
        field = known;
        token = token.slice(colon + 1);
      }
    }
    token = token.replace(/^"/, "").replace(/"$/, "");
    // A field still being typed (`level:`) matches nothing yet; skip it.
    if (token) matchers.push({ field, value: token.toLowerCase(), negate });
  }
  return matchers;
}

function matches(entry: LogEntry, { field, value }: LogMatcher): boolean {
  switch (field) {
    case "level":
      return value.split(",").includes(entry.level);
    case "route":
      return entry.route.toLowerCase().includes(value);
    case "action":
      return entry.span.toLowerCase().includes(value);
    case "method":
      return entry.method?.toLowerCase() === value;
    case "trace":
      return entry.traceId.toLowerCase().startsWith(value);
    default:
      return `${entry.message} ${entry.route} ${entry.span}`
        .toLowerCase()
        .includes(value);
  }
}

/** The lines every condition of a search holds for. */
export function queryLogs(
  entries: LogEntry[],
  matchers: LogMatcher[],
): LogEntry[] {
  if (matchers.length === 0) return entries;
  return entries.filter((entry) =>
    matchers.every((matcher) => matches(entry, matcher) !== matcher.negate),
  );
}

export function countLevels(entries: LogEntry[]): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = {
    debug: 0,
    info: 0,
    warn: 0,
    error: 0,
  };
  for (const entry of entries) counts[entry.level]++;
  return counts;
}

/** What to mark in a message: the words and phrases a search is for. */
export function highlightTerms(matchers: LogMatcher[]): string[] {
  return matchers
    .filter((matcher) => !matcher.field && !matcher.negate)
    .map((matcher) => matcher.value);
}

/** A message in pieces, those that match one of `terms` marked as hits. */
export function highlight(
  message: string,
  terms: string[],
): { text: string; hit: boolean }[] {
  const needles = [...new Set(terms)]
    .sort((a, b) => b.length - a.length)
    .slice(0, 8)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (needles.length === 0) return [{ text: message, hit: false }];
  // The capture group keeps what matched, at the odd positions.
  return message
    .split(new RegExp(`(${needles.join("|")})`, "gi"))
    .map((text, index) => ({ text, hit: index % 2 === 1 }))
    .filter((part) => part.text !== "");
}
