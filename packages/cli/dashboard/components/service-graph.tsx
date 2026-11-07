import { useEffect, useMemo, useRef, useState } from "react";
import { Empty } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { cn } from "@/lib/utils";
import {
  buildServiceGraph,
  layoutGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
  type EdgeKind,
  type GraphKind,
  type Health,
  type PlacedNode,
} from "@/graph";
import { formatDuration } from "@/format";
import type {
  ArchitectureSnapshot,
  TraceSummary,
} from "../../src/dashboard-protocol";

// Edges use the same colors as the span types they come from.
const EDGE_STROKE: Record<EdgeKind, string> = {
  request: "stroke-span-request",
  websocket: "stroke-span-request",
  rpc: "stroke-span-rpc",
  sql: "stroke-span-sql",
  event: "stroke-span-event",
};
const EDGE_FILL: Record<EdgeKind, string> = {
  request: "fill-span-request",
  websocket: "fill-span-request",
  rpc: "fill-span-rpc",
  sql: "fill-span-sql",
  event: "fill-span-event",
};
const EDGE_LABEL: Record<EdgeKind, string> = {
  request: "Request",
  websocket: "WebSocket",
  rpc: "Service call",
  sql: "SQL",
  event: "Event",
};
const KIND_ACCENT: Record<GraphKind, string> = {
  client: "border-l-span-request",
  socket: "border-l-span-request",
  service: "border-l-span-action",
  database: "border-l-span-sql",
  events: "border-l-span-event",
  listener: "border-l-span-event",
};
const KIND_LABEL: Record<GraphKind, string> = {
  client: "Client",
  socket: "WebSocket",
  service: "Service",
  database: "Database",
  events: "Events",
  listener: "Listener",
};
const HEALTH_DOT: Record<Health, string> = {
  ok: "bg-positive",
  failing: "bg-destructive",
  idle: "bg-muted-foreground/40",
};
const HEALTH_LABEL: Record<Health, string> = {
  ok: "Healthy",
  failing: "Failing",
  idle: "Idle",
};

// Below this the node text is too small to read, so the canvas scrolls instead.
const MIN_SCALE = 0.6;

