import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attributes } from "@opentelemetry/api";
import { DASHBOARD_MCP_TOOLS } from "@brickkit/core";
import { MAX_TRACE_CHARS } from "../src/dashboard-mcp";
import type { TelemetryRecord } from "../src/dashboard-protocol";
import { startDevDashboard } from "../src/dev-dashboard";
import { openHistory } from "../src/dev-history";
import { DevTelemetryStore } from "../src/dev-telemetry-store";

const token = "0123456789abcdef-secret";
const bearer = { authorization: `Bearer ${token}` };

const rpc = (method: string, params?: unknown, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

function post(
  base: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

/** Call a tool and read its answer: the JSON it printed, or the error text. */
async function call(
  base: string,
  name: string,
  args: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  const response = await post(
    base,
    rpc("tools/call", { name, arguments: args }),
    headers,
  );
  expect(response.status).toBe(200);
  const { result, error } = await response.json();
  if (error) return { rpcError: error as { code: number; message: string } };
  const text: string = result.content[0].text;
  return result.isError
    ? { isError: true as const, text }
    : { isError: false as const, text, data: JSON.parse(text) };
}

const root = (method: string, route: string) => ({
  "http.request.method": method,
  "http.route": route,
  "url.path": route.replace(":id", "7"),
});

/** A finished request: its spans start and end in order, the last one the root. */
function request(
  traceId: string,
  startMs: number,
  options: {
    method?: string;
    route?: string;
    status?: number;
    durationMs?: number;
    error?: string;
    spans?: number;
    logs?: string[];
    attributes?: Attributes;
  } = {},
): TelemetryRecord[] {
  const route = options.route ?? "/api/pages/:id";
  const endMs = startMs + (options.durationMs ?? 10);
  const records: TelemetryRecord[] = [
    {
      phase: "start",
      traceId,
      spanId: "root",
      name: `${options.method ?? "GET"} ${route}`,
      startMs,
      attributes: root(options.method ?? "GET", route),
    },
  ];
  for (let index = 0; index < (options.spans ?? 0); index++) {
    const spanId = `child-${index}`;
    records.push(
      {
        phase: "start",
        traceId,
        spanId,
        parentSpanId: "root",
        name: `db query ${index}`,
        startMs: startMs + 1,
        attributes: {},
      },
      {
        phase: "end",
        traceId,
        spanId,
        name: `db query ${index}`,
        endMs: startMs + 2,
        status: "ok",
        attributes: { "db.statement": "SELECT 1" },
        events: [],
      },
    );
  }
  records.push({
    phase: "end",
    traceId,
    spanId: "root",
    name: `${options.method ?? "GET"} ${route}`,
    endMs,
    status: options.error ? "error" : "ok",
    statusMessage: options.error,
    attributes: {
      "http.response.status_code": options.status ?? 200,
      ...options.attributes,
      ...(options.error
        ? {
            "brick.error.code": "INTERNAL",
            "brick.error.status": 500,
            "brick.service": "pages",
            "brick.action": "get",
          }
        : {}),
    },
    events: [
      ...(options.logs ?? []).map((message) => ({
        name: "log",
        timeMs: startMs + 3,
        attributes: { "log.level": "warn", "log.message": message },
      })),
      ...(options.error
        ? [
            {
              name: "exception",
              timeMs: endMs,
              attributes: {
                "exception.type": "Error",
                "exception.message": options.error,
                "exception.stacktrace": `Error: ${options.error}\n    at get (pages.ts:12:3)`,
              },
            },
          ]
        : []),
    ],
  });
  return records;
}

function seed(store: DevTelemetryStore) {
  const now = Date.now();
  store.startGeneration("test");
  store.setArchitecture(
    {
      version: "1",
      services: [
        {
          name: "pages",
          options: {},
          hasDatabase: false,
          actions: [
            {
              name: "get",
              method: "GET",
              path: "/api/pages/:id",
              hasAuthorize: false,
              accessPolicy: "public",
            },
          ],
          tools: [{ name: "findPage" }],
        },
      ],
      events: {
        listeners: [{ name: "reindex", on: ["pages.saved"], kind: "workflow" }],
        dispatch: true,
        recorders: [],
        schedules: [
          {
            name: "nightly",
            kind: "handler",
            every: 86_400_000,
            enabled: true,
          },
        ],
      },
    },
    1,
  );
  const records = [
    request("ok-1", now - 5000, { logs: ["cache miss"], spans: 1 }),
    request("slow-1", now - 4000, { route: "/api/slow", durationMs: 900 }),
    request("gone-1", now - 3000, { status: 404 }),
    request("boom-1", now - 2000, {
      status: 500,
      error: "database is locked",
      logs: ["about to fail"],
    }),
  ];
  store.ingest(records.flat(), 1);
}

async function dev(options: { history?: boolean; seeded?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "brick-mcp-"));
  const history = options.history
    ? await openHistory({ directory, days: 7 })
    : undefined;
  const store = new DevTelemetryStore({ history });
  if (options.seeded !== false) seed(store);
  const dashboard = await startDevDashboard({ port: 0, store, history });
  return {
    store,
    base: `http://127.0.0.1:${dashboard.port}`,
    stop() {
      dashboard.stop();
      history?.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("the dashboard's MCP endpoint", () => {
  it("answers initialize and lists five read-only tools", async () => {
    const { base, stop } = await dev();
    try {
      const init = await (
        await post(
          base,
          rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
          }),
        )
      ).json();
      expect(init.result.serverInfo.name).toBe("brick-dashboard");
      expect(init.result.capabilities).toEqual({ tools: {} });

      const { result } = await (await post(base, rpc("tools/list"))).json();
      expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        "summary",
        "list_requests",
        "get_trace",
        "list_errors",
        "app_overview",
      ]);
      // The names an app may not take for its own tool: core refuses them at startup.
      expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
        ...DASHBOARD_MCP_TOOLS,
      ]);
      for (const tool of result.tools) {
        expect(tool.annotations).toEqual({ readOnlyHint: true });
        expect(tool.description.length).toBeGreaterThan(40);
        expect(tool.inputSchema.type).toBe("object");
      }
    } finally {
      stop();
    }
  });

  it("has no tool that writes, for anyone", async () => {
    const store = new DevTelemetryStore();
    let identityCalls = 0;
    const dashboard = await startDevDashboard({
      port: 0,
      store,
      mode: "production",
      mcp: true,
      // A signed-in user, the one caller the dashboard lets do more elsewhere.
      auth: {
        authorize: () => {
          identityCalls++;
          return { user: { id: "u1", name: "Ada" } };
        },
      },
    });
    const base = `http://127.0.0.1:${dashboard.port}`;
    try {
      const { result } = await (await post(base, rpc("tools/list"))).json();
      expect(identityCalls).toBe(1);
      expect(
        result.tools.every((tool: any) => tool.annotations.readOnlyHint),
      ).toBe(true);
      for (const name of ["restart", "run_schedule", "cancel_run", "replay"]) {
        const answer = await (
          await post(base, rpc("tools/call", { name, arguments: {} }))
        ).json();
        expect(answer.error.code).toBe(-32602);
      }
      // `Object.prototype` names are not tools either.
      const inherited = await (
        await post(base, rpc("tools/call", { name: "constructor" }))
      ).json();
      expect(inherited.error.code).toBe(-32602);
    } finally {
      dashboard.stop();
    }
  });

  it("answers GET and DELETE with 405 and an Allow header", async () => {
    const { base, stop } = await dev();
    try {
      for (const method of ["GET", "DELETE"]) {
        const response = await fetch(`${base}/mcp`, { method });
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("POST");
      }
    } finally {
      stop();
    }
  });

  it("summarizes the last hour, with the slowest endpoints", async () => {
    const { base, stop } = await dev();
    try {
      const { data } = (await call(base, "summary")) as any;
      expect(data).toMatchObject({
        source: "memory",
        requests: 4,
        clientErrors: 1,
        serverErrors: 1,
        errorRate: 0.25,
      });
      expect(data.slowestEndpoints[0]).toMatchObject({
        endpoint: "GET /api/slow",
        requests: 1,
      });
      expect(data.slowestEndpoints[0].avgMs).toBeGreaterThan(800);

      // Nothing happened in a window that ended an hour and a half ago.
      const empty = (await call(base, "summary", {
        from: "3h",
        to: "90m",
      })) as any;
      expect(empty.data).toMatchObject({ requests: 0, errorRate: 0 });
    } finally {
      stop();
    }
  });

  it("lists requests with the history filters, a page at a time", async () => {
    const { base, stop } = await dev();
    try {
      const all = (await call(base, "list_requests")) as any;
      expect(all.data.total).toBe(4);
      expect(all.data.requests.map((row: any) => row.traceId)).toEqual([
        "boom-1",
        "gone-1",
        "slow-1",
        "ok-1",
      ]);
      expect(all.data.requests[0]).toMatchObject({
        endpoint: "GET /api/pages/:id",
        path: "/api/pages/7",
        status: 500,
        outcome: "server",
        message: "database is locked",
      });

      const server = (await call(base, "list_requests", {
        outcome: "server",
      })) as any;
      expect(server.data.requests.map((row: any) => row.traceId)).toEqual([
        "boom-1",
      ]);
      const slow = (await call(base, "list_requests", {
        endpoint: "GET /api/slow",
      })) as any;
      expect(slow.data.total).toBe(1);
      const text = (await call(base, "list_requests", {
        query: "locked",
      })) as any;
      expect(text.data.requests.map((row: any) => row.traceId)).toEqual([
        "boom-1",
      ]);
      const slowest = (await call(base, "list_requests", {
        sort: "slowest",
        min_ms: 100,
      })) as any;
      expect(slowest.data.requests.map((row: any) => row.traceId)).toEqual([
        "slow-1",
      ]);

      const first = (await call(base, "list_requests", { limit: 3 })) as any;
      expect(first.data.requests).toHaveLength(3);
      expect(first.data.nextOffset).toBe(3);
      const rest = (await call(base, "list_requests", {
        limit: 3,
        offset: 3,
      })) as any;
      expect(rest.data.requests.map((row: any) => row.traceId)).toEqual([
        "ok-1",
      ]);
      expect(rest.data.nextOffset).toBeUndefined();
    } finally {
      stop();
    }
  });

  it("takes a time as epoch milliseconds, a number or a string of digits", async () => {
    const { base, stop } = await dev();
    try {
      const hourAgo = Date.now() - 3_600_000;
      for (const from of [hourAgo, String(hourAgo)]) {
        const answer = (await call(base, "list_requests", { from })) as any;
        expect(answer.data.total).toBe(4);
        expect(answer.data.window.from).toBe(new Date(hourAgo).toISOString());
      }
      // A window that starts after the requests held none.
      const later = (await call(base, "summary", {
        from: String(Date.now() + 60_000),
        to: String(Date.now() + 120_000),
      })) as any;
      expect(later.data.requests).toBe(0);
    } finally {
      stop();
    }
  });

  it("reads a short string of digits as a date, not as epoch milliseconds", async () => {
    const { base, stop } = await dev();
    try {
      const answer = (await call(base, "summary", {
        from: "2026",
        to: "2027",
      })) as any;
      expect(answer.data.window).toEqual({
        from: new Date("2026").toISOString(),
        to: new Date("2027").toISOString(),
      });
    } finally {
      stop();
    }
  });

  it("refuses arguments that make no sense, as tool errors", async () => {
    const { base, stop } = await dev();
    try {
      for (const args of [
        { outcome: "bad" },
        { from: "yesterday-ish" },
        { limit: "ten" },
        { from: "1h", to: "2h" },
      ]) {
        expect(await call(base, "list_requests", args)).toMatchObject({
          isError: true,
        });
      }
    } finally {
      stop();
    }
  });

  it("returns a request's span tree with timing, attributes, log lines and the error", async () => {
    const { base, stop } = await dev();
    try {
      const ok = (await call(base, "get_trace", { trace_id: "ok-1" })) as any;
      expect(ok.data).toMatchObject({
        traceId: "ok-1",
        endpoint: "GET /api/pages/:id",
        status: 200,
        outcome: "ok",
      });
      expect(ok.data.truncated).toBeUndefined();
      const [rootSpan] = ok.data.spans;
      expect(rootSpan).toMatchObject({
        name: "GET /api/pages/:id",
        startMs: 0,
      });
      expect(rootSpan.events).toEqual([
        { atMs: 3, name: "log", level: "warn", message: "cache miss" },
      ]);
      expect(rootSpan.children).toHaveLength(1);
      expect(rootSpan.children[0]).toMatchObject({
        name: "db query 0",
        durationMs: 1,
        attributes: { "db.statement": "SELECT 1" },
      });

      const failed = (await call(base, "get_trace", {
        trace_id: "boom-1",
      })) as any;
      expect(failed.data.outcome).toBe("server");
      expect(failed.data.spans[0].error).toMatchObject({
        type: "Error",
        message: "database is locked",
      });
      expect(failed.data.spans[0].error.stack).toContain("pages.ts:12:3");
    } finally {
      stop();
    }
  });

  it("cuts a very large trace to the cap and says what it left out", async () => {
    const { base, store, stop } = await dev({ seeded: false });
    try {
      const now = Date.now();
      store.ingest(
        request("big-1", now, {
          spans: 400,
          logs: Array.from(
            { length: 200 },
            (_, i) => `line ${i} ${"x".repeat(5000)}`,
          ),
          attributes: { "db.statement": "SELECT ".padEnd(100_000, "y") },
        }).flat(),
        1,
      );
      const answer = (await call(base, "get_trace", {
        trace_id: "big-1",
      })) as any;
      expect(answer.text.length).toBeLessThanOrEqual(MAX_TRACE_CHARS);
      expect(answer.data.truncated.note).toContain("Cut to fit");
      expect(answer.data.truncated.spans).toBeGreaterThan(0);
      expect(answer.data.truncated.events).toBeGreaterThan(0);
      expect(answer.data.truncated.text).toBeGreaterThan(0);
      // What stays is still a valid tree.
      expect(answer.data.spans[0].name).toBe("GET /api/pages/:id");
    } finally {
      stop();
    }
  });

  it("leaves the spans out when even the harshest cut is over the cap", async () => {
    const { base, store, stop } = await dev({ seeded: false });
    try {
      store.ingest(
        request("huge-key-1", Date.now(), {
          spans: 50,
          // Attribute keys are never shortened.
          attributes: { ["k".repeat(MAX_TRACE_CHARS)]: "v" },
        }).flat(),
        1,
      );
      const answer = (await call(base, "get_trace", {
        trace_id: "huge-key-1",
      })) as any;
      expect(answer.text.length).toBeLessThanOrEqual(MAX_TRACE_CHARS);
      expect(answer.data.spans).toEqual([]);
      expect(answer.data.truncated.note).toContain("spans are left out");
      expect(answer.data.traceId).toBe("huge-key-1");
    } finally {
      stop();
    }
  });

  it("answers an unknown trace id with a tool error, not a crash", async () => {
    const { base, stop } = await dev();
    try {
      const answer = await call(base, "get_trace", { trace_id: "nope" });
      expect(answer).toMatchObject({ isError: true });
      expect((answer as any).text).toContain("No request with trace id nope");
      expect(await call(base, "get_trace")).toMatchObject({ isError: true });
      // The server is still up.
      expect((await call(base, "summary")).isError).toBe(false);
    } finally {
      stop();
    }
  });

  it("lists the failures that are server errors, newest first, with the trace id", async () => {
    const { base, stop } = await dev();
    try {
      const { data } = (await call(base, "list_errors")) as any;
      // The 404 is a client error: list_requests has it.
      expect(data.total).toBe(1);
      expect(data.errors[0]).toMatchObject({
        code: "INTERNAL",
        message: "database is locked",
        status: 500,
        route: "/api/pages/:id",
        service: "pages",
        action: "get",
        traceId: "boom-1",
      });
      expect(data.errors[0].stack).toContain("pages.ts:12:3");
    } finally {
      stop();
    }
  });

  it("describes the app's architecture, with its schedules and workflows", async () => {
    const { base, stop } = await dev();
    try {
      const { data } = (await call(base, "app_overview")) as any;
      expect(data.mode).toBe("dev");
      expect(data.services).toEqual([
        {
          name: "pages",
          actions: [
            { name: "get", route: "GET /api/pages/:id", access: "public" },
          ],
          tools: ["findPage"],
        },
      ]);
      expect(data.workflows).toEqual(["reindex"]);
      expect(data.schedules[0]).toMatchObject({ name: "nightly" });
      expect(data.listeners[0]).toMatchObject({ name: "reindex" });

      const empty = await dev({ seeded: false });
      try {
        const { data } = (await call(empty.base, "app_overview")) as any;
        expect(data.note).toContain("not reported");
      } finally {
        empty.stop();
      }
    } finally {
      stop();
    }
  });

  it("ranks the slowest endpoints the same from memory and from history", async () => {
    const memory = await dev();
    const stored = await dev({ history: true });
    try {
      const [fromMemory, fromHistory] = await Promise.all(
        [memory, stored].map(
          async ({ base }) => ((await call(base, "summary")) as any).data,
        ),
      );
      expect([fromMemory.source, fromHistory.source]).toEqual([
        "memory",
        "history",
      ]);
      expect(fromHistory.slowestEndpoints).toEqual(fromMemory.slowestEndpoints);
      expect(fromMemory.slowestEndpoints[0]).toMatchObject({
        endpoint: "GET /api/slow",
        requests: 1,
        serverErrors: 0,
      });
      expect(fromMemory.slowestEndpoints[0].avgMs).toBeGreaterThan(800);
      expect(fromMemory.slowestEndpoints[0].maxMs).toBe(
        fromMemory.slowestEndpoints[0].avgMs,
      );
      const failing = fromMemory.slowestEndpoints.find(
        (item: { endpoint: string }) => item.endpoint === "GET /api/pages/:id",
      );
      expect(failing).toMatchObject({ requests: 3, serverErrors: 1 });
    } finally {
      memory.stop();
      stored.stop();
    }
  });

  it("reads stored history when there is some, and a running request from memory", async () => {
    const { base, store, stop } = await dev({ history: true });
    try {
      const summary = (await call(base, "summary")) as any;
      expect(summary.data).toMatchObject({ source: "history", requests: 4 });
      const list = (await call(base, "list_requests", {
        outcome: "client",
      })) as any;
      expect(list.data).toMatchObject({ source: "history", total: 1 });
      expect(
        ((await call(base, "get_trace", { trace_id: "boom-1" })) as any).data
          .outcome,
      ).toBe("server");

      // Not finished, so not on disk yet.
      store.ingest(
        [
          {
            phase: "start",
            traceId: "running-1",
            spanId: "root",
            name: "GET /api/wait",
            startMs: Date.now(),
            attributes: root("GET", "/api/wait"),
          },
        ],
        1,
      );
      const running = (await call(base, "get_trace", {
        trace_id: "running-1",
      })) as any;
      expect(running.data.state).toBe("running");
    } finally {
      stop();
    }
  });
});

