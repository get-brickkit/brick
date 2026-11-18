import { beforeEach, describe, expect, it } from "bun:test";
import {
  DASHBOARD_IDENTITY_HEADER,
  DASHBOARD_MCP_ROUTE,
  brick,
  defineService,
  resetGlobalRegistry,
  signDashboardIdentity,
  signDashboardMcp,
  t,
} from "../src";

beforeEach(resetGlobalRegistry);

const changes: (string | undefined)[] = [];

function setup() {
  const service = defineService("billing");
  service.tool({
    name: "find_order",
    description: "Look an order up",
    dashboard: true,
    annotations: { readOnlyHint: true },
    input: t.Object({ id: t.String() }),
    output: t.Object({ id: t.String() }),
    execute: ({ input }) => ({ id: input.id }),
  });
  service.tool({
    name: "change",
    dashboard: true,
    execute: ({ ctx }) => {
      changes.push(ctx.dashboard?.user?.id);
      return ctx.dashboard?.user?.id ?? "nobody";
    },
  });
  service.tool({ name: "for_agents_only", execute: () => "x" });
  service.action({
    name: "ping",
    dashboard: true,
    execute: () => "pong",
  });
  return brick({ services: [service], requestLogging: false });
}

type App = ReturnType<typeof setup>;
const post = (app: App, path: string, signature?: string, body?: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature ? { [DASHBOARD_IDENTITY_HEADER]: signature } : {}),
      },
      body: JSON.stringify(body ?? {}),
    }),
  );
const rpc = (app: App, method: string, params?: unknown, signature?: string) =>
  post(app, DASHBOARD_MCP_ROUTE, signature, {
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

const reader = signDashboardMcp({ write: false });
const writer = (id = "u1") => signDashboardMcp({ user: { id }, write: true });

describe("the app's MCP for the dashboard", () => {
  it("answers only a request the dashboard's MCP signed for it", async () => {
    const app = setup();
    expect((await rpc(app, "tools/list")).status).toBe(401);
    expect((await rpc(app, "tools/list", {}, "e30.AAAA")).status).toBe(401);
    expect((await rpc(app, "tools/list", {}, reader)).status).toBe(200);
  });

  it("does not take a signature the /app proxy made", async () => {
    const app = setup();
    const viaApp = signDashboardIdentity({ user: { id: "u1" } });
    expect((await rpc(app, "tools/list", {}, viaApp)).status).toBe(401);
    expect(
      (await rpc(app, "tools/list", {}, signDashboardIdentity({}))).status,
    ).toBe(401);
    const call = await rpc(
      app,
      "tools/call",
      { name: "change", arguments: {} },
      viaApp,
    );
    expect(call.status).toBe(401);
    expect(changes).toEqual([]);
  });

  it("is not an identity for anything else: a dashboard-only action refuses it", async () => {
    const app = setup();
    const ping = (signature: string) =>
      post(app, "/api/billing/ping", signature).then((r) => r.status);
    expect(await ping(signDashboardIdentity({}))).toBe(200);
    expect(await ping(writer())).toBe(401);
    expect(await ping(reader)).toBe(401);
  });

  it("lists the tools marked dashboard: true, and no others", async () => {
    const app = setup();
    const { result } = await (
      await rpc(app, "tools/list", {}, writer())
    ).json();
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "find_order",
      "change",
    ]);
    expect(result.tools[0]).toMatchObject({
      description: "Look an order up",
      annotations: { readOnlyHint: true },
    });
    expect(result.tools[0].inputSchema.properties.id).toBeDefined();
  });

  it("leaves a write tool out of the list, and refuses a call to it, without the write claim", async () => {
    const app = setup();
    const { result } = await (await rpc(app, "tools/list", {}, reader)).json();
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "find_order",
    ]);
    const call = await (
      await rpc(app, "tools/call", { name: "change", arguments: {} }, reader)
    ).json();
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain("can change data");
    const withUser = signDashboardMcp({ user: { id: "u1" }, write: false });
    const again = await (
      await rpc(app, "tools/call", { name: "change", arguments: {} }, withUser)
    ).json();
    expect(again.result.isError).toBe(true);
    expect(changes).toEqual([]);
    const read = await (
      await rpc(
        app,
        "tools/call",
        { name: "find_order", arguments: { id: "o1" } },
        reader,
      )
    ).json();
    expect(read.result.structuredContent).toEqual({ id: "o1" });
  });

  it("runs a write tool with the signed user as ctx.dashboard", async () => {
    const app = setup();
    const call = async (signature: string) =>
      (
        await (
          await rpc(
            app,
            "tools/call",
            { name: "change", arguments: {} },
            signature,
          )
        ).json()
      ).result.content[0].text;
    expect(await call(writer("u1"))).toBe("u1");
    expect(await call(signDashboardMcp({ write: true }))).toBe("nobody");
    expect(changes).toEqual(["u1", undefined]);
  });

  it("refuses a dashboard tool the dashboard's MCP already has a tool for", () => {
    const service = defineService("clash");
    service.tool({ name: "summary", dashboard: true, execute: () => "x" });
    expect(() => brick({ services: [service] })).toThrow(
      /'summary' is marked dashboard: true/,
    );
    const other = defineService("fine");
    other.tool({ name: "summary", execute: () => "x" });
    expect(() => brick({ services: [other] })).not.toThrow();
  });
});
