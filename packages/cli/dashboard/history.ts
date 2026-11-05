import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { historyParams, type LogFilters, type LogRow } from "@/filters";
import {
  HISTORY_PAGE_SIZE,
  historyTraceUrl,
  historyUrl,
  type HistoryFacets,
  type HistoryResponses,
  type HistorySummary,
  type TraceSummary,
  type VolumeBucket,
} from "../src/dashboard-protocol";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const RANGES = [
  { value: "1h", label: "1H", ms: HOUR, text: "hour" },
  { value: "24h", label: "24H", ms: DAY, text: "24 hours" },
  { value: "7d", label: "7D", ms: 7 * DAY, text: "7 days" },
  { value: "30d", label: "30D", ms: 30 * DAY, text: "30 days" },
  { value: "90d", label: "90D", ms: 90 * DAY, text: "90 days" },
] as const;

export type RangeValue = (typeof RANGES)[number]["value"];

export const rangeMs = (range: RangeValue): number =>
  (RANGES.find((item) => item.value === range) ?? RANGES[2]).ms;

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${response.status}`);
  return (await response.json()) as T;
}

/** A history query, typed by what its endpoint answers. */
const getHistory = <K extends keyof HistoryResponses>(
  endpoint: K,
  params: URLSearchParams,
  signal: AbortSignal,
) => getJson<HistoryResponses[K]>(historyUrl(endpoint, params), signal);

/** A choice kept across visits, limited to the values this view offers. */
export function useStoredChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [choice, setChoice] = useState<T>(() => {
    const stored = localStorage.getItem(key);
    return allowed.includes(stored as T) ? (stored as T) : fallback;
  });
  return [
    choice,
    (next) => {
      localStorage.setItem(key, next);
      setChoice(next);
    },
  ];
}

export interface Window {
  from: number;
  to: number;
}

/**
 * A window that ends now and reaches back `spanMs`, or a fixed one. A new
 * `tick` moves a moving window forward to the present.
 */
function useWindow(
  spanMs: number,
  fixed: Window | undefined,
  tick: number,
): Window {
  return useMemo(() => {
    if (fixed) return fixed;
    const to = Date.now();
    return { from: to - spanMs, to };
    // `tick` is the request to move the window to the present.
  }, [spanMs, fixed, tick]);
}

/** Ask for a refresh a moment after the app finishes something new. */
function useCatchUp(activity: string, refresh: () => void): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const timer = setTimeout(refresh, 1500);
    return () => clearTimeout(timer);
  }, [activity, refresh]);
}

export interface RequestLog {
  window: Window;
  rows: LogRow[];
  total: number;
  facets: HistoryFacets | undefined;
  volume: VolumeBucket[] | undefined;
  summary: HistorySummary | undefined;
  loading: boolean;
  failed: boolean;
  more: () => void;
  refresh: () => void;
}

/**
 * The stored requests in a window that match the filters: a page of rows with
 * a total, the counts for each filter, and volume over time. It follows the
 * app, refreshing a moment after `activity` changes.
 */
export function useRequestLog(
  options: { spanMs: number; fixed?: Window; enabled: boolean },
  filters: LogFilters,
  activity: string,
): RequestLog {
  const { spanMs, fixed, enabled } = options;
  const [tick, setTick] = useState(0);
  const window = useWindow(spanMs, fixed, tick);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [facets, setFacets] = useState<HistoryFacets>();
  const [volume, setVolume] = useState<VolumeBucket[]>();
  const [summary, setSummary] = useState<HistorySummary>();
  const [loading, setLoading] = useState(enabled);
  const [failed, setFailed] = useState(false);
  const offset = useRef(0);

  const filterKey = JSON.stringify(filters);
  const latest = useRef({ window, filters, key: "" });
  latest.current = { window, filters, key: `${window.to}:${filterKey}` };

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const { signal } = controller;
    setLoading(true);
    offset.current = 0;
    const query = historyParams(window, filters);
    getHistory(
      "traces",
      historyParams(window, filters, { offset: 0 }),
      signal,
    ).then(
      (next) => {
        setRows(next.traces);
        setTotal(next.total);
        setLoading(false);
        setFailed(false);
      },
      () => {
        if (signal.aborted) return;
        setLoading(false);
        setFailed(true);
      },
    );
    // Counts and volume are secondary; a miss leaves the last ones showing.
    getHistory("facets", query, signal).then(setFacets, () => {});
    getHistory("volume", query, signal).then(setVolume, () => {});
    getHistory("summary", query, signal).then(setSummary, () => {});
    return () => controller.abort();
    // `filters` is compared by value through `filterKey`.
  }, [enabled, window, filterKey]);

  const more = useCallback(() => {
    const { window, filters, key } = latest.current;
    const next = offset.current + HISTORY_PAGE_SIZE;
    offset.current = next;
    void getHistory(
      "traces",
      historyParams(window, filters, { offset: next }),
      new AbortController().signal,
    ).then(
      // Drop a page that arrives after the filters or window have changed.
      (page) => {
        if (latest.current.key === key)
          setRows((current) => [...current, ...page.traces]);
      },
      () => setFailed(true),
    );
  }, []);

  const refresh = useCallback(() => setTick((value) => value + 1), []);
  useCatchUp(enabled ? activity : "", refresh);

  return {
    window,
    rows,
    total,
    facets,
    volume,
    summary,
    loading,
    failed,
    more,
    refresh,
  };
}

/** One stored request with its spans; undefined until it loads. */
export function useHistoryTrace(
  traceId: string | undefined,
  enabled: boolean,
): { trace: TraceSummary | undefined; missing: boolean } {
  const [state, setState] = useState<{
    id: string;
    trace: TraceSummary | undefined;
    missing: boolean;
  }>();
  useEffect(() => {
    if (!traceId || !enabled) return;
    const controller = new AbortController();
    getJson<TraceSummary>(historyTraceUrl(traceId), controller.signal).then(
      (trace) => setState({ id: traceId, trace, missing: false }),
      () => {
        if (!controller.signal.aborted)
          setState({ id: traceId, trace: undefined, missing: true });
      },
    );
    return () => controller.abort();
  }, [traceId, enabled]);
  // Never show another request's spans while this one loads.
  if (state && traceId !== undefined && state.id === traceId) {
    return { trace: state.trace, missing: state.missing };
  }
  return { trace: undefined, missing: false };
}
