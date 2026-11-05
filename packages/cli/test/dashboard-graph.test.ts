import { describe, expect, it } from "bun:test";
import {
  buildServiceGraph,
  layoutGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
} from "../dashboard/graph";
import type {
  ArchitectureSnapshot,
  TraceSpan,
  TraceSummary,
} from "../src/dashboard-protocol";

function span(spanId: string, options: Partial<TraceSpan> = {}): TraceSpan {
  return {
    spanId,
    name: "span",
    startMs: 0,
    endMs: 10,
    status: "ok",
    attributes: {},
    events: [],
    ...options,
  };
}

function trace(
  startMs: number,
  spans: TraceSpan[],
  options: Partial<TraceSummary> = {},
): TraceSummary {
  return {
    traceId: `t${startMs}`,
    name: "GET /x",
    generation: 1,
    startMs,
    endMs: startMs + 10,
    durationMs: 10,
    status: "ok",
    truncated: false,
    spans,
    ...options,
  };
}

const action = (spanId: string, service: string, options = {}) =>
  span(spanId, {
    name: `action ${service}.run`,
    attributes: { "brick.service": service },
    ...options,
  });

const rpc = (spanId: string, service: string, options = {}) =>
  span(spanId, {
    name: `rpc ${service}.run`,
    attributes: { "brick.service": service },
    ...options,
  });

const sql = (spanId: string, options = {}) =>
  span(spanId, {
    name: "SELECT",
    attributes: { "db.statement": "select 1", "db.system": "sqlite" },
    ...options,
  });

function architecture(
  services: Array<{
    name: string;
    routes?: boolean;
    tools?: number;
    sockets?: ArchitectureSnapshot["schema"]["services"][number]["sockets"];
    database?: { name?: string; engine?: "sqlite" | "postgres" };
  }>,
): ArchitectureSnapshot {
  return {
    generation: 1,
    schema: {
      version: "1",
      services: services.map(
        ({ name, routes = true, tools = 0, sockets, database }) => ({
          name,
          sockets,
          options: {},
          hasDatabase: database !== undefined,
          databaseConfig: database && {
            name: database.name,
            engine: database.engine ?? "sqlite",
            tables: ["a", "b"],
          },
          tools: Array.from({ length: tools }, (_, index) => ({
            name: `tool${index}`,
          })),
          actions: [
            routes
              ? {
                  name: "run",
                  method: "POST",
                  path: `/${name}`,
                  hasAuthorize: false,
                }
              : { name: "run", hasAuthorize: false },
          ],
        }),
      ),
    } as ArchitectureSnapshot["schema"],
  };
}