/** How much to shrink a canvas of this width so it fits its container. */
function useFitScale(width: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setAvailable(
        element.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const scale =
    width === 0 || available === 0
      ? 1
      : Math.min(1, Math.max(MIN_SCALE, available / width));
  return { ref, scale };
}

function describe(node: PlacedNode): string {
  const parts = [node.label, node.detail];
  if (node.kind === "socket") parts.push(node.caption);
  if (node.calls > 0) {
    parts.push(node.caption);
    if (node.failures > 0) {
      parts.push(`${node.failures} failed`);
    }
    if (node.avgMs !== undefined)
      parts.push(`${formatDuration(node.avgMs)} average`);
  }
  return parts.join(" · ");
}

/**
 * The running app as a left-to-right graph: clients, sockets, their services,
 * calls between services, and databases. Calls and health come from the recent
 * requests, so the graph fills in as traffic arrives.
 */
export function ServiceGraphPanel({
  architecture,
  traces,
}: {
  architecture: ArchitectureSnapshot | null;
  traces: TraceSummary[];
}) {
  const layout = useMemo(
    () => layoutGraph(buildServiceGraph(architecture, traces)),
    [architecture, traces],
  );
  const { ref: canvasRef, scale } = useFitScale(layout.width);
  const [hovered, setHovered] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  const focus = hovered ?? selected;
  const focused = layout.nodes.find((node) => node.id === focus);
  const connected = new Set<string>(focus ? [focus] : []);
  if (focus) {
    for (const edge of layout.edges) {
      if (edge.from === focus || edge.to === focus) {
        connected.add(edge.from);
        connected.add(edge.to);
      }
    }
  }

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-4 p-4">
        <div>
          <h2 className="text-base leading-6 font-semibold">Service graph</h2>
          <p className="text-xs text-muted-foreground">
            Clients, WebSockets, services, databases, and observed calls
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {(Object.keys(HEALTH_LABEL) as Health[]).map((health) => (
              <span key={health} className="inline-flex items-center gap-1.5">
                <i className={cn("size-2", HEALTH_DOT[health])} />
                {HEALTH_LABEL[health]}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {(Object.keys(EDGE_LABEL) as EdgeKind[]).map((kind) => (
              <span key={kind} className="inline-flex items-center gap-1.5">
                <svg width="14" height="6" aria-hidden>
                  <line
                    x1="0"
                    y1="3"
                    x2="14"
                    y2="3"
                    strokeWidth="2"
                    className={EDGE_STROKE[kind]}
                  />
                </svg>
                {EDGE_LABEL[kind]}
              </span>
            ))}
          </div>
        </div>
      </div>
      {layout.nodes.length === 0 ? (
        <div className="border-t">
          <Empty title="Waiting for the application to start" />
        </div>
      ) : (
        <>
          <div
            ref={canvasRef}
            className="overflow-x-auto border-t bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] bg-size-[16px_16px] p-6"
          >
            <div
              className="mx-auto"
              style={{
                width: layout.width * scale,
                height: layout.height * scale,
              }}
            >
              <div
                className="relative origin-top-left"
                style={{
                  width: layout.width,
                  height: layout.height,
                  transform: `scale(${scale})`,
                }}
              >
                <svg
                  width={layout.width}
                  height={layout.height}
                  className="absolute inset-0 overflow-visible"
                  aria-hidden
                >
                  <defs>
                    {(Object.keys(EDGE_FILL) as EdgeKind[]).map((kind) => (
                      <marker
                        key={kind}
                        id={`arrow-${kind}`}
                        viewBox="0 0 8 8"
                        refX="7"
                        refY="4"
                        markerWidth="8"
                        markerHeight="8"
                        markerUnits="userSpaceOnUse"
                        orient="auto"
                      >
                        <path
                          d="M0 0 L8 4 L0 8 z"
                          className={EDGE_FILL[kind]}
                        />
                      </marker>
                    ))}
                  </defs>
                  {layout.edges.map((edge) => {
                    const active = focus
                      ? edge.from === focus || edge.to === focus
                      : true;
                    return (
                      <path
                        key={edge.id}
                        d={edge.path}
                        fill="none"
                        strokeWidth={
                          1.5 + Math.min(Math.log2(edge.calls + 1) / 3, 1.5)
                        }
                        strokeDasharray={edge.calls === 0 ? "4 4" : undefined}
                        markerEnd={`url(#arrow-${edge.kind})`}
                        className={cn(
                          EDGE_STROKE[edge.kind],
                          "transition-opacity",
                          active
                            ? edge.calls === 0
                              ? "opacity-40"
                              : "opacity-80"
                            : "opacity-10",
                        )}
                      >
                        <title>
                          {`${EDGE_LABEL[edge.kind]}: ${
                            edge.calls === 0
                              ? "not seen yet"
                              : `${edge.calls} call${edge.calls === 1 ? "" : "s"}${
                                  edge.avgMs === undefined
                                    ? ""
                                    : `, ${formatDuration(edge.avgMs)} average`
                                }`
                          }`}
                        </title>
                      </path>
                    );
                  })}
                </svg>
                {layout.nodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    title={describe(node)}
                    aria-pressed={selected === node.id}
                    onClick={() =>
                      setSelected((current) =>
                        current === node.id ? undefined : node.id,
                      )
                    }
                    onMouseEnter={() => setHovered(node.id)}
                    onMouseLeave={() => setHovered(undefined)}
                    onFocus={() => setHovered(node.id)}
                    onBlur={() => setHovered(undefined)}
                    className={cn(
                      "absolute flex flex-col justify-between border border-l-2 bg-card px-3 py-2 text-left font-mono transition-[opacity,border-color] outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                      KIND_ACCENT[node.kind],
                      selected === node.id
                        ? "border-positive/80"
                        : "hover:border-foreground/40",
                      focus && !connected.has(node.id) && "opacity-40",
                    )}
                    style={{
                      left: node.x,
                      top: node.y,
                      width: NODE_WIDTH,
                      height: NODE_HEIGHT,
                    }}
                  >
                    <span className="flex items-center gap-2.5">
                      <i
                        className={cn(
                          "size-2.5 shrink-0",
                          HEALTH_DOT[node.health],
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {node.label}
                      </span>
                      <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                        {KIND_LABEL[node.kind]}
                      </span>
                    </span>
                    <span className="truncate text-xs text-foreground/80">
                      {node.detail}
                    </span>
                    <span className="flex items-baseline justify-between gap-2 border-t border-dashed pt-1.5 text-xs text-muted-foreground tabular-nums">
                      <span className="truncate">{node.caption}</span>
                      <span>{node.metric}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="border-t px-4 py-2 text-xs text-muted-foreground">
            {focused
              ? describe(focused)
              : "Hover a node to follow its calls. Click one to keep it highlighted."}
          </div>
        </>
      )}
    </Panel>
  );
}
