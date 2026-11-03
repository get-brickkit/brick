import { afterEach, describe, expect, it } from "bun:test";
import { brick, defineService, resetGlobalRegistry, t } from "../src";

const apps: ReturnType<typeof brick>[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop(true);
  resetGlobalRegistry();
});

// A bearer token "alice" is user alice; anything else is anonymous.
const resolve = async (request: Request) =>
  request.headers.get("authorization") === "Bearer alice"
    ? { id: "alice" }
    : null;
const signedIn = { authorization: "Bearer alice" };

function setup(options: Parameters<typeof brick>[0] = {}) {
  const service = defineService("notes");
  service.action({
    name: "mine",
    method: "GET",
    output: t.Object({ id: t.String() }),
    authorize: ({ user }) => user != null,
    execute: ({ ctx }) => ({ id: ctx.user.id }),
  });
  service.tool({
    name: "whoami",
    output: t.Object({ id: t.String() }),
    authorize: ({ user }) => user != null,
    execute: ({ ctx }) => ({ id: ctx.user.id }),
  });
  service.tool({
    name: "echo",
    input: t.Object({ message: t.String() }),
    output: t.String(),
    execute: ({ input }) => input.message,
  });
  service.socket({
    name: "live",
    input: { say: t.String() },
    output: { said: t.String() },
    allowMissingOrigin: true,
    authorize: ({ ctx }) => ctx.user != null,
    handlers: {
      say: ({ input, ctx, socket }) =>
        socket.send("said", `${ctx.user.id}: ${input}`),
    },
  });
  const app = brick({
    services: [service],
    docs: false,
    requestLogging: false,
    auth: { resolve },
    mcp: true,
    ...options,
  });
  apps.push(app);
  return app;
}

function rpc(
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

describe("brick({ auth })", () => {
  for (const compiler of [true, false])
    it(`feeds ctx.user to HTTP action access control (compiler: ${compiler})`, async () => {
      const app = setup({ compiler });
      const url = "http://localhost/api/notes/mine";
      expect((await app.handle(new Request(url))).status).toBe(401);
      const allowed = await app.handle(new Request(url, { headers: signedIn }));
      expect(await allowed.json()).toEqual({ id: "alice" });
    });

  it("feeds ctx.user to socket handshakes", async () => {
    const app = setup().listen(0);
    const url = `ws://localhost:${app.server!.port}/api/notes/live`;
    const open = (headers?: Record<string, string>) =>
      new Promise<WebSocket>((done, fail) => {
        const ws = new WebSocket(url, headers ? { headers } : undefined);
        ws.onopen = () => done(ws);
        ws.onerror = fail;
      });
    await expect(open()).rejects.toBeDefined();
    const ws = await open(signedIn);
    const reply = new Promise((done) =>
      ws.addEventListener("message", ({ data }) => done(JSON.parse(data)), {
        once: true,
      }),
    );
    ws.send(JSON.stringify({ event: "say", data: "hi" }));
    expect(await reply).toEqual({ event: "said", data: "alice: hi" });
    ws.close();
  });

  it("serves the provider's routes from handler and lets the rest through", async () => {
    const app = setup({
      auth: {
        resolve,
        handler: (request) =>
          new URL(request.url).pathname.startsWith("/auth/")
            ? Response.json({ provider: true })
            : undefined,
      },
    });
    const own = await app.handle(new Request("http://localhost/auth/session"));
    expect(await own.json()).toEqual({ provider: true });
    const health = await app.handle(new Request("http://localhost/_health"));
    expect(health.status).toBe(200);
  });
});

describe("brick({ mcp })", () => {
  it("lists every tool with its output schema", async () => {
    const app = setup();
    const { result } = await (await app.handle(rpc("tools/list"))).json();
    const byName = Object.fromEntries(
      result.tools.map((tool: { name: string }) => [tool.name, tool]),
    );
    expect(Object.keys(byName).sort()).toEqual(["echo", "whoami"]);
    expect(byName.whoami.outputSchema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
    });
    expect(byName.echo.outputSchema).toMatchObject({
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    });
  });

  for (const telemetry of [false, true])
    it(`runs tools as the resolved user, with structured content (telemetry: ${telemetry})`, async () => {
      const app = setup({ telemetry });
      const call = (name: string, headers = {}) =>
        app
          .handle(
            rpc("tools/call", { name, arguments: { message: "hi" } }, headers),
          )
          .then((response) => response.json());
      expect((await call("whoami", signedIn)).result.structuredContent).toEqual(
        {
          id: "alice",
        },
      );
      expect((await call("whoami")).result.isError).toBe(true);
      expect((await call("echo")).result.structuredContent).toEqual({
        result: "hi",
      });
    });

  it("rejects requests authorize refuses", async () => {
    const seen: unknown[] = [];
    const app = setup({
      mcp: {
        path: "/agents/mcp",
        authorize: ({ request, user }) => {
          seen.push(user);
          if (request.headers.get("x-blocked")) return false;
          return (
            user != null ||
            new Response(null, {
              status: 401,
              headers: { "www-authenticate": 'Bearer resource_metadata="x"' },
            })
          );
        },
      },
    });
    const at = (headers: Record<string, string>) =>
      app.handle(
        new Request("http://localhost/agents/mcp", rpc("ping", {}, headers)),
      );
    const challenged = await at({});
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get("www-authenticate")).toContain(
      "resource_metadata",
    );
    expect((await at({ ...signedIn, "x-blocked": "1" })).status).toBe(401);
    expect((await at(signedIn)).status).toBe(200);
    expect(seen).toEqual([null, { id: "alice" }, { id: "alice" }]);
    expect((await app.handle(rpc("ping"))).status).toBe(404);
  });

  it("answers GET with 405, as a stateless streamable HTTP server", async () => {
    const app = setup();
    const response = await app.handle(new Request("http://localhost/mcp"));
    expect(response.status).toBe(405);
  });
});
