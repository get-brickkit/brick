import type { Attributes } from "@opentelemetry/api";
import {
  SPAN,
  type FacetValue,
  type HistoryFacets,
  type HistorySummary,
  type HistoryTrace,
  type Outcome,
  type TraceSummary,
  type SpanEventRecord,
  type VolumeBucket,
} from "./dashboard-protocol";

/*
 * The request log's rules, as plain functions over rows: what a request's
 * outcome is, which rows a filter keeps, and the counts the log shows. The
 * page runs them over live requests; stored history runs the same rules in SQL
 * (dev-history.ts), and a test keeps the two in step.
 */

/** A response status at or above this is a server error; below it and at or above `CLIENT_ERROR`, a client error. */
export const SERVER_ERROR = 500;
export const CLIENT_ERROR = 400;

/** How a request ended: a 5xx or crash, a 4xx, or neither. */
export function outcomeOf(
  row: Pick<TraceSummary, "status" | "httpStatus">,
): Outcome {
  const http = row.httpStatus ?? 0;
  if (row.status === "error" || http >= SERVER_ERROR) return "server";
  if (http >= CLIENT_ERROR) return "client";
  return "ok";
}

/** "GET /api/page/:id" when the method and route are known, else the span name. */
export function endpointOf(
  trace: Pick<TraceSummary, "method" | "route" | "name">,
): string {
  return trace.method && trace.route
    ? `${trace.method} ${trace.route}`
    : trace.name;
}

/** A live request as a log row; the same shape the history API returns. */
export function toRow(trace: TraceSummary): HistoryTrace {
  const { spans: _spans, ...row } = trace;
  return { ...row, endpoint: endpointOf(trace) };
}

export const OUTCOMES: readonly Outcome[] = ["ok", "client", "server"];

/** A filter groups its values with OR; separate filters combine with AND. */
export interface RowFilters {
  endpoints?: string[];
  methods?: string[];
  services?: string[];
  outcomes?: Outcome[];
  /** Only requests at least this slow, in milliseconds. */
  minMs?: number;
  /** Matches the endpoint, path, span name, action or failure message. */
  query?: string;
  sort?: "recent" | "slowest";
}

export type Facet = keyof HistoryFacets;

/** The fields the search box looks in. */
export const SEARCHED: readonly (keyof HistoryTrace)[] = [
  "endpoint",
  "path",
  "name",
  "action",
  "message",
];

/** Whether `row` passes the filters, leaving out `skip` when counting its facet. */
export function matches(
  row: HistoryTrace,
  filters: RowFilters,
  skip?: Facet,
): boolean {
  const anyOf = (facet: Facet, values: string[] | undefined, value?: string) =>
    skip === facet ||
    !values?.length ||
    (value !== undefined && values.includes(value));
  if (!anyOf("endpoint", filters.endpoints, row.endpoint)) return false;
  if (!anyOf("method", filters.methods, row.method)) return false;
  if (!anyOf("service", filters.services, row.service)) return false;
  if (!anyOf("outcome", filters.outcomes, outcomeOf(row))) return false;
  if (
    filters.minMs !== undefined &&
    filters.minMs > 0 &&
    (row.durationMs ?? 0) < filters.minMs
  )
    return false;
  const needle = filters.query?.trim().toLowerCase();
  if (needle)
    return SEARCHED.some((field) =>
      String(row[field] ?? "")
        .toLowerCase()
        .includes(needle),
    );
  return true;
}

/** Newest first, or slowest first and then newest. */
export function compareRows(
  sort: RowFilters["sort"],
): (a: HistoryTrace, b: HistoryTrace) => number {
  return sort === "slowest"
    ? (a, b) =>
        (b.durationMs ?? 0) - (a.durationMs ?? 0) || b.startMs - a.startMs
    : (a, b) => b.startMs - a.startMs;
}

export function applyFilters(
  rows: HistoryTrace[],
  filters: RowFilters,
): HistoryTrace[] {
  return rows
    .filter((row) => matches(row, filters))
    .sort(compareRows(filters.sort));
}

/** The most values a facet lists. */
export const MAX_FACET_VALUES = 30;

