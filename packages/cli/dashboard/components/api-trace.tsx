import { createContext, useContext, useEffect, useState } from "react";
import {
  DefaultResultDisplay,
  type ResultDisplayProps,
} from "fumadocs-openapi/ui/playground/client";
import { Waterfall } from "@/components/waterfall";
import { describeTrace, formatDuration } from "@/format";
import { routeHref, useNow } from "@/state";
import type {
  FailureSummary,
  TraceSummary,
} from "../../src/dashboard-protocol";

/** The requests and failures the dashboard has seen, as of now. */
export const TraceContext = createContext<{
  traces: TraceSummary[];
  failures: FailureSummary[];
}>({ traces: [], failures: [] });

/** How long to wait for the app's trace before saying there is none. */
const WAIT_MS = 4000;

/**
 * What the app recorded for the request just sent: how it ended, the stack
 * trace when it failed, and its spans. The response names its trace in the
 * `x-trace-id` header; the trace itself arrives from the app a moment later.
 */
function RequestTrace({ traceId }: { traceId: string }) {
  const { traces, failures } = useContext(TraceContext);
  const trace = traces.find((item) => item.traceId === traceId);
  const failure = failures.find((item) => item.traceId === traceId);
  const exception = trace ? describeTrace(trace).exception : undefined;
  const code = failure?.code ?? exception?.code;
  const message = failure?.message ?? exception?.message ?? trace?.message;
  const stack = failure?.stack ?? exception?.stack;
  const now = useNow(trace?.status === "running");

  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setGaveUp(true), WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="max-h-[50%] shrink-0 overflow-y-auto border-t text-sm">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="text-[0.8125rem] font-medium">Trace</span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-fd-muted-foreground"
          title={traceId}
        >
          {traceId}
        </span>
        {/* A new tab: this dialog stays as it is, with what was typed into it. */}
        <a
          href={routeHref("requests", traceId)}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 text-xs text-fd-muted-foreground underline underline-offset-4 hover:text-fd-foreground"
        >
          Open request
        </a>
      </div>
      {!trace && !failure ? (
        <p className="px-4 pb-3 text-xs text-fd-muted-foreground">
          {gaveUp
            ? "The app recorded no trace for this request."
            : "Waiting for the app's trace…"}
        </p>
      ) : (
        <div className="flex flex-col gap-3 px-4 pb-4">
          {trace && (
            <p className="text-xs text-fd-muted-foreground">
              {[
                trace.service && trace.action
                  ? `${trace.service}.${trace.action}`
                  : trace.route,
                trace.status === "running"
                  ? "running"
                  : formatDuration(trace.durationMs),
                `${trace.spans.length} spans`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          )}
          {(code || message || stack) && (
            <div className="flex flex-col gap-1.5">
              {code && (
                <span className="font-medium text-red-600 dark:text-red-400">
                  {code}
                </span>
              )}
              {message && <p className="[overflow-wrap:anywhere]">{message}</p>}
              {stack && (
                <pre className="max-h-64 overflow-auto rounded-lg border bg-fd-secondary/50 p-3 font-mono text-xs leading-[18px] [overflow-wrap:anywhere] whitespace-pre-wrap">
                  {stack}
                </pre>
              )}
            </div>
          )}
          {trace && trace.spans.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-fd-muted-foreground">
                Spans
              </summary>
              <div className="-mx-4 mt-2">
                <Waterfall trace={trace} now={now} />
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

/** The playground's response, with the app's trace of that request below it. */
export function TracedResult(props: ResultDisplayProps) {
  const traceId =
    props.data.type === "response"
      ? props.data.headers.get("x-trace-id")
      : null;
  return (
    <>
      <DefaultResultDisplay {...props} />
      {traceId && <RequestTrace traceId={traceId} />}
    </>
  );
}
