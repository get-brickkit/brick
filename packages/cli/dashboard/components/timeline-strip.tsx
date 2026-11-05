import { useRef, useState } from "react";
import { formatAxis, formatCount, formatDateTime } from "@/format";
import type { VolumeBucket } from "../../src/dashboard-protocol";

const TICKS = [0, 1, 2, 3, 4];

const LEGEND = [
  { label: "Succeeded", className: "bg-foreground/80" },
  { label: "Client error", className: "bg-foreground/35" },
  { label: "Server error", className: "bg-destructive" },
];

function ChartLegend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {LEGEND.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-1.5">
          <i className={`size-2 rounded-[1px] ${item.className}`} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Requests over time in a short strip, in the log views of hosting dashboards.
 * Hovering reads out a bucket; dragging across it zooms the list to that time.
 */
export function TimelineStrip({
  buckets,
  from,
  to,
  total,
  onBrush,
}: {
  buckets: VolumeBucket[] | undefined;
  from: number;
  to: number;
  /** Requests matching the filters across the whole window. */
  total: number;
  /** Called with the dragged time span; omit where zooming makes no sense. */
  onBrush?: (from: number, to: number) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number>();
  const [drag, setDrag] = useState<{ start: number; end: number }>();
  const list = buckets ?? [];
  const max = Math.max(1, ...list.map((b) => b.ok + b.client + b.server));
  const span = to - from;

  const fraction = (clientX: number): number => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  };
  const hovered = hover === undefined ? undefined : list[hover];

  return (
    <div className="px-4 pt-3 pb-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-sm font-medium tabular-nums">
            {formatCount(total)} requests
          </span>
          <ChartLegend />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {hovered
            ? `${formatDateTime(hovered.start)} · ${hovered.ok + hovered.client + hovered.server} requests`
            : onBrush
              ? "Drag across the chart to zoom"
              : ""}
        </span>
      </div>
      <div
        ref={track}
        className="relative h-14 touch-none select-none"
        style={{ cursor: onBrush ? "crosshair" : "default" }}
        onPointerDown={(event) => {
          if (!onBrush) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const at = fraction(event.clientX);
          setDrag({ start: at, end: at });
        }}
        onPointerMove={(event) => {
          const at = fraction(event.clientX);
          if (list.length > 0) {
            setHover(Math.min(list.length - 1, Math.floor(at * list.length)));
          }
          setDrag((current) => current && { ...current, end: at });
        }}
        onPointerUp={() => {
          if (drag && onBrush && Math.abs(drag.end - drag.start) > 0.02) {
            const low = Math.min(drag.start, drag.end);
            const high = Math.max(drag.start, drag.end);
            onBrush(
              Math.round(from + low * span),
              Math.round(from + high * span),
            );
          }
          setDrag(undefined);
        }}
        onPointerLeave={() => setHover(undefined)}
      >
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {list.map((bucket, index) => (
            <div
              key={bucket.start}
              className="flex h-full min-w-0 flex-1 flex-col-reverse"
              data-hover={index === hover}
            >
              <div
                className="block-bars w-full bg-foreground/80"
                style={{ height: `${(bucket.ok / max) * 100}%` }}
              />
              <div
                className="block-bars w-full bg-foreground/35"
                style={{ height: `${(bucket.client / max) * 100}%` }}
              />
              <div
                className="block-bars w-full bg-destructive"
                style={{ height: `${(bucket.server / max) * 100}%` }}
              />
            </div>
          ))}
          {list.length === 0 && (
            <div className="h-px w-full self-end border-t border-dashed" />
          )}
        </div>
        {hover !== undefined && !drag && list.length > 0 && (
          <div
            className="pointer-events-none absolute inset-y-0 bg-foreground/10"
            style={{
              left: `${(hover / list.length) * 100}%`,
              width: `${100 / list.length}%`,
            }}
          />
        )}
        {drag && (
          <div
            className="pointer-events-none absolute inset-y-0 border-x border-foreground/50 bg-foreground/10"
            style={{
              left: `${Math.min(drag.start, drag.end) * 100}%`,
              width: `${Math.abs(drag.end - drag.start) * 100}%`,
            }}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-xs leading-4 text-muted-foreground tabular-nums">
        {TICKS.map((tick) => (
          <span key={tick}>{formatAxis(from + (span * tick) / 4, span)}</span>
        ))}
      </div>
    </div>
  );
}
