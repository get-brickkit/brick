import {
  ATTR,
  type ArchitectureSnapshot,
  type TraceSpan,
  type TraceSummary,
} from "../src/dashboard-protocol";
import { stringAttribute } from "../src/dashboard-query";
import { formatCount, formatDuration, spanKind } from "./format";

export type GraphKind =
  | "client"
  | "socket"
  | "service"
  | "database"
  | "events"
  | "listener";
export type EdgeKind = "request" | "websocket" | "rpc" | "sql" | "event";
export type Health = "ok" | "failing" | "idle";

export interface GraphNode {
  id: string;
  kind: GraphKind;
  label: string;
  /** Left caption, for example "12 calls". */
  caption: string;
  /** Right caption: the average duration, when there is one. */
  metric: string;
  /** What the node holds, for example "10 actions · 11 tools". */
  detail: string;
  health: Health;
  calls: number;
  failures: number;
  avgMs: number | undefined;
}

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  calls: number;
  avgMs: number | undefined;
}

export interface ServiceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface Activity {
  calls: number;
  failures: number;
  timed: number;
  totalMs: number;
  lastAt: number;
  lastFailed: boolean;
}

const idle = (): Activity => ({
  calls: 0,
  failures: 0,
  timed: 0,
  totalMs: 0,
  lastAt: -Infinity,
  lastFailed: false,
});

function record(
  activity: Activity,
  startMs: number,
  endMs: number | undefined,
  failed: boolean,
): void {
  activity.calls += 1;
  if (failed) activity.failures += 1;
  if (endMs !== undefined) {
    activity.timed += 1;
    activity.totalMs += endMs - startMs;
  }
  if (startMs >= activity.lastAt) {
    activity.lastAt = startMs;
    activity.lastFailed = failed;
  }
}

const average = (activity: Activity): number | undefined =>
  activity.timed === 0 ? undefined : activity.totalMs / activity.timed;

const healthOf = (activity: Activity): Health =>
  activity.calls === 0 ? "idle" : activity.lastFailed ? "failing" : "ok";

/** The service whose action or service call encloses this span, if any. */
function owner(
  span: TraceSpan,
  byId: Map<string, TraceSpan>,
): string | undefined {
  let current =
    span.parentSpanId === undefined ? undefined : byId.get(span.parentSpanId);
  for (let steps = 0; current && steps < 64; steps++) {
    const kind = spanKind(current);
    if (kind === "action" || kind === "rpc")
      return stringAttribute(current.attributes, ATTR.service);
    current =
      current.parentSpanId === undefined
        ? undefined
        : byId.get(current.parentSpanId);
  }
  return undefined;
}

const plural = (count: number, word: string) =>
  `${formatCount(count)} ${word}${count === 1 ? "" : "s"}`;

/**
 * The shape of the running app: clients, sockets, the services they call, the
 * calls between services, and each service's database. Structure comes from the
 * architecture; calls, durations, and health come from the recent traces.
 */
