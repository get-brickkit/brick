import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Activity,
  Download,
  Gauge,
  ListFilter,
  RefreshCw,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { FacetPanel } from "@/components/facet-panel";
import { Metric } from "@/components/metric";
import { Empty } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { RequestDrawer } from "@/components/request-drawer";
import { routeLabel } from "@/components/route-label";
import { TimelineStrip } from "@/components/timeline-strip";
import { TimeRangePicker } from "@/components/time-range-picker";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  hasFilters,
  historyParams,
  NO_FILTERS,
  sparkGroups,
  type LogFilters,
  type LogRow,
} from "@/filters";
import {
  formatCount,
  formatDuration,
  formatPercent,
  formatTimestamp,
} from "@/format";
import {
  RANGES,
  rangeMs,
  useHistoryTrace,
  useRequestLog,
  useStoredChoice,
  type RangeValue,
  type Window,
} from "@/history";
import { cn } from "@/lib/utils";
import { routeHref, useNow } from "@/state";
import {
  applyFilters,
  bucketRows,
  computeFacets,
  outcomeOf,
  summarizeRows,
  toRow,
  tracesToCsv,
} from "../../src/dashboard-query";
import { historyUrl, type TraceSummary } from "../../src/dashboard-protocol";

type RangeChoice = "live" | RangeValue;
const CHOICES: readonly RangeChoice[] = ["live", ...RANGES.map((r) => r.value)];

const LIVE_WINDOW_MS = 15 * 60_000;
const LIVE_BUCKETS = 60;

const SORTS: { value: LogFilters["sort"]; label: string }[] = [
  { value: "recent", label: "Newest" },
  { value: "slowest", label: "Slowest" },
];

const OUTCOME_TEXT = {
  ok: "text-positive",
  client: "text-destructive",
  server: "text-destructive",
} as const;

/** Debounce typing so each keystroke does not query the database. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <span className={cn("truncate", right && "text-right")}>{children}</span>
  );
}

/** The log's columns; the time is wider when it carries a date. */
const columns = (withDate: boolean) =>
  withDate
    ? "grid-cols-[150px_minmax(0,84px)_minmax(0,1.2fr)_64px_minmax(0,1fr)] max-md:grid-cols-[130px_minmax(0,76px)_minmax(0,1fr)_60px]"
    : "grid-cols-[104px_minmax(0,84px)_minmax(0,1.2fr)_64px_minmax(0,1fr)] max-md:grid-cols-[96px_minmax(0,76px)_minmax(0,1fr)_60px]";

/**
 * Every request the app has served, live or from history, in one list with
 * filters on the left, a timeline on top, and the selected request beside it.
 */
