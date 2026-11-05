import { useContext, useState, type ReactNode } from "react";
import { ExtensionBoundary, ExtensionContext } from "@/extension";
import { Check, Copy, X } from "lucide-react";
import { Waterfall } from "@/components/waterfall";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  describeTrace,
  formatDateTime,
  formatDuration,
  formatTimestamp,
  isFailure,
} from "@/format";
import type { LogRow } from "@/filters";
import { cn } from "@/lib/utils";
import { LogLevelLabel } from "@/components/log-level";
import { logsOfTrace } from "@/logs";
import { requestReport } from "@/request-report";
import { routeLabel } from "@/components/route-label";
import type { TraceSummary } from "../../src/dashboard-protocol";

function Fact({
  label,
  children,
  mono,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b px-3 py-2 text-sm last:border-b-0">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span
        className={cn(
          "min-w-0 text-right [overflow-wrap:anywhere]",
          mono && "font-mono text-xs",
        )}
      >
        {children}
      </span>
    </div>
  );
}

/** One moment in the request, joined to the next by a line. */
function Step({
  tone,
  title,
  aside,
  children,
}: {
  tone: "muted" | "ok" | "failed";
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="relative pb-3 pl-6 last:pb-0 before:absolute before:top-3 before:bottom-0 before:left-[5px] before:w-px before:bg-border last:before:hidden">
      <i
        className={cn(
          "absolute top-1.5 left-0 size-[11px] rounded-full border-2 bg-background",
          tone === "ok" && "border-positive bg-positive",
          tone === "failed" && "border-destructive bg-destructive",
          tone === "muted" && "border-muted-foreground/60",
        )}
      />
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium">{title}</span>
        {aside && (
          <span className="text-right text-xs text-muted-foreground tabular-nums">
            {aside}
          </span>
        )}
      </div>
      {children && <div className="mt-2 border bg-card">{children}</div>}
    </div>
  );
}

