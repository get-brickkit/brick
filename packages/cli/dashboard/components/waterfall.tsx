import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { SPAN_BG, SPAN_LABEL } from "@/components/span-style";
import { formatDuration, spanDepths, spanKind } from "@/format";
import { cn } from "@/lib/utils";
import {
  ATTR,
  SPAN,
  type TraceSpan,
  type TraceSummary,
} from "../../src/dashboard-protocol";

const RUNNING =
  "bg-[image:repeating-linear-gradient(135deg,transparent_0_4px,color-mix(in_oklab,var(--background)_45%,transparent)_4px_8px)]";

function failed(span: TraceSpan): boolean {
  return span.status === "error";
}

function SpanDetails({ span }: { span: TraceSpan }) {
  const attributes = Object.entries(span.attributes).filter(
    ([, value]) => value !== undefined,
  );
  const exceptions = span.events.filter(
    (event) => event.name === SPAN.exceptionEvent,
  );
  return (
    <div className="mb-2 flex flex-col gap-2">
      <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5 border bg-muted/50 p-3 font-mono text-xs leading-[18px]">
        {attributes.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="m-0 [overflow-wrap:anywhere]">{String(value)}</dd>
          </div>
        ))}
      </dl>
      {exceptions.map((event, index) => (
        <pre
          key={index}
          className="m-0 overflow-auto border bg-muted/50 p-3 font-mono text-xs leading-[18px] [overflow-wrap:anywhere] whitespace-pre-wrap"
        >
          {String(event.attributes[ATTR.exceptionMessage] ?? "")}
          {event.attributes[ATTR.exceptionStack]
            ? `\n\n${String(event.attributes[ATTR.exceptionStack])}`
            : ""}
        </pre>
      ))}
    </div>
  );
}

/** One request's spans on a shared time axis, nested by parent. */
export function Waterfall({
  trace,
  now,
}: {
  trace: TraceSummary;
  now: number;
}) {
  const [open, setOpen] = useState<string | undefined>();
  const depths = spanDepths(trace.spans);
  // A child can outlive the root, for example work finished after the response.
  const finish = Math.max(
    trace.endMs ?? now,
    ...trace.spans.map((span) => span.endMs ?? now),
  );
  const total = Math.max(finish - trace.startMs, 0.001);
  const kinds = [...new Set(trace.spans.map(spanKind))];

  return (
    <div className="flex flex-col px-4 pt-2 pb-4">
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {kinds.map((kind) => (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <i className={cn("size-2 rounded-[1px]", SPAN_BG[kind])} />
            {SPAN_LABEL[kind]}
          </span>
        ))}
        {trace.spans.some(failed) && (
          <span className="inline-flex items-center gap-1.5">
            <i className="size-2 rounded-[1px] bg-destructive" />
            Failed
          </span>
        )}
      </div>
      {trace.spans.map((span) => {
        const end = span.endMs ?? now;
        const kind = spanKind(span);
        const left = Math.min(
          Math.max(((span.startMs - trace.startMs) / total) * 100, 0),
          99.5,
        );
        const width = Math.min(
          Math.max(((end - span.startMs) / total) * 100, 0.5),
          100 - left,
        );
        const expanded = open === span.spanId;
        return (
          <div key={span.spanId}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? undefined : span.spanId)}
              className="group grid min-h-7 w-full grid-cols-[minmax(120px,38%)_minmax(0,1fr)_64px] items-center gap-3 text-left"
            >
              <span
                className="flex min-w-0 items-center truncate text-[13px] text-muted-foreground group-hover:text-foreground"
                style={{ paddingLeft: (depths.get(span.spanId) ?? 0) * 14 }}
                title={String(span.attributes[ATTR.dbStatement] ?? span.name)}
              >
                <i
                  className={cn(
                    "mr-2 size-2 shrink-0 rounded-[1px]",
                    failed(span) ? "bg-destructive" : SPAN_BG[kind],
                  )}
                />
                <span className="truncate">{span.name}</span>
              </span>
              <span className="relative h-3 overflow-hidden bg-border/70">
                <span
                  className={cn(
                    "absolute inset-y-0 min-w-0.5 rounded-[1.5px]",
                    failed(span) ? "bg-destructive" : SPAN_BG[kind],
                    span.status === "running" && RUNNING,
                  )}
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              </span>
              <span className="text-right text-xs text-muted-foreground tabular-nums">
                {formatDuration(
                  span.endMs === undefined
                    ? undefined
                    : span.endMs - span.startMs,
                )}
              </span>
            </button>
            {expanded && <SpanDetails span={span} />}
          </div>
        );
      })}
      {trace.truncated && (
        <Badge variant="outline" className="mt-2 self-start">
          Some spans were dropped
        </Badge>
      )}
    </div>
  );
}