export function buildServiceGraph(
  architecture: ArchitectureSnapshot | null,
  traces: TraceSummary[],
): ServiceGraph {
  const services = architecture?.schema.services ?? [];
  const sockets = services.flatMap((service) =>
    (service.sockets ?? []).map((socket) => ({
      ...socket,
      service: service.name,
      id: `socket:${service.name}/${socket.name}`,
    })),
  );
  const serviceNames = services.map((service) => service.name);
  const databases = new Map<
    string,
    { id: string; label: string; engine: string; tables: number }
  >();
  const databaseOf = new Map<string, string>();
  for (const service of services) {
    const config = service.databaseConfig;
    if (!config) continue;
    const label = config.name ?? `${service.name} db`;
    const id = `db:${label}`;
    databaseOf.set(service.name, id);
    databases.set(id, {
      id,
      label,
      engine: config.engine,
      tables: config.tables.length,
    });
  }

  const serviceActivity = new Map<string, Activity>();
  const databaseActivity = new Map<string, Activity>();
  const clientActivity = idle();
  const edges = new Map<string, GraphEdge & { activity: Activity }>();

  const touch = (map: Map<string, Activity>, id: string) => {
    let activity = map.get(id);
    if (!activity) map.set(id, (activity = idle()));
    return activity;
  };
  const edge = (kind: EdgeKind, from: string, to: string) => {
    const id = `${from}->${to}`;
    let entry = edges.get(id);
    if (!entry) {
      entry = {
        id,
        kind,
        from,
        to,
        calls: 0,
        avgMs: undefined,
        activity: idle(),
      };
      edges.set(id, entry);
    }
    return entry.activity;
  };

  // Services that expose HTTP routes are reachable from clients even before
  // anything has called them; services with a database use it.
  for (const service of services) {
    if (service.actions.some((action) => action.method && action.path)) {
      edge("request", "client", `service:${service.name}`);
    }
    const database = databaseOf.get(service.name);
    if (database) edge("sql", `service:${service.name}`, database);
  }
  // Socket declarations show the transport and owner without claiming traffic.
  for (const socket of sockets) {
    edge("websocket", "client", socket.id);
    edge("websocket", socket.id, `service:${socket.service}`);
  }

  // Events are structure only: nothing times a delivery yet, so no traffic shows.
  const events = architecture?.schema.events;
  if (events && events.recorders.length > 0) {
    for (const name of events.recorders)
      edge("event", `service:${name}`, "events");
    for (const listener of events.listeners)
      edge("event", "events", `listener:${listener.name}`);
  }

  for (const trace of traces) {
    record(
      clientActivity,
      trace.startMs,
      trace.endMs,
      trace.status === "error",
    );
    const byId = new Map(trace.spans.map((span) => [span.spanId, span]));
    for (const span of trace.spans) {
      const kind = spanKind(span);
      const failed = span.status === "error";
      if (kind === "action") {
        const service = stringAttribute(span.attributes, ATTR.service);
        if (!service) continue;
        if (!serviceNames.includes(service)) serviceNames.push(service);
        record(
          touch(serviceActivity, service),
          span.startMs,
          span.endMs,
          failed,
        );
        record(
          edge("request", "client", `service:${service}`),
          span.startMs,
          span.endMs,
          failed,
        );
      } else if (kind === "rpc") {
        const callee = stringAttribute(span.attributes, ATTR.service);
        if (!callee) continue;
        if (!serviceNames.includes(callee)) serviceNames.push(callee);
        record(
          touch(serviceActivity, callee),
          span.startMs,
          span.endMs,
          failed,
        );
        const caller = owner(span, byId);
        if (caller && caller !== callee) {
          if (!serviceNames.includes(caller)) serviceNames.push(caller);
          record(
            edge("rpc", `service:${caller}`, `service:${callee}`),
            span.startMs,
            span.endMs,
            failed,
          );
        }
      } else if (kind === "sql") {
        const service = owner(span, byId);
        if (!service) continue;
        if (!serviceNames.includes(service)) serviceNames.push(service);
        const database = databaseOf.get(service) ?? `db:${service} db`;
        if (!databases.has(database)) {
          databases.set(database, {
            id: database,
            label: `${service} db`,
            engine:
              stringAttribute(span.attributes, ATTR.dbSystem) ?? "database",
            tables: 0,
          });
        }
        record(
          touch(databaseActivity, database),
          span.startMs,
          span.endMs,
          failed,
        );
        record(
          edge("sql", `service:${service}`, database),
          span.startMs,
          span.endMs,
          failed,
        );
      }
    }
  }

  const nodes: GraphNode[] = [];
  const hasClient =
    traces.length > 0 || [...edges.values()].some((e) => e.from === "client");
  if (hasClient) {
    nodes.push({
      id: "client",
      kind: "client",
      label: "Clients",
      caption: clientActivity.calls
        ? plural(clientActivity.calls, "request")
        : "no traffic",
      metric: formatMetric(average(clientActivity)),
      detail: sockets.length ? "HTTP and WebSocket clients" : "HTTP clients",
      health: healthOf(clientActivity),
      calls: clientActivity.calls,
      failures: clientActivity.failures,
      avgMs: average(clientActivity),
    });
  }
  for (const socket of sockets) {
    nodes.push({
      id: socket.id,
      kind: "socket",
      label: `${socket.service}.${socket.name}`,
      detail: socket.path ?? "WebSocket route",
      caption: `in: ${socket.input.join(", ") || "none"} · out: ${socket.output.join(", ") || "none"}`,
      metric: "",
      health: "idle",
      calls: 0,
      failures: 0,
      avgMs: undefined,
    });
  }
  for (const name of serviceNames) {
    const activity = serviceActivity.get(name) ?? idle();
    const schema = services.find((service) => service.name === name);
    nodes.push({
      id: `service:${name}`,
      kind: "service",
      label: name,
      caption: activity.calls ? plural(activity.calls, "call") : "no traffic",
      metric: formatMetric(average(activity)),
      detail: schema
        ? [
            plural(schema.actions.length, "action"),
            plural(schema.tools?.length ?? 0, "tool"),
            ...(schema.sockets?.length
              ? [plural(schema.sockets.length, "socket")]
              : []),
          ].join(" · ")
        : "Seen in requests",
      health: healthOf(activity),
      calls: activity.calls,
      failures: activity.failures,
      avgMs: average(activity),
    });
  }
  for (const database of databases.values()) {
    const activity = databaseActivity.get(database.id) ?? idle();
    nodes.push({
      id: database.id,
      kind: "database",
      label: database.label,
      caption: activity.calls
        ? `${formatCount(activity.calls)} ${activity.calls === 1 ? "query" : "queries"}`
        : "no queries",
      metric: formatMetric(average(activity)),
      detail:
        database.tables > 0
          ? `${database.engine} · ${plural(database.tables, "table")}`
          : database.engine,
      health: healthOf(activity),
      calls: activity.calls,
      failures: activity.failures,
      avgMs: average(activity),
    });
  }

  if (events && events.recorders.length > 0) {
    nodes.push({
      id: "events",
      kind: "events",
      label: "Events",
      caption: plural(events.listeners.length, "listener"),
      metric: "",
      detail: events.dispatch ? "outbox · delivering" : "outbox · record only",
      health: "idle",
      calls: 0,
      failures: 0,
      avgMs: undefined,
    });
    for (const listener of events.listeners)
      nodes.push({
        id: `listener:${listener.name}`,
        kind: "listener",
        label: listener.name,
        caption: listener.kind,
        metric: "",
        detail: `on ${listener.on.join(", ")}`,
        health: "idle",
        calls: 0,
        failures: 0,
        avgMs: undefined,
      });
  }

  const present = new Set(nodes.map((node) => node.id));
  return {
    nodes,
    edges: [...edges.values()]
      .filter((entry) => present.has(entry.from) && present.has(entry.to))
      .map(({ activity, ...entry }) => ({
        ...entry,
        calls: activity.calls,
        avgMs: average(activity),
      })),
  };
}