describe("buildServiceGraph with sockets", () => {
  const live = {
    name: "live",
    path: "/api/chat/live",
    input: ["say"],
    output: ["connected", "history", "message", "presence"],
    hasAuthorize: true,
  };

  it("connects clients through a declared socket to its owner before any traffic", () => {
    const graph = buildServiceGraph(
      architecture([{ name: "chat", routes: false, sockets: [live] }]),
      [],
    );
    expect(graph.nodes.find((node) => node.id === "socket:chat/live")).toEqual({
      id: "socket:chat/live",
      kind: "socket",
      label: "chat.live",
      detail: "/api/chat/live",
      caption: "in: say · out: connected, history, message, presence",
      metric: "",
      health: "idle",
      calls: 0,
      failures: 0,
      avgMs: undefined,
    });
    expect(graph.edges).toEqual([
      {
        id: "client->socket:chat/live",
        kind: "websocket",
        from: "client",
        to: "socket:chat/live",
        calls: 0,
        avgMs: undefined,
      },
      {
        id: "socket:chat/live->service:chat",
        kind: "websocket",
        from: "socket:chat/live",
        to: "service:chat",
        calls: 0,
        avgMs: undefined,
      },
    ]);
  });

  it("keeps HTTP calls and same-named sockets on different services distinct", () => {
    const graph = buildServiceGraph(
      architecture([
        { name: "chat", sockets: [live] },
        { name: "support", sockets: [{ ...live, path: "/help/live" }] },
      ]),
      [trace(0, [action("a", "chat")])],
    );
    expect(
      graph.nodes
        .filter((node) => node.kind === "socket")
        .map((node) => node.id),
    ).toEqual(["socket:chat/live", "socket:support/live"]);
    expect(
      graph.edges.find((edge) => edge.id === "client->service:chat"),
    ).toMatchObject({ kind: "request", calls: 1 });
    expect(
      graph.edges.filter((edge) => edge.kind === "websocket"),
    ).toHaveLength(4);
    expect(
      graph.edges
        .filter((edge) => edge.kind === "websocket")
        .every((edge) => edge.calls === 0),
    ).toBe(true);
  });

  it("lays out clients, sockets, their service, and its database in order", () => {
    const layout = layoutGraph(
      buildServiceGraph(
        architecture([
          {
            name: "chat",
            sockets: [live, { ...live, name: "alerts" }],
            database: { name: "chat history" },
          },
        ]),
        [],
      ),
    );
    expect(
      Object.fromEntries(layout.nodes.map((node) => [node.id, node.column])),
    ).toEqual({
      client: 0,
      "socket:chat/live": 1,
      "socket:chat/alerts": 1,
      "service:chat": 2,
      "db:chat history": 3,
    });
    const sockets = layout.nodes.filter((node) => node.kind === "socket");
    expect(Math.abs(sockets[0]!.y - sockets[1]!.y)).toBeGreaterThanOrEqual(
      NODE_HEIGHT,
    );
    expect(layout.edges).toHaveLength(6);
  });
});

describe("buildServiceGraph with events", () => {
  const withEvents = (events: unknown): ArchitectureSnapshot => {
    const snapshot = architecture([
      { name: "orders", database: { engine: "sqlite" } },
    ]);
    (snapshot.schema as { events?: unknown }).events = events;
    return snapshot;
  };

  it("draws the services that record events, the outbox, and each listener", () => {
    const graph = buildServiceGraph(
      withEvents({
        listeners: [
          { name: "audit", on: ["order.*"], kind: "handler" },
          { name: "shipping", on: ["order.update"], kind: "workflow" },
        ],
        dispatch: true,
        recorders: ["orders"],
      }),
      [],
    );

    const node = (id: string) => graph.nodes.find((n) => n.id === id);
    expect(node("events")).toMatchObject({
      kind: "events",
      caption: "2 listeners",
      detail: "outbox · delivering",
    });
    expect(node("listener:shipping")).toMatchObject({
      kind: "listener",
      caption: "workflow",
      detail: "on order.update",
    });
    expect(
      graph.edges
        .filter((edge) => edge.kind === "event")
        .map((edge) => `${edge.from}->${edge.to}`),
    ).toEqual([
      "service:orders->events",
      "events->listener:audit",
      "events->listener:shipping",
    ]);
  });

  it("draws nothing when no service records events", () => {
    const graph = buildServiceGraph(
      withEvents({ listeners: [], dispatch: true, recorders: [] }),
      [],
    );
    expect(graph.nodes.map((node) => node.kind)).toEqual([
      "client",
      "service",
      "database",
    ]);
  });

  it("puts the outbox after its services and the listeners after the outbox", () => {
    const layout = layoutGraph(
      buildServiceGraph(
        withEvents({
          listeners: [{ name: "audit", on: ["x"], kind: "handler" }],
          dispatch: false,
          recorders: ["orders"],
        }),
        [],
      ),
    );
    const column = (id: string) =>
      layout.nodes.find((n) => n.id === id)!.column;
    expect(column("events")).toBeGreaterThan(column("service:orders"));
    expect(column("listener:audit")).toBe(column("events") + 1);
  });
});

