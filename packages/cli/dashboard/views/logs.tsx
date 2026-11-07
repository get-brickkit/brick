import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Check,
  Copy,
  Crosshair,
  Pause,
  Play,
  Search,
  X,
} from "lucide-react";
import { LogLevelLabel } from "@/components/log-level";
import { Empty, PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatCount, formatTimestamp } from "@/format";
import { useStoredChoice } from "@/history";
import {
  collectLogs,
  countLevels,
  highlight,
  highlightTerms,
  LOG_LEVELS,
  parseLogQuery,
  queryLogs,
  type LogEntry,
  type LogLevel,
} from "@/logs";
import { cn } from "@/lib/utils";
import { routeHref, useNow } from "@/state";
import type { TraceSummary } from "../../src/dashboard-protocol";

/** The newest lines kept to search through. */
const LIMIT = 2000;
/** Rows drawn at first, and added by each "Show more". */
const PAGE = 150;
/** Messages longer than this fold to three lines, with a way to open them. */
const FOLD_LENGTH = 240;

const SINCE = [
  { value: "all", label: "All", ms: Infinity },
  { value: "5m", label: "5m", ms: 5 * 60_000 },
  { value: "15m", label: "15m", ms: 15 * 60_000 },
  { value: "1h", label: "1h", ms: 60 * 60_000 },
] as const;
type Since = (typeof SINCE)[number]["value"];
const SINCE_VALUES = SINCE.map((item) => item.value);

const LEVELS_KEY = "brick-dashboard-logs-levels";

/** The levels shown, kept across visits. All of them until chosen otherwise. */
function useStoredLevels(): [
  ReadonlySet<LogLevel>,
  (next: Set<LogLevel>) => void,
] {
  const [levels, setLevels] = useState<ReadonlySet<LogLevel>>(() => {
    const stored = localStorage.getItem(LEVELS_KEY);
    if (stored === null) return new Set(LOG_LEVELS);
    return new Set(
      LOG_LEVELS.filter((level) => stored.split(",").includes(level)),
    );
  });
  return [
    levels,
    (next) => {
      localStorage.setItem(LEVELS_KEY, [...next].join(","));
      setLevels(next);
    },
  ];
}

/** `query` with `token` added, unless it is already there. */
function withToken(query: string, token: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean);
  return words.includes(token) ? query : [...words, token].join(" ");
}