export function RequestsView({
  traces,
  historyDays,
  selectedId,
  activity,
  filterRef,
}: {
  /** Requests from this run, newest first, including ones still running. */
  traces: TraceSummary[];
  /** Days of requests kept on disk; zero when history is off. */
  historyDays: number;
  selectedId: string | undefined;
  /** Changes when the app finishes a request, so history can catch up. */
  activity: string;
  filterRef: RefObject<HTMLInputElement | null>;
}) {
  const lookBack = historyDays > 0;
  const [choice, setChoice] = useStoredChoice<RangeChoice>(
    "brick-dashboard-requests-range",
    CHOICES,
    "live",
  );
  const [custom, setCustom] = useState<Window>();
  const [filters, setFilters] = useState<LogFilters>(NO_FILTERS);
  const [typed, setTyped] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const query = useDebounced(typed, 250);
  const applied = useMemo(() => ({ ...filters, query }), [filters, query]);

  // A chosen time is looked up in history, whatever range is picked beside it.
  const live = (choice === "live" && !custom) || !lookBack;
  const now = useNow(live, 1000);

  // Live: this run's requests, filtered here.
  const liveRows = useMemo(() => traces.map(toRow), [traces]);
  const liveShown = useMemo(
    () => applyFilters(liveRows, applied),
    [liveRows, applied],
  );
  const liveFacets = useMemo(
    () => computeFacets(liveRows, applied),
    [liveRows, applied],
  );
  // The strip covers the last few minutes, or further back to reach the oldest
  // request still listed.
  const liveStart = Math.min(
    now - LIVE_WINDOW_MS,
    ...liveShown.map((row) => row.startMs),
  );
  const liveFrame = { from: liveStart, to: now };
  const liveVolume = useMemo(
    () => bucketRows(liveShown, liveStart, now, LIVE_BUCKETS),
    [liveShown, liveStart, now],
  );

  // History: the same, filtered by the database.
  const log = useRequestLog(
    {
      spanMs: choice === "live" ? rangeMs("7d") : rangeMs(choice),
      fixed: custom,
      enabled: !live,
    },
    applied,
    activity,
  );

  const rows = live ? liveShown : log.rows;
  const total = live ? liveShown.length : log.total;
  const facets = live ? liveFacets : log.facets;
  const volume = live ? liveVolume : log.volume;
  const frame = live ? liveFrame : log.window;
  const liveSummary = useMemo(() => summarizeRows(liveShown), [liveShown]);
  const summary = live ? liveSummary : log.summary;
  const sparks = useMemo(() => sparkGroups(volume), [volume]);
  // Times carry a date once the list reaches back past today.
  const longWindow = frame.to - frame.from > 12 * 3_600_000;
  const filtered = hasFilters(applied);
  const range = RANGES.find((item) => item.value === choice);
  const scope = live
    ? "in this run"
    : custom
      ? "in the chosen time"
      : `in the last ${range?.text ?? "week"}`;
  const noRequests = !summary || summary.total === 0;
  const failures = summary ? summary.clientErrors + summary.serverErrors : 0;

  const liveTrace = traces.find((trace) => trace.traceId === selectedId);
  const fetched = useHistoryTrace(selectedId, lookBack && !liveTrace);
  const trace = liveTrace ?? fetched.trace;
  const selectedRow =
    rows.find((row) => row.traceId === selectedId) ??
    (liveTrace ? toRow(liveTrace) : undefined);

  useEffect(() => {
    if (!selectedId) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      location.hash = routeHref("requests");
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [selectedId]);

  const pick = (next: RangeChoice) => {
    setChoice(next);
    setCustom(undefined);
  };
  const clearAll = () => {
    setFilters({ ...NO_FILTERS, sort: filters.sort });
    setTyped("");
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          className="lg:hidden"
          aria-expanded={showFilters}
          onClick={() => setShowFilters((current) => !current)}
        >
          <ListFilter />
          Filters
        </Button>
        <Input
          ref={filterRef}
          type="search"
          placeholder="Search by route, path, action, or message"
          aria-label="Search requests"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="min-w-40 flex-1"
        />
        {lookBack && (
          <ToggleGroup
            variant="outline"
            spacing={2}
            aria-label="Time range"
            value={custom ? [] : [choice]}
            onValueChange={(next) => {
              const picked = CHOICES.find((item) => item === next[0]);
              if (picked) pick(picked);
            }}
          >
            <ToggleGroupItem value="live">
              <i
                className={cn(
                  "size-1.5 rounded-full",
                  choice === "live" && !custom
                    ? "animate-pulse bg-positive"
                    : "bg-muted-foreground/60",
                )}
              />
              Live
            </ToggleGroupItem>
            {RANGES.filter(
              (item) => item.ms <= historyDays * 86_400_000 + 1,
            ).map((item) => (
              <ToggleGroupItem key={item.value} value={item.value}>
                {item.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        {lookBack && (
          <TimeRangePicker
            value={custom}
            historyDays={historyDays}
            onApply={setCustom}
            onClear={() => setCustom(undefined)}
          />
        )}
        {!live && (
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh requests"
            onClick={log.refresh}
          >
            <RefreshCw />
          </Button>
        )}
        {live ? (
          <Button
            variant="outline"
            disabled={liveShown.length === 0}
            onClick={() =>
              download("brick-requests.csv", tracesToCsv(liveShown))
            }
          >
            <Download />
            Export
          </Button>
        ) : (
          <a
            download
            href={historyUrl("export", historyParams(frame, applied))}
            className={buttonVariants({ variant: "outline" })}
          >
            <Download />
            Export
          </a>
        )}
      </div>
      {!lookBack && (
        <p className="-mt-2 text-xs text-muted-foreground">
          Showing this run's requests. Start the dashboard with history on to
          look back over earlier ones.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metric
          icon={<Activity />}
          label="Requests"
          value={summary ? formatCount(summary.total) : "—"}
          note={filtered ? `${scope}, matching filters` : scope}
          spark={sparks.requests}
        />
        <Metric
          icon={<TriangleAlert />}
          label="Error rate"
          value={
            summary && !noRequests
              ? formatPercent(failures / summary.total)
              : "—"
          }
          note={
            summary && !noRequests
              ? `${formatCount(summary.serverErrors)} server, ${formatCount(summary.clientErrors)} client`
              : undefined
          }
          spark={sparks.errors}
        />
        <Metric
          icon={<Timer />}
          label="Median duration"
          value={
            summary && !noRequests ? formatDuration(summary.medianMs) : "—"
          }
          note="of these requests"
        />
        <Metric
          icon={<Gauge />}
          label="Slowest 5%"
          value={summary && !noRequests ? formatDuration(summary.p95Ms) : "—"}
          note="95th percentile"
        />
      </div>
      <Panel>
        <TimelineStrip
          buckets={volume}
          from={frame.from}
          to={frame.to}
          total={total}
          onBrush={live ? undefined : (from, to) => setCustom({ from, to })}
        />
      </Panel>
      <div
        className={cn(
          "grid items-start gap-4 lg:grid-cols-[230px_minmax(0,1fr)]",
          selectedId && "xl:grid-cols-[230px_minmax(0,1fr)_440px]",
        )}
      >
        <div
          className={cn(
            "lg:sticky lg:top-18 lg:max-h-[calc(100vh-6rem)] lg:overflow-auto",
            !showFilters && "max-lg:hidden",
          )}
        >
          <FacetPanel
            facets={facets}
            filters={filters}
            onChange={(next) => setFilters(next)}
          />
        </div>
        <Panel>
          <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              {log.failed && !live
                ? "Could not load history"
                : `${formatCount(rows.length)} of ${formatCount(total)} requests`}
              {live && ` in this run`}
            </span>
            <ToggleGroup
              variant="outline"
              spacing={2}
              aria-label="Order"
              value={[filters.sort]}
              onValueChange={(next) => {
                const picked = SORTS.find((item) => item.value === next[0]);
                if (picked) setFilters({ ...filters, sort: picked.value });
              }}
            >
              {SORTS.map((item) => (
                <ToggleGroupItem key={item.value} value={item.value}>
                  {item.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div
            className={cn(
              "grid gap-3 border-b px-4 py-2 text-xs text-muted-foreground",
              columns(longWindow),
            )}
          >
            <Th>Time</Th>
            <Th>Status</Th>
            <Th>Request</Th>
            <Th right>Took</Th>
            <span className="truncate max-md:hidden">Details</span>
          </div>
          {rows.length === 0 ? (
            <>
              <Empty
                title={
                  !live && log.loading
                    ? "Loading requests"
                    : filtered
                      ? "No requests match these filters"
                      : live
                        ? "No requests yet"
                        : "No requests in this range"
                }
                hint={
                  !log.loading && !filtered && live
                    ? "Call your API and it will show up here."
                    : undefined
                }
              />
              {filtered && (
                <div className="flex justify-center pb-10">
                  <Button variant="outline" size="sm" onClick={clearAll}>
                    Clear filters
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div
              className="max-h-[calc(100vh-12rem)] min-h-60 overflow-auto"
              role="list"
            >
              {rows.map((row) => (
                <RequestRow
                  key={row.traceId}
                  row={row}
                  withDate={longWindow}
                  selected={row.traceId === selectedId}
                />
              ))}
            </div>
          )}
          {!live && rows.length < total && (
            <div className="flex justify-center border-t p-2">
              <Button variant="outline" size="sm" onClick={log.more}>
                Show more
              </Button>
            </div>
          )}
        </Panel>
        {selectedId && (
          <div
            aria-hidden
            className="fixed inset-0 z-30 bg-background/60 backdrop-blur-sm xl:hidden"
            onClick={() => {
              location.hash = routeHref("requests");
            }}
          />
        )}
        {selectedId && (
          <RequestDrawer
            row={selectedRow}
            trace={trace}
            missing={!trace && !liveTrace && (fetched.missing || !lookBack)}
            now={now}
            onClose={() => {
              location.hash = routeHref("requests");
            }}
            className="fixed inset-y-0 right-0 z-40 w-[min(100vw,440px)] shadow-xl xl:sticky xl:top-18 xl:z-auto xl:max-h-[calc(100vh-6rem)] xl:w-auto xl:shadow-none"
          />
        )}
      </div>
    </>
  );
}

function RequestRow({
  row,
  withDate,
  selected,
}: {
  row: LogRow;
  withDate: boolean;
  selected: boolean;
}) {
  const outcome = outcomeOf(row);
  const running = row.status === "running";
  return (
    <a
      role="listitem"
      href={routeHref("requests", row.traceId)}
      data-selected={selected}
      className={cn(
        "grid min-h-9 items-center gap-3 border-b px-4 text-sm last:border-b-0 hover:bg-muted/50 data-[selected=true]:bg-muted",
        columns(withDate),
      )}
    >
      <span className="truncate font-mono text-xs text-muted-foreground tabular-nums">
        {formatTimestamp(row.startMs, withDate)}
      </span>
      <span className="flex items-baseline gap-1.5 font-mono text-xs">
        <span className="text-muted-foreground">{row.method}</span>
        {running ? (
          <i className="inline-block size-1.5 animate-pulse self-center rounded-full bg-foreground" />
        ) : (
          <span className={OUTCOME_TEXT[outcome]}>
            {row.httpStatus ?? row.status}
          </span>
        )}
      </span>
      <span className="truncate" title={routeLabel(row)}>
        {routeLabel(row)}
      </span>
      <span className="text-right text-xs text-muted-foreground tabular-nums">
        {formatDuration(row.durationMs)}
      </span>
      <span
        className={cn(
          "truncate text-xs max-md:hidden",
          row.message ? "text-destructive" : "text-muted-foreground",
        )}
        title={row.message}
      >
        {row.message ??
          (row.service
            ? `${row.service}${row.action ? `.${row.action}` : ""}`
            : "")}
      </span>
    </a>
  );
}
