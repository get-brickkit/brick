import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  brick,
  definePlugin,
  defineService,
  resetGlobalRegistry,
  signDashboardIdentity,
  t,
} from "@brickkit/core";
import { startDevDashboard } from "../src/dev-dashboard";
import { DevTelemetryStore } from "../src/dev-telemetry-store";

beforeEach(resetGlobalRegistry);

const token = "0123456789abcdef-secret";
const agentKey = "agent-api-key-0123456789";
const rpc = (method: string, params?: unknown, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

/** What the tools saw, to check who they thought was calling. */
const refunds: { orderId: string; by?: string }[] = [];

const support = definePlugin({
  name: "@acme/brick-support",
  service: ({ service }) => {
    service.tool({
      name: "support_note",
      description: "Read the support note on an order",
      dashboard: true,
      annotations: { readOnlyHint: true },
      input: t.Object({ orderId: t.String() }),
      execute: ({ input }) => `note for ${input.orderId}`,
    });
  },
});

function appWithTools() {
  const service = defineService("billing");
  service.tool({
    name: "find_order",
    description: "Look an order up by id.",
    dashboard: true,
    annotations: { readOnlyHint: true },
    input: t.Object({ id: t.String() }),
    output: t.Object({ id: t.String(), totalCents: t.Number() }),
    execute: ({ input }) => ({ id: input.id, totalCents: 1200 }),
  });
  service.tool({
    name: "create_refund",
    description: "Refund an order.",
    dashboard: true,
    input: t.Object({ orderId: t.String() }),
    output: t.Object({ refunded: t.String() }),
    execute: ({ input, ctx }) => {
      refunds.push({ orderId: input.orderId, by: ctx.dashboard?.user?.id });
      return { refunded: input.orderId };
    },
  });
  service.tool({
    name: "close_account",
    description: "Close an account.",
    dashboard: true,
    // The author's own value is kept.
    annotations: { destructiveHint: false },
    input: t.Object({ id: t.String() }),
    execute: () => "closed",
  });
  service.tool({
    name: "admin_refund",
    description: "Refund an order, for admins only.",
    dashboard: true,
    input: t.Object({ orderId: t.String() }),
    authorize: ({ ctx }) => ctx.dashboard?.user?.id === "admin",
    execute: () => "refunded",
  });
  // Not marked: for an agent that talks to the app itself, not the dashboard.
  service.tool({
    name: "not_for_the_dashboard",
    input: t.Object({}),
    execute: () => "x",
  });
  service.action({ name: "ping", dashboard: true, execute: () => "pong" });
  service.use(support());
  return brick({ services: [service], requestLogging: false });
}

const open: { stop(): void }[] = [];
afterEach(() => {
  for (const item of open.splice(0)) item.stop();
  refunds.length = 0;
});

async function setup(
  options: {
    mode?: "dev" | "production";
    auth?: Parameters<typeof startDevDashboard>[0]["auth"];
  } = {},
) {
  const app = appWithTools();
  const server = Bun.serve({
    port: 0,
    fetch: (request) => app.handle(request),
  });
  const store = new DevTelemetryStore();
  const dashboard = await startDevDashboard({
    port: 0,
    store,
    appUrl: `http://127.0.0.1:${server.port}`,
    mode: options.mode ?? "dev",
    ...(options.mode === "production" ? { mcp: true } : {}),
    auth: options.auth,
  });
  open.push({
    stop() {
      dashboard.stop();
      void server.stop(true);
    },
  });
  return {
    base: `http://127.0.0.1:${dashboard.port}`,
    appUrl: `http://127.0.0.1:${server.port}`,
  };
}

const post = (
  base: string,
  body: string,
  headers: Record<string, string> = {},
) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

async function names(base: string, headers: Record<string, string> = {}) {
  const { result } = await (
    await post(base, rpc("tools/list"), headers)
  ).json();
  return result.tools.map((tool: { name: string }) => tool.name) as string[];
}

async function call(
  base: string,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const { result, error } = await (
    await post(base, rpc("tools/call", { name, arguments: args }), headers)
  ).json();
  return { result, error };
}

const BUILT_IN = [
  "summary",
  "list_requests",
  "get_trace",
  "list_errors",
  "app_overview",
];
const READ_TOOLS = ["find_order", "support_note"];
const WRITE_TOOLS = ["create_refund", "close_account", "admin_refund"];

describe("the app's tools on the dashboard's /mcp, in brick dev", () => {
  it("lists a dashboard: true tool, a plugin's too, and leaves out one without the mark", async () => {
    const { base } = await setup();
    const listed = await names(base);
    expect(listed.slice(0, 5)).toEqual(BUILT_IN);
    expect(listed.slice(5).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].sort(),
    );
    expect(listed).not.toContain("not_for_the_dashboard");
    const refused = await call(base, "not_for_the_dashboard", {});
    expect(refused.error.code).toBe(-32602);
  });

  it("describes each tool as the app does, with the hints agents act on", async () => {
    const { base } = await setup();
    const { result } = await (await post(base, rpc("tools/list"))).json();
    const tool = (name: string) =>
      result.tools.find((item: { name: string }) => item.name === name);
    expect(tool("find_order")).toMatchObject({
      description: "Look an order up by id.",
      annotations: { readOnlyHint: true },
    });
    expect(tool("find_order").inputSchema.properties.id).toBeDefined();
    expect(tool("find_order").outputSchema.properties.totalCents).toBeDefined();
    // A tool that is not marked read-only advertises destructiveHint ...
    expect(tool("create_refund").annotations).toEqual({
      destructiveHint: true,
    });
    // ... unless its author said otherwise.
    expect(tool("close_account").annotations).toEqual({
      destructiveHint: false,
    });
  });

  it("calls a read tool and a write tool, on the developer's own machine", async () => {
    const { base } = await setup();
    const read = await call(base, "find_order", { id: "o1" });
    expect(read.result.isError).toBeUndefined();
    expect(read.result.structuredContent).toEqual({
      id: "o1",
      totalCents: 1200,
    });
    const write = await call(base, "create_refund", { orderId: "o1" });
    expect(write.result.structuredContent).toEqual({ refunded: "o1" });
    // `/app` gives no user in dev, so neither does this.
    expect(refunds).toEqual([{ orderId: "o1", by: undefined }]);
    expect(
      (await call(base, "support_note", { orderId: "o1" })).result.content[0]
        .text,
    ).toBe("note for o1");
  });

  it("validates a tool's input, and its own authorize still refuses", async () => {
    const { base } = await setup();
    const invalid = await call(base, "find_order", {});
    expect(invalid.result.isError).toBe(true);
    const refused = await call(base, "admin_refund", { orderId: "o1" });
    expect(refused.result.isError).toBe(true);
  });
});