describe("buildServiceGraph", () => {
  it("is empty before the app starts and nothing has run", () => {
    expect(buildServiceGraph(null, [])).toEqual({ nodes: [], edges: [] });
  });

  it("draws the architecture before any traffic arrives", () => {
    const graph = buildServiceGraph(
      architecture([
        { name: "notes", database: { name: "notes-db" } },
        { name: "users", routes: false },
      ]),
      [],
    );
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "client",
      "service:notes",
      "service:users",
      "db:notes-db",
    ]);
    expect(graph.nodes.every((node) => node.health === "idle")).toBe(true);
    expect(
      graph.nodes.find((node) => node.id === "service:notes")?.caption,
    ).toBe("no traffic");
    // Only the service with an HTTP route is reachable from a client.
    expect(graph.edges.map((edge) => [edge.kind, edge.from, edge.to])).toEqual([
      ["request", "client", "service:notes"],
      ["sql", "service:notes", "db:notes-db"],
    ]);
    expect(graph.edges.every((edge) => edge.calls === 0)).toBe(true);
  });

  it("describes each service by its actions and tools and each database by its name", () => {
    const graph = buildServiceGraph(
      architecture([
        { name: "pages", tools: 11, database: { name: "pages-db" } },
        { name: "users", routes: false },
      ]),
      [],
    );
    const node = (id: string) => graph.nodes.find((entry) => entry.id === id);
    expect(node("service:pages")?.detail).toBe("1 action · 11 tools");
    expect(node("service:users")?.detail).toBe("1 action · 0 tools");
    expect(node("db:pages-db")).toMatchObject({
      label: "pages-db",
      detail: "sqlite · 2 tables",
    });
  });

  it("counts requests, service calls, and queries along each edge", () => {
    const graph = buildServiceGraph(
      architecture([
        { name: "orders", database: { name: "orders-db" } },
        { name: "users", routes: false, database: { name: "users-db" } },
      ]),
      [
        trace(1_000, [
          action("a1", "orders", { startMs: 1_000, endMs: 1_040 }),
          sql("q1", { parentSpanId: "a1", startMs: 1_002, endMs: 1_006 }),
          rpc("r1", "users", {
            parentSpanId: "a1",
            startMs: 1_010,
            endMs: 1_030,
          }),
          sql("q2", { parentSpanId: "r1", startMs: 1_012, endMs: 1_016 }),
        ]),
        trace(2_000, [
          action("a2", "orders", { startMs: 2_000, endMs: 2_020 }),
        ]),
      ],
    );
    const edge = (from: string, to: string) =>
      graph.edges.find((entry) => entry.from === from && entry.to === to);
    const node = (id: string) => graph.nodes.find((entry) => entry.id === id);

    expect(edge("client", "service:orders")).toMatchObject({
      kind: "request",
      calls: 2,
      avgMs: 30,
    });
    expect(edge("service:orders", "service:users")).toMatchObject({
      kind: "rpc",
      calls: 1,
      avgMs: 20,
    });
    // The query inside the rpc belongs to the callee's database.
    expect(edge("service:orders", "db:orders-db")).toMatchObject({ calls: 1 });
    expect(edge("service:users", "db:users-db")).toMatchObject({ calls: 1 });

    expect(node("client")).toMatchObject({ caption: "2 requests", calls: 2 });
    expect(node("service:orders")?.caption).toBe("2 calls");
    expect(node("service:users")?.caption).toBe("1 call");
    expect(node("db:orders-db")?.caption).toBe("1 query");
  });

  it("marks a node failing when its latest call failed and ok when it recovered", () => {
    const failing = buildServiceGraph(architecture([{ name: "notes" }]), [
      trace(1_000, [action("a1", "notes", { startMs: 1_000 })]),
      trace(2_000, [
        action("a2", "notes", { startMs: 2_000, status: "error" }),
      ]),
    ]);
    const notes = failing.nodes.find((node) => node.id === "service:notes");
    expect(notes).toMatchObject({ health: "failing", failures: 1, calls: 2 });

    const recovered = buildServiceGraph(architecture([{ name: "notes" }]), [
      trace(1_000, [
        action("a1", "notes", { startMs: 1_000, status: "error" }),
      ]),
      trace(2_000, [action("a2", "notes", { startMs: 2_000 })]),
    ]);
    expect(
      recovered.nodes.find((node) => node.id === "service:notes")?.health,
    ).toBe("ok");
  });

  it("adds services and databases that only show up in traces", () => {
    const graph = buildServiceGraph(null, [
      trace(1_000, [action("a1", "ghost"), sql("q1", { parentSpanId: "a1" })]),
    ]);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "client",
      "service:ghost",
      "db:ghost db",
    ]);
    expect(graph.edges.map((edge) => edge.id)).toEqual([
      "client->service:ghost",
      "service:ghost->db:ghost db",
    ]);
  });

  it("ignores a service calling itself and queries with no owning action", () => {
    const graph = buildServiceGraph(architecture([{ name: "notes" }]), [
      trace(1_000, [
        action("a1", "notes"),
        rpc("r1", "notes", { parentSpanId: "a1" }),
        sql("orphan"),
      ]),
    ]);
    expect(graph.edges.filter((edge) => edge.kind === "rpc")).toEqual([]);
    expect(graph.nodes.some((node) => node.kind === "database")).toBe(false);
  });
});

