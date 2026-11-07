import { Empty, PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { formatClock } from "@/format";
import { routeHref } from "@/state";
import { cn } from "@/lib/utils";
import type {
  FailureSummary,
  TraceSummary,
} from "../../src/dashboard-protocol";

export function ErrorsView({
  failures,
  traces,
  canLookBack,
}: {
  failures: FailureSummary[];
  traces: TraceSummary[];
  /** Whether requests that have left memory can still be opened from history. */
  canLookBack: boolean;
}) {
  return (
    <>
      <PageHeader
        title="Errors"
        description="Failed requests, startup failures, and crashes, newest first"
      />
      {failures.length === 0 ? (
        <Panel>
          <Empty title="No errors recorded" />
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {failures.map((failure) => {
            const known =
              failure.traceId !== undefined &&
              (canLookBack ||
                traces.some((trace) => trace.traceId === failure.traceId));
            const where = [
              failure.route,
              failure.service && failure.action
                ? `${failure.service}.${failure.action}`
                : undefined,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <Panel key={failure.id}>
                <div className="flex flex-col gap-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-destructive">
                      {failure.code}
                    </span>
                    {failure.status !== undefined && (
                      <Badge variant="destructive">HTTP {failure.status}</Badge>
                    )}
                    <Badge variant="outline">{failure.phase}</Badge>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatClock(failure.at)}
                    </span>
                  </div>
                  <div className="[overflow-wrap:anywhere]">
                    {failure.message}
                  </div>
                  {where && (
                    <div className="font-mono text-xs text-muted-foreground">
                      {where}
                    </div>
                  )}
                  {known && failure.traceId && (
                    <a
                      href={routeHref("requests", failure.traceId)}
                      className={cn(
                        buttonVariants({ variant: "outline", size: "sm" }),
                        "self-start",
                      )}
                    >
                      Open request
                    </a>
                  )}
                  {failure.stack && (
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        Stack trace
                      </summary>
                      <pre className="mt-2 overflow-auto border bg-muted/50 p-3 font-mono text-xs leading-[18px] [overflow-wrap:anywhere] whitespace-pre-wrap">
                        {failure.stack}
                      </pre>
                    </details>
                  )}
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </>
  );
}