function formatMetric(ms: number | undefined): string {
  return ms === undefined ? "" : formatDuration(ms);
}

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 88;
const COLUMN_GAP = 104;
const ROW_GAP = 24;

export interface PlacedNode extends GraphNode {
  x: number;
  y: number;
  column: number;
}

export interface PlacedEdge extends GraphEdge {
  path: string;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

/**
 * Left-to-right layers: clients first, then each service one step past the
 * services that call it, and databases after their services. Edges leave the
 * right side of a node and curve into the left side of the next.
 */
export function layoutGraph(graph: ServiceGraph): GraphLayout {
  const depth = new Map(
    graph.nodes.map((node) => [node.id, node.kind === "client" ? 0 : 1]),
  );
  // Relax along edges; the pass limit and cap keep cycles from running away.
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let changed = false;
    for (const edge of graph.edges) {
      const next = (depth.get(edge.from) ?? 0) + 1;
      if (next > (depth.get(edge.to) ?? 0) && next <= graph.nodes.length) {
        depth.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const first = Math.min(...depth.values(), 0);
  const columns = new Map<number, GraphNode[]>();
  for (const node of graph.nodes) {
    const column = (depth.get(node.id) ?? 0) - first;
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }

  const tallest = Math.max(
    0,
    ...[...columns.values()].map((nodes) => nodes.length),
  );
  const height =
    tallest === 0 ? 0 : tallest * NODE_HEIGHT + (tallest - 1) * ROW_GAP;
  const placed = new Map<string, PlacedNode>();
  for (const [column, nodes] of columns) {
    const used = nodes.length * NODE_HEIGHT + (nodes.length - 1) * ROW_GAP;
    nodes.forEach((node, row) => {
      placed.set(node.id, {
        ...node,
        column,
        x: column * (NODE_WIDTH + COLUMN_GAP),
        y: (height - used) / 2 + row * (NODE_HEIGHT + ROW_GAP),
      });
    });
  }

  const edges: PlacedEdge[] = [];
  for (const edge of graph.edges) {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to) continue;
    const x1 = from.x + NODE_WIDTH;
    const y1 = from.y + NODE_HEIGHT / 2;
    const x2 = to.x;
    const y2 = to.y + NODE_HEIGHT / 2;
    const reach = Math.max((x2 - x1) / 2, 24);
    edges.push({
      ...edge,
      path: `M ${x1} ${y1} C ${x1 + reach} ${y1}, ${x2 - reach} ${y2}, ${x2 - 2} ${y2}`,
    });
  }

  const widest = Math.max(-1, ...columns.keys());
  return {
    nodes: [...placed.values()],
    edges,
    width: widest < 0 ? 0 : (widest + 1) * NODE_WIDTH + widest * COLUMN_GAP,
    height,
  };
}