const FACET_VALUE: Record<Facet, (row: HistoryTrace) => string | undefined> = {
  outcome: outcomeOf,
  method: (row) => row.method,
  service: (row) => row.service,
  endpoint: (row) => row.endpoint,
};

/** Counts for each filter, as if that filter were not applied. */
export function computeFacets(
  rows: HistoryTrace[],
  filters: RowFilters,
): HistoryFacets {
  const count = (facet: Facet): FacetValue[] => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!matches(row, filters, facet)) continue;
      const value = FACET_VALUE[facet](row);
      if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, total]) => ({ value, count: total }))
      .sort(
        (a, b) =>
          b.count - a.count ||
          (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
      )
      .slice(0, MAX_FACET_VALUES);
  };
  return {
    outcome: count("outcome"),
    method: count("method"),
    service: count("service"),
    endpoint: count("endpoint"),
  };
}

/** The width of each of `count` buckets across [from, to]: whole milliseconds, at least one. */
export const bucketSize = (from: number, to: number, count: number): number =>
  Math.max(Math.ceil((to - from) / count), 1);

/** Count rows into `count` equal time buckets across [from, to], by outcome. */
export function bucketRows(
  rows: HistoryTrace[],
  from: number,
  to: number,
  count: number,
): VolumeBucket[] {
  const size = bucketSize(from, to, count);
  const buckets: VolumeBucket[] = Array.from({ length: count }, (_, index) => ({
    start: from + index * size,
    ok: 0,
    client: 0,
    server: 0,
  }));
  for (const row of rows) {
    if (row.startMs < from || row.startMs > to) continue;
    const index = Math.floor((row.startMs - from) / size);
    buckets[Math.min(index, count - 1)]![outcomeOf(row)] += 1;
  }
  return buckets;
}

/** Linear-interpolated percentile of an ascending list; 0 for an empty list. */
export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (
    sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower)
  );
}

/** The numbers for the cards at the top of the log, for these requests. */
export function summarizeRows(rows: HistoryTrace[]): HistorySummary {
  let clientErrors = 0;
  let serverErrors = 0;
  const durations: number[] = [];
  for (const row of rows) {
    const outcome = outcomeOf(row);
    if (outcome === "client") clientErrors += 1;
    if (outcome === "server") serverErrors += 1;
    if (row.durationMs !== undefined) durations.push(row.durationMs);
  }
  durations.sort((a, b) => a - b);
  return {
    total: rows.length,
    clientErrors,
    serverErrors,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
  };
}

const CSV_COLUMNS = [
  "time",
  "method",
  "route",
  "path",
  "status",
  "outcome",
  "duration_ms",
  "service",
  "action",
  "message",
  "trace_id",
] as const;

function csvCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  const text = String(value);
  // Quote anything a spreadsheet could split on, and defuse formulas.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Requests as CSV with a header row, for the dashboard's export. */
export function tracesToCsv(traces: HistoryTrace[]): string {
  const lines = traces.map((trace) =>
    [
      new Date(trace.startMs).toISOString(),
      trace.method,
      trace.route,
      trace.path,
      trace.httpStatus ?? trace.status,
      outcomeOf(trace),
      trace.durationMs === undefined ? undefined : trace.durationMs.toFixed(3),
      trace.service,
      trace.action,
      trace.message,
      trace.traceId,
    ]
      .map(csvCell)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...lines].join("\n") + "\n";
}

/** A string attribute, or undefined when it is missing or of another type. */
export function stringAttribute(
  attributes: Attributes | undefined,
  key: string,
): string | undefined {
  const value = attributes?.[key];
  return typeof value === "string" ? value : undefined;
}

/** The attributes of the exception a span recorded, if it recorded one. */
export function findException(
  events: SpanEventRecord[],
): Attributes | undefined {
  return events.find((event) => event.name === SPAN.exceptionEvent)?.attributes;
}

/** The span that ran the request's action, when it ran one. */
export function actionSpan<T extends { name: string }>(
  spans: readonly T[],
): T | undefined {
  return spans.find((span) => span.name.startsWith(SPAN.actionPrefix));
}