function Message({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlight(text, terms).map((part, index) =>
        part.hit ? (
          <mark
            key={index}
            className="rounded-[2px] bg-amber-300/70 px-px text-inherit dark:bg-amber-400/40"
          >
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

function RowAction({
  label,
  onClick,
  href,
  children,
}: {
  label: string;
  onClick?: () => void;
  href?: string;
  children: React.ReactNode;
}) {
  const className =
    "grid size-6 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-3.5";
  return href ? (
    <a href={href} aria-label={label} title={label} className={className}>
      {children}
    </a>
  ) : (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={className}
    >
      {children}
    </button>
  );
}

function Row({
  entry,
  terms,
  onOnlyRequest,
}: {
  entry: LogEntry;
  terms: string[];
  onOnlyRequest: (traceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const long =
    entry.message.length > FOLD_LENGTH || entry.message.split("\n").length > 3;
  return (
    <div className="group relative grid grid-cols-[104px_44px_minmax(0,1fr)_minmax(0,200px)] items-baseline gap-3 border-b px-4 py-2 last:border-b-0 hover:bg-muted/40 max-md:grid-cols-[96px_44px_minmax(0,1fr)]">
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        {formatTimestamp(entry.timeMs, false)}
      </span>
      <LogLevelLabel level={entry.level} />
      <div className="min-w-0">
        <div
          className={cn(
            "font-mono text-xs leading-[18px] [overflow-wrap:anywhere] whitespace-pre-wrap",
            long && !open && "line-clamp-3",
          )}
        >
          <Message text={entry.message} terms={terms} />
        </div>
        {long && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="mt-0.5 cursor-pointer text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {open ? "Show less" : "Show more"}
          </button>
        )}
      </div>
      <div className="min-w-0 max-md:hidden">
        <div className="truncate text-xs text-muted-foreground">
          {entry.method ? `${entry.method} ` : ""}
          {entry.route}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground/70">
          {entry.span}
        </div>
      </div>
      <div className="absolute top-1.5 right-2 flex items-center gap-0.5 rounded-md border bg-background p-0.5 opacity-0 shadow-xs group-focus-within:opacity-100 group-hover:opacity-100">
        <RowAction
          label={copied ? "Copied" : "Copy this line"}
          onClick={() => {
            void navigator.clipboard?.writeText(entry.message);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check /> : <Copy />}
        </RowAction>
        <RowAction
          label="Only lines of this request"
          onClick={() => onOnlyRequest(entry.traceId)}
        >
          <Crosshair />
        </RowAction>
        <RowAction
          label="Open the request"
          href={routeHref("requests", entry.traceId)}
        >
          <ArrowUpRight />
        </RowAction>
      </div>
    </div>
  );
}

/**
 * What actions, tools, and endpoints logged with `ctx.logger` (or `console`)
 * while handling this run's requests, newest first. Finding one line is the
 * point: a search with phrases, `level:`, `route:`, `action:`, and `trace:`,
 * counts at each level, how far back to look, and a pause so the list holds
 * still while it is read. Each line links to its request.
 */
export function LogsView({ traces }: { traces: TraceSummary[] }) {
  const live = useMemo(() => collectLogs(traces, LIMIT), [traces]);
  const [frozen, setFrozen] = useState<LogEntry[]>();
  const source = frozen ?? live;
  const fresh = useMemo(() => {
    if (!frozen) return 0;
    const seen = new Set(frozen.map((entry) => entry.id));
    return live.filter((entry) => !seen.has(entry.id)).length;
  }, [frozen, live]);

  const [query, setQuery] = useState("");
  const [levels, setLevels] = useStoredLevels();
  const [since, setSince] = useStoredChoice<Since>(
    "brick-dashboard-logs-since",
    SINCE_VALUES,
    "all",
  );
  const [limit, setLimit] = useState(PAGE);

  const now = useNow(since !== "all" && !frozen, 5000);
  const cutoff =
    now - (SINCE.find((item) => item.value === since)?.ms ?? Infinity);
  const recent = useMemo(
    () =>
      since === "all"
        ? source
        : source.filter((entry) => entry.timeMs >= cutoff),
    [source, since, cutoff],
  );
  const matchers = useMemo(() => parseLogQuery(query), [query]);
  const found = useMemo(() => queryLogs(recent, matchers), [recent, matchers]);
  const counts = useMemo(() => countLevels(found), [found]);
  const shown = useMemo(
    () => found.filter((entry) => levels.has(entry.level)),
    [found, levels],
  );
  const terms = useMemo(() => highlightTerms(matchers), [matchers]);
  const narrowed = query.trim() !== "" || levels.size < LOG_LEVELS.length;

  // A new search starts again from the first page.
  const search = (next: string) => {
    setQuery(next);
    setLimit(PAGE);
  };
  const clear = () => {
    search("");
    setLevels(new Set(LOG_LEVELS));
    setSince("all");
  };

  return (
    <>
      <PageHeader
        title="Logs"
        description="What actions and tools log, newest first"
        actions={
          <Button
            variant="outline"
            aria-pressed={frozen !== undefined}
            onClick={() => setFrozen(frozen ? undefined : live)}
          >
            {frozen ? <Play /> : <Pause />}
            {frozen
              ? fresh > 0
                ? `Resume (${formatCount(fresh)} new)`
                : "Resume"
              : "Pause"}
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            placeholder='Search: words, "exact phrase", level:error, route:/api, trace:2ef0…'
            aria-label="Search logs"
            className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
            onChange={(event) => search(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") search("");
            }}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => search("")}
              className="absolute top-1.5 right-1.5 grid size-5 cursor-pointer place-items-center rounded-sm text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
        <ToggleGroup
          variant="outline"
          spacing={2}
          aria-label="How far back"
          value={[since]}
          onValueChange={(next) => {
            const picked = SINCE_VALUES.find((item) => item === next[0]);
            if (picked) {
              setSince(picked);
              setLimit(PAGE);
            }
          }}
        >
          {SINCE.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value}>
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <ToggleGroup
          multiple
          variant="outline"
          spacing={2}
          aria-label="Levels"
          value={[...levels]}
          onValueChange={(next) => {
            setLevels(
              new Set(LOG_LEVELS.filter((level) => next.includes(level))),
            );
            setLimit(PAGE);
          }}
        >
          {LOG_LEVELS.map((level) => (
            <ToggleGroupItem key={level} value={level} className="gap-1.5">
              <span className="capitalize">{level}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatCount(counts[level])}
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        Words must all appear; <code className="font-mono">"in quotes"</code> is
        an exact phrase; <code className="font-mono">-word</code> leaves lines
        out. Fields: <code className="font-mono">level:</code>{" "}
        <code className="font-mono">route:</code>{" "}
        <code className="font-mono">action:</code>{" "}
        <code className="font-mono">method:</code>{" "}
        <code className="font-mono">trace:</code>
      </p>
      <Panel>
        {live.length === 0 && !frozen ? (
          <Empty
            title="Nothing logged yet"
            hint="Call ctx.logger.info(…) or console.log(…) in an action or tool, with telemetry on, and send a request that runs it"
          />
        ) : shown.length === 0 ? (
          <div className="grid place-items-center gap-3 px-4 py-12 text-center text-sm text-muted-foreground">
            <div>No lines match</div>
            {(narrowed || since !== "all") && (
              <Button variant="outline" size="sm" onClick={clear}>
                Clear search and filters
              </Button>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
              <span>
                {shown.length === source.length
                  ? `${formatCount(shown.length)} lines`
                  : `${formatCount(shown.length)} of ${formatCount(source.length)} lines`}
                {source.length === LIMIT &&
                  ` (the newest ${formatCount(LIMIT)})`}
              </span>
              {frozen && (
                <span>Paused: the list is not following new lines</span>
              )}
            </div>
            {shown.slice(0, limit).map((entry) => (
              <Row
                key={entry.id}
                entry={entry}
                terms={terms}
                onOnlyRequest={(traceId) =>
                  search(withToken(query, `trace:${traceId.slice(0, 8)}`))
                }
              />
            ))}
            {shown.length > limit && (
              <div className="flex justify-center border-t p-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLimit(limit + PAGE)}
                >
                  Show {formatCount(Math.min(PAGE, shown.length - limit))} more
                  of {formatCount(shown.length - limit)}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
    </>
  );
}