describe("the app's tools on /mcp, in production", () => {
  it("shows read tools to a token, and no write tool, and refuses one by name", async () => {
    const { base } = await setup({ mode: "production", auth: { token } });
    const headers = { authorization: `Bearer ${token}` };
    const listed = await names(base, headers);
    expect(listed.slice(5).sort()).toEqual(READ_TOOLS.sort());
    expect(
      (await call(base, "find_order", { id: "o1" }, headers)).result.isError,
    ).toBeUndefined();
    const refused = await call(
      base,
      "create_refund",
      { orderId: "o1" },
      headers,
    );
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("signed-in user");
    expect(refunds).toEqual([]);
  });

  it("treats authorize returning true like a token: it can read and not change", async () => {
    const { base } = await setup({
      mode: "production",
      auth: { authorize: () => true },
    });
    expect((await names(base)).slice(5).sort()).toEqual(READ_TOOLS.sort());
    const refused = await call(base, "create_refund", { orderId: "o1" });
    expect(refused.result.isError).toBe(true);
    expect(refunds).toEqual([]);
  });

  it("lists and runs write tools for a signed-in user, who is ctx.dashboard.user", async () => {
    const { base } = await setup({
      mode: "production",
      auth: {
        authorize: (request) =>
          request.headers.get("authorization") === `Bearer ${agentKey}`
            ? { user: { id: "agent-1", name: "Agent" } }
            : false,
      },
    });
    const headers = { authorization: `Bearer ${agentKey}` };
    expect((await post(base, rpc("tools/list"))).status).toBe(401);
    const listed = await names(base, headers);
    expect(listed.slice(5).sort()).toEqual(
      [...READ_TOOLS, ...WRITE_TOOLS].sort(),
    );
    const done = await call(base, "create_refund", { orderId: "o9" }, headers);
    expect(done.result.structuredContent).toEqual({ refunded: "o9" });
    expect(refunds).toEqual([{ orderId: "o9", by: "agent-1" }]);
    // The tool's own authorize still decides: this user is not "admin".
    const denied = await call(base, "admin_refund", { orderId: "o9" }, headers);
    expect(denied.result.isError).toBe(true);
  });

  it("still has no write tool of the dashboard's own", async () => {
    const { base } = await setup({
      mode: "production",
      auth: { authorize: () => ({ user: { id: "u" } }) },
    });
    const { result } = await (await post(base, rpc("tools/list"))).json();
    for (const tool of result.tools.filter((item: { name: string }) =>
      BUILT_IN.includes(item.name),
    ))
      expect(tool.annotations).toEqual({ readOnlyHint: true });
  });

  it("answers a tool error, not a crash, when the app is not there", async () => {
    const store = new DevTelemetryStore();
    const dashboard = await startDevDashboard({
      port: 0,
      store,
      appUrl: "http://127.0.0.1:1",
    });
    open.push({ stop: () => dashboard.stop() });
    const base = `http://127.0.0.1:${dashboard.port}`;
    expect(await names(base)).toEqual(BUILT_IN);
    const answer = await call(base, "find_order", { id: "o1" });
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toContain("did not answer");
  });
});

