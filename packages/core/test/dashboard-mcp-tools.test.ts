import { beforeEach, describe, expect, it } from "bun:test";
import {
  DASHBOARD_IDENTITY_HEADER,
  DASHBOARD_MCP_ROUTE,
  brick,
  defineService,
  resetGlobalRegistry,
  signDashboardIdentity,
  t,
} from "../src";

beforeEach(resetGlobalRegistry);

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
    name: "who",
    dashboard: true,
    execute: ({ ctx }) => ctx.dashboard?.user?.id ?? "nobody",
  });
  service.tool({ name: "for_agents_only", execute: () => "x" });
  return brick({ services: [service], requestLogging: false });
}

const rpc = (
  app: ReturnType<typeof setup>,
  method: string,
  params?: unknown,
  identity?: object,
) =>
  app.handle(
    new Request(`http://localhost${DASHBOARD_MCP_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(identity
          ? { [DASHBOARD_IDENTITY_HEADER]: signDashboardIdentity(identity) }
          : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );

describe("the app's MCP for the dashboard", () => {
  it("answers only a request the dashboard signed", async () => {
    const app = setup();
    expect((await rpc(app, "tools/list")).status).toBe(401);
    const forged = await app.handle(
      new Request(`http://localhost${DASHBOARD_MCP_ROUTE}`, {
        method: "POST",
        headers: { [DASHBOARD_IDENTITY_HEADER]: "e30.AAAA" },
        body: "{}",
      }),
    );
    expect(forged.status).toBe(401);
  });

  it("lists the tools marked dashboard: true, and no others", async () => {
    const app = setup();
    const { result } = await (await rpc(app, "tools/list", {}, {})).json();
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "find_order",
      "who",
    ]);
    expect(result.tools[0]).toMatchObject({
      description: "Look an order up",
      annotations: { readOnlyHint: true },
    });
    expect(result.tools[0].inputSchema.properties.id).toBeDefined();
  });

  it("runs a tool with the signed identity as ctx.dashboard", async () => {
    const app = setup();
    const call = async (identity: object) =>
      (
        await (
          await rpc(app, "tools/call", { name: "who", arguments: {} }, identity)
        ).json()
      ).result.content[0].text;
    expect(await call({ user: { id: "u1", name: "Ada" } })).toBe("u1");
    expect(await call({})).toBe("nobody");
  });

  it("refuses a dashboard tool the dashboard's MCP already has a tool for", () => {
    const service = defineService("clash");
    service.tool({ name: "summary", dashboard: true, execute: () => "x" });
    expect(() => brick({ services: [service] })).toThrow(
      /'summary' is marked dashboard: true/,
    );
    // Without the mark it is an ordinary tool.
    const other = defineService("fine");
    other.tool({ name: "summary", execute: () => "x" });
    expect(() => brick({ services: [other] })).not.toThrow();
  });
});