describe("the MCP endpoint's access", () => {
  async function production(mcp?: boolean) {
    const store = new DevTelemetryStore();
    seed(store);
    const dashboard = await startDevDashboard({
      port: 0,
      store,
      mode: "production",
      auth: { token },
      ...(mcp === undefined ? {} : { mcp }),
    });
    return { base: `http://127.0.0.1:${dashboard.port}`, dashboard };
  }

  it("is off in production unless the app asks for it", async () => {
    const { base, dashboard } = await production();
    try {
      const response = await post(base, rpc("tools/list"), bearer);
      expect(response.status).toBe(404);
      const off = await production(false);
      try {
        expect((await post(off.base, rpc("tools/list"), bearer)).status).toBe(
          404,
        );
      } finally {
        off.dashboard.stop();
      }
    } finally {
      dashboard.stop();
    }
  });

  it("needs the dashboard's token when it is on", async () => {
    const { base, dashboard } = await production(true);
    try {
      expect((await post(base, rpc("tools/list"))).status).toBe(401);
      expect(
        (
          await post(base, rpc("tools/list"), {
            authorization: "Bearer wrong-wrong-wrong-wrong",
          })
        ).status,
      ).toBe(401);
      const allowed = await post(base, rpc("tools/list"), bearer);
      expect(allowed.status).toBe(200);
      expect((await allowed.json()).result.tools).toHaveLength(5);
      expect(allowed.headers.get("cache-control")).toBe("no-store");
      // The agent sends the Bearer header on a tool call too.
      const summary = await call(base, "summary", {}, bearer);
      expect(summary).toMatchObject({ isError: false });
    } finally {
      dashboard.stop();
    }
  });

  it("refuses a request from another origin, with or without the token", async () => {
    const { base, dashboard } = await production(true);
    const dev_ = await dev();
    try {
      for (const target of [base, dev_.base]) {
        const headers = target === base ? bearer : {};
        const foreign = await post(target, rpc("tools/list"), {
          ...headers,
          origin: "https://evil.example",
        });
        expect(foreign.status).toBe(403);
        const rebound = await post(target, rpc("tools/list"), {
          ...headers,
          origin: "http://localhost:1",
        });
        expect(rebound.status).toBe(403);
        const cross = await post(target, rpc("tools/list"), {
          ...headers,
          "sec-fetch-site": "cross-site",
        });
        expect(cross.status).toBe(403);
        // The dashboard's own origin, and a client that sends none, are fine.
        const own = await post(target, rpc("tools/list"), {
          ...headers,
          origin: target,
        });
        expect(own.status).toBe(200);
      }
    } finally {
      dashboard.stop();
      dev_.stop();
    }
  });

  it("is on in dev, and answers only a local host", async () => {
    const { base, stop } = await dev();
    try {
      expect((await post(base, rpc("tools/list"))).status).toBe(200);
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { host: "evil.example", "content-type": "application/json" },
        body: rpc("tools/list"),
      });
      expect(response.status).toBe(403);
    } finally {
      stop();
    }
  });

  it("refuses a body over the limit", async () => {
    const { base, stop } = await dev();
    try {
      const response = await post(base, "x".repeat(2 * 1024 * 1024));
      expect(response.status).toBe(413);
    } finally {
      stop();
    }
  });
});
