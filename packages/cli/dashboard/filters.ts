import {
  HISTORY_PAGE_SIZE,
  type HistoryTrace,
  type Outcome,
  type VolumeBucket,
} from "../src/dashboard-protocol";
import type { RowFilters } from "../src/dashboard-query";

/** One line in the request log: a request without its spans. */
export type LogRow = HistoryTrace;

/** The log's filters, as the page holds them: every one present. */
export interface LogFilters extends RowFilters {
  query: string;
  outcomes: Outcome[];
  methods: string[];
  services: string[];
  endpoints: string[];
  sort: "recent" | "slowest";
}

export const NO_FILTERS: LogFilters = {
  query: "",
  outcomes: [],
  methods: [],
  services: [],
  endpoints: [],
  sort: "recent",
};

export function hasFilters(filters: LogFilters): boolean {
  return (
    filters.query.trim() !== "" ||
    filters.outcomes.length > 0 ||
    filters.methods.length > 0 ||
    filters.services.length > 0 ||
    filters.endpoints.length > 0 ||
    filters.minMs !== undefined
  );
}

/** The query string the history API takes for a window, filters, and page. */
export function historyParams(
  window: { from: number; to: number },
  filters: LogFilters,
  page?: { offset: number },
): URLSearchParams {
  const params = new URLSearchParams({
    from: String(window.from),
    to: String(window.to),
  });
  for (const endpoint of filters.endpoints) params.append("endpoint", endpoint);
  for (const method of filters.methods) params.append("method", method);
  for (const service of filters.services) params.append("service", service);
  for (const outcome of filters.outcomes) params.append("outcome", outcome);
  if (filters.minMs !== undefined) params.set("minMs", String(filters.minMs));
  if (filters.query.trim()) params.set("q", filters.query.trim());
  if (filters.sort !== "recent") params.set("sort", filters.sort);
  if (page) {
    params.set("limit", String(HISTORY_PAGE_SIZE));
    params.set("offset", String(page.offset));
  }
  return params;
}

/** Volume folded into a few columns for a card's miniature chart, oldest first. */
export function sparkGroups(
  volume: VolumeBucket[] | undefined,
  groups = 8,
): { requests: number[]; errors: number[] } {
  const list = volume ?? [];
  const size = Math.ceil(list.length / groups) || 1;
  const fold = (pick: (bucket: VolumeBucket) => number) =>
    Array.from({ length: groups }, (_, group) =>
      list
        .slice(group * size, (group + 1) * size)
        .reduce((sum, bucket) => sum + pick(bucket), 0),
    );
  return {
    requests: fold((bucket) => bucket.ok + bucket.client + bucket.server),
    errors: fold((bucket) => bucket.client + bucket.server),
  };
}