describe("the /app proxy and the app's MCP route", () => {
  it("does not forward to Brick's own routes, so a token cannot reach the MCP route through /app", async () => {
    const { base } = await setup({ auth: { token } });
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const body = rpc("tools/call", {
      name: "create_refund",
      arguments: { orderId: "o1" },
    });
    for (const path of [
      "/app/_brick/dashboard/mcp",
      "/app//_brick/dashboard/mcp",
      "/app/%5Fbrick/dashboard/mcp",
      "/app/_brick%2Fdashboard%2Fmcp",
      "/app/%5fbrick%2fdashboard/mcp",
      "/app/api/../_brick/dashboard/mcp",
      "/app/api/%2e%2e/_brick/dashboard/mcp",
      "/app/%252F_brick/dashboard/mcp",
      "/app/_BRICK/dashboard/mcp",
      "/app/_brick/services",
    ]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body,
      });
      expect([path, response.status]).toEqual([path, 404]);
    }
    expect(refunds).toEqual([]);
  });

  it("still forwards the paths pages use", async () => {
    const { base } = await setup({ auth: { token } });
    const headers = { authorization: `Bearer ${token}` };
    const ping = await fetch(`${base}/app/api/billing/ping`, {
      method: "POST",
      headers,
    });
    expect(ping.status).toBe(200);
    expect(await ping.text()).toBe("pong");
  });

  it("does not let a /app-signed request run a write tool at the app", async () => {
    const { appUrl } = await setup({ auth: { token } });
    // What /app signs for a token caller: an identity with no user, no scope.
    const replay = await fetch(`${appUrl}/_brick/dashboard/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-brick-dashboard": signDashboardIdentity({}),
      },
      body: rpc("tools/call", {
        name: "create_refund",
        arguments: { orderId: "o1" },
      }),
    });
    expect(replay.status).toBe(401);
    expect(refunds).toEqual([]);
  });
});