describe("layoutGraph", () => {
  const sample = () =>
    buildServiceGraph(
      architecture([
        { name: "orders", database: { name: "orders-db" } },
        { name: "users", routes: false, database: { name: "users-db" } },
      ]),
      [
        trace(1_000, [
          action("a1", "orders"),
          rpc("r1", "users", { parentSpanId: "a1" }),
        ]),
      ],
    );

  it("places clients first and each callee a column after its caller", () => {
    const layout = layoutGraph(sample());
    const column = (id: string) =>
      layout.nodes.find((node) => node.id === id)?.column;
    expect(column("client")).toBe(0);
    expect(column("service:orders")).toBe(1);
    expect(column("service:users")).toBe(2);
    expect(column("db:orders-db")).toBe(2);
    expect(column("db:users-db")).toBe(3);
  });

  it("keeps nodes inside the canvas and apart from each other", () => {
    const layout = layoutGraph(sample());
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
      expect(node.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    }
    for (const a of layout.nodes) {
      for (const b of layout.nodes) {
        if (a === b || a.column !== b.column) continue;
        expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(NODE_HEIGHT);
      }
    }
  });

  it("curves each edge from the right of one node to the left of the next", () => {
    const layout = layoutGraph(sample());
    expect(layout.edges).toHaveLength(sample().edges.length);
    const clientToOrders = layout.edges.find(
      (edge) => edge.id === "client->service:orders",
    );
    const client = layout.nodes.find((node) => node.id === "client")!;
    expect(
      clientToOrders?.path.startsWith(
        `M ${client.x + NODE_WIDTH} ${client.y + NODE_HEIGHT / 2} C`,
      ),
    ).toBe(true);
  });

  it("terminates on call cycles", () => {
    const graph = buildServiceGraph(
      architecture([{ name: "a" }, { name: "b" }]),
      [
        trace(1_000, [
          action("a1", "a"),
          rpc("r1", "b", { parentSpanId: "a1" }),
          rpc("r2", "a", { parentSpanId: "r1" }),
        ]),
      ],
    );
    const layout = layoutGraph(graph);
    expect(layout.nodes).toHaveLength(graph.nodes.length);
    expect(Number.isFinite(layout.width)).toBe(true);
  });

  it("lays out nothing as an empty canvas", () => {
    expect(layoutGraph({ nodes: [], edges: [] })).toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
    });
  });
});