/** Copies what `getValue` returns when pressed, so it is built only then. */
function CopyButton({
  getValue,
  label,
  size = "icon",
  disabled,
}: {
  getValue: () => string;
  label: string;
  size?: "icon" | "icon-xs";
  disabled?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size={size}
      disabled={disabled}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => {
        void navigator.clipboard?.writeText(getValue());
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

/**
 * Everything about one request, beside the list: when it started, what ran,
 * how it ended, and its spans. `row` is what the list already knows, shown
 * while the spans load.
 */
export function RequestDrawer({
  row,
  trace,
  missing,
  now,
  onClose,
  className,
}: {
  row: LogRow | undefined;
  trace: TraceSummary | undefined;
  /** The request is no longer kept anywhere. */
  missing: boolean;
  now: number;
  onClose: () => void;
  className?: string;
}) {
  const source = trace ?? row;
  const failed = source ? isFailure(source) : false;
  const breakdown = trace ? describeTrace(trace) : undefined;
  const logs = trace ? logsOfTrace(trace) : undefined;
  const label = source ? routeLabel(source) : "Request";
  const duration = source?.durationMs;
  // The extension's tabs, beside Details.
  const { extension, context } = useContext(ExtensionContext);
  const tabs = extension?.slots?.["request.drawer.tabs"] ?? [];
  const [tabId, setTabId] = useState<string>();
  const tab = tabs.find((item) => item.id === tabId);
  const Tab = tab?.component;

  return (
    <aside
      aria-label="Request details"
      className={cn("flex flex-col border bg-background", className)}
    >
      <header className="flex items-center gap-1 border-b p-2 pl-3">
        {source?.method && (
          <Badge variant="outline" className="font-mono">
            {source.method}
          </Badge>
        )}
        <span
          className="min-w-0 flex-1 truncate pl-1 font-mono text-sm"
          title={label}
        >
          {label}
        </span>
        {source && (
          <CopyButton
            getValue={() =>
              requestReport(source, trace, { loading: !trace && !missing })
            }
            label="Copy everything about this request"
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close details"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      {tabs.length > 0 && (
        <div role="tablist" className="flex gap-1 border-b px-2">
          {[{ id: undefined, label: "Details" }, ...tabs].map((item) => (
            <button
              key={item.id ?? ""}
              type="button"
              role="tab"
              aria-selected={item.id === tab?.id}
              onClick={() => setTabId(item.id)}
              className="-mb-px border-b-2 border-transparent px-2 py-2 text-xs font-medium text-muted-foreground hover:text-foreground aria-selected:border-foreground aria-selected:text-foreground"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
      {Tab && (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <ExtensionBoundary key={tab.id} name={`drawer tab "${tab.id}"`}>
            <Tab {...context} request={trace} />
          </ExtensionBoundary>
        </div>
      )}
      <div className={cn("min-h-0 flex-1 overflow-auto", Tab && "hidden")}>
        {source ? (
          <>
            <div className="border-b p-3">
              <Step
                tone="muted"
                title="Request started"
                aside={`${formatDateTime(source.startMs)}.${String(
                  Math.floor(source.startMs % 1000),
                ).padStart(3, "0")}`}
              />
            </div>
            <div className="border-b">
              <Fact label="Trace ID" mono>
                <span className="inline-flex items-center gap-1">
                  {source.traceId}
                  <CopyButton
                    getValue={() => source.traceId}
                    label="Copy trace ID"
                    size="icon-xs"
                  />
                </span>
              </Fact>
              {source.route && (
                <Fact label="Route" mono>
                  {source.route}
                </Fact>
              )}
              {source.path && source.path !== source.route && (
                <Fact label="Path" mono>
                  {source.path}
                </Fact>
              )}
              <Fact label="Status">
                <span className={failed ? "text-destructive" : "text-positive"}>
                  {source.httpStatus ?? source.status}
                </span>
              </Fact>
              <Fact label="Duration">{formatDuration(duration)}</Fact>
              {source.service && (
                <Fact label="Handled by" mono>
                  {source.service}
                  {source.action ? `.${source.action}` : ""}
                </Fact>
              )}
            </div>
            {breakdown && (
              <div className="border-b p-3">
                {breakdown.action && (
                  <Step tone="muted" title="Action">
                    <Fact label="Name" mono>
                      {breakdown.action.name.replace(/^action /, "")}
                    </Fact>
                    <Fact label="Duration">
                      {formatDuration(
                        breakdown.action.endMs === undefined
                          ? undefined
                          : breakdown.action.endMs - breakdown.action.startMs,
                      )}
                    </Fact>
                  </Step>
                )}
                {breakdown.calls.length > 0 && (
                  <Step
                    tone="muted"
                    title="Service calls"
                    aside={`${breakdown.calls.length}`}
                  >
                    {breakdown.calls.map((call) => (
                      <Fact
                        key={call.spanId}
                        label={call.name.replace(/^rpc /, "")}
                        mono
                      >
                        {formatDuration(
                          call.endMs === undefined
                            ? undefined
                            : call.endMs - call.startMs,
                        )}
                      </Fact>
                    ))}
                  </Step>
                )}
                {breakdown.queries.count > 0 && (
                  <Step tone="muted" title="Database">
                    <Fact label="Queries">{breakdown.queries.count}</Fact>
                    <Fact label="Total time">
                      {formatDuration(breakdown.queries.totalMs)}
                    </Fact>
                    <Fact label="Slowest">
                      {formatDuration(breakdown.queries.slowestMs)}
                    </Fact>
                  </Step>
                )}
                <Step
                  tone={failed ? "failed" : "ok"}
                  title={
                    trace?.status === "running"
                      ? "Response in progress"
                      : `Response finished in ${formatDuration(duration)}`
                  }
                  aside={
                    trace?.endMs === undefined
                      ? undefined
                      : formatTimestamp(trace.endMs, false)
                  }
                />
              </div>
            )}
            {(breakdown?.exception || source.message) && (
              <div className="border-b p-3">
                <div className="mb-2 text-sm font-medium text-destructive">
                  {breakdown?.exception?.code ?? "Error"}
                </div>
                <p className="text-sm [overflow-wrap:anywhere]">
                  {breakdown?.exception?.message ?? source.message}
                </p>
                {breakdown?.exception?.stack && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Stack trace
                    </summary>
                    <pre className="mt-2 max-h-60 overflow-auto border bg-muted/50 p-3 font-mono text-xs leading-[18px] [overflow-wrap:anywhere] whitespace-pre-wrap">
                      {breakdown.exception.stack}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </>
        ) : null}
        {logs && (logs.entries.length > 0 || logs.dropped > 0) && (
          <div className="border-b">
            <div className="px-3 pt-3 text-sm font-medium">
              Logs{" "}
              <span className="font-normal text-muted-foreground">
                {logs.entries.length}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 p-3">
              {logs.entries.map((entry) => (
                <div
                  key={entry.id}
                  className="grid grid-cols-[56px_36px_minmax(0,1fr)] items-baseline gap-2"
                  title={entry.span}
                >
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    +{formatDuration(entry.timeMs - (trace?.startMs ?? 0))}
                  </span>
                  <LogLevelLabel level={entry.level} />
                  <span className="font-mono text-xs leading-[18px] [overflow-wrap:anywhere] whitespace-pre-wrap">
                    {entry.message}
                  </span>
                </div>
              ))}
              {logs.dropped > 0 && (
                <p className="text-xs text-muted-foreground">
                  {logs.dropped} more{" "}
                  {logs.dropped === 1 ? "line was" : "lines were"} not kept: a
                  span keeps its first 100.
                </p>
              )}
            </div>
          </div>
        )}
        {trace ? (
          <div>
            <div className="px-3 pt-3 text-sm font-medium">Trace</div>
            <Waterfall trace={trace} now={now} />
          </div>
        ) : (
          <div className="grid place-items-center gap-1 px-4 py-10 text-center text-sm text-muted-foreground">
            {missing ? (
              <>
                <div>This request is no longer kept</div>
                <div className="text-xs">
                  Live requests are held in memory; older ones come from
                  history.
                </div>
              </>
            ) : (
              <div>Loading request</div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
