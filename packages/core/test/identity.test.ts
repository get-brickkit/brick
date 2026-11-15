import { beforeEach, describe, expect, it } from "bun:test";
import {
  brick,
  createMcpRegistry,
  definePlugin,
  defineService,
  defineTool,
  resetGlobalRegistry,
  t,
  useService,
  type Service,
} from "../src";
import { hasIdentity, identityOf, type Identity } from "../src/identity";
import { portOf } from "../src/service-port";
import { openSocket, postJson, track } from "./helpers";

beforeEach(resetGlobalRegistry);

/** A service whose `identity` hook reads `x-user` through `context`, counting its runs. */
function crm(name = "crm") {
  const runs = { count: 0 };
  const service = defineService(name, {
    deps: { org: "acme" },
    context: ({ request }) => ({ user: request.headers.get("x-user") }),
    identity: async (ctx) => {
      runs.count++;
      await Promise.resolve();
      return ctx.user ? { id: ctx.user, tenant: ctx.deps.org } : null;
    },
  });
  return { service, runs };
}
const as = (user?: string) =>
  new Request("http://localhost", {
    headers: user ? { "x-user": user } : {},
  });

describe("identity", () => {
  it("runs the hook once per call, on the first ask, and keeps the result", async () => {
    const { service, runs } = crm();
    const who = service.action({
      name: "who",
      output: t.Any(),
      execute: async ({ ctx }) => {
        const first = await identityOf(ctx);
        // A copy of ctx is the same call.
        const again = await Promise.all([
          identityOf(ctx),
          identityOf({ ...ctx }),
        ]);
        return { first, same: again.every((one) => one === first) };
      },
    });
    expect(await who.execute({ ctx: { request: as("u1") } })).toEqual({
      first: { id: "u1", tenant: "acme" },
      same: true,
    });
    expect(runs.count).toBe(1);
    await who.execute({ ctx: { request: as("u2") } });
    expect(runs.count).toBe(2);
  });

  it("does not run the hook in a call that never asks", async () => {
    const { service, runs } = crm();
    const ping = service.action({ name: "ping", execute: () => "pong" });
    await ping.execute({ ctx: { request: as("u1") } });
    expect(runs.count).toBe(0);
  });

  it("is null for an anonymous caller and for a service without the hook", async () => {
    const { service } = crm();
    const who = service.action({
      name: "who",
      output: t.Any(),
      execute: ({ ctx }) => identityOf(ctx),
    });
    expect(await who.execute({ ctx: { request: as() } })).toBeNull();

    const plain = defineService("plain");
    const anon = plain.action({
      name: "who",
      output: t.Any(),
      execute: ({ ctx }) => identityOf(ctx),
    });
    expect(await anon.execute({})).toBeNull();
    expect(hasIdentity(service)).toBe(true);
    expect(hasIdentity(plain)).toBe(false);
  });

  it("resolves the callee's own identity on an in-process call", async () => {
    const callee = defineService("callee", {
      context: () => ({ robot: "r2" }),
      identity: (ctx) => ({ id: ctx.robot }),
    });
    callee.action({
      name: "who",
      output: t.Any(),
      execute: ({ ctx }) => identityOf(ctx),
    });
    const { service } = crm("caller");
    const call = service.action({
      name: "call",
      output: t.Any(),
      execute: async ({ ctx }) => ({
        mine: await identityOf(ctx),
        theirs: await (useService(callee) as any).who({}, ctx),
      }),
    });
    expect(await call.execute({ ctx: { request: as("u1") } })).toEqual({
      mine: { id: "u1", tenant: "acme" },
      theirs: { id: "r2" },
    });
  });

  it("rejects a hook that returns something other than an identity", async () => {
    const bad = defineService("bad", {
      identity: () => ({ id: 42 }) as unknown as Identity,
    });
    const ctx = await portOf(bad).resolveContext();
    await expect(identityOf(ctx)).rejects.toThrow(
      'Service "bad": identity must return',
    );
  });

  it("keeps the identity for a copy of the context with another user", async () => {
    const { service, runs } = crm();
    const inner = service.action({
      name: "inner",
      output: t.Any(),
      execute: async ({ ctx }) => ({
        user: ctx.user,
        identity: await identityOf(ctx),
      }),
    });
    const outer = service.action({
      name: "outer",
      output: t.Any(),
      execute: async ({ ctx }) => {
        await identityOf(ctx);
        return inner.execute({ ctx: { ...ctx, user: "admin" } });
      },
    });
    // The copy says "admin", but the call is still u1's.
    expect(await outer.execute({ ctx: { request: as("u1") } })).toEqual({
      user: "admin",
      identity: { id: "u1", tenant: "acme" },
    });
    expect(runs.count).toBe(1);
  });

  it("keeps only id, label and tenant of what the hook returns, and refuses an empty id", async () => {
    const leaky = defineService("leaky", {
      context: () => ({
        user: { id: "u1", label: "Ada", passwordHash: "secret" },
      }),
      identity: (ctx) => ctx.user,
    });
    const ctx = await portOf(leaky).resolveContext();
    expect(await identityOf(ctx)).toEqual({ id: "u1", label: "Ada" });

    const empty = defineService("empty", { identity: () => ({ id: "" }) });
    await expect(
      identityOf(await portOf(empty).resolveContext()),
    ).rejects.toThrow('Service "empty": identity must return');
  });
});

describe("identity over the transports", () => {
  const app = (...services: Service<any, any>[]) =>
    brick({ services, docs: false, requestLogging: false });
  const post = async (
    target: { handle(request: Request): Promise<Response> },
    path: string,
    user: string,
  ) => (await postJson(target, path, {}, { "x-user": user })).json();

  it("runs the hook over HTTP, once for the request and the calls it passes its ctx to", async () => {
    const { service, runs } = crm();
    const inner = service.action({
      name: "inner",
      output: t.Any(),
      execute: ({ ctx }) => identityOf(ctx),
    });
    service.action({
      name: "who",
      output: t.Any(),
      execute: async ({ ctx }) => [
        await inner.execute({ ctx }),
        await inner.execute({ ctx }),
      ],
    });
    // No `context` hook and no `authorize`: the route's synchronous path.
    const bare = defineService("bare", {
      identity: (ctx) => ({ id: ctx.request.headers.get("x-user")! }),
    });
    bare.action({
      name: "who",
      output: t.Any(),
      execute: ({ ctx }) => identityOf(ctx),
    });
    const server = app(service, bare);
    const u1 = { id: "u1", tenant: "acme" };
    expect(await post(server, "/api/crm/who", "u1")).toEqual([u1, u1]);
    expect(runs.count).toBe(1);
    expect(await post(server, "/api/bare/who", "u2")).toEqual({ id: "u2" });
  });

  it("runs the host's hook, with the host's deps, for a plugin's action over HTTP", async () => {
    const audit = definePlugin({
      name: "@acme/audit",
      deps: { org: "" as string },
      service: ({ service }) => {
        service.action({
          name: "pluginWho",
          output: t.Any(),
          execute: ({ ctx }) => identityOf(ctx),
        });
      },
    });
    const { service } = crm();
    service.use(audit({}, { deps: { org: "plugin" } }));
    expect(await post(app(service), "/api/crm/plugin-who", "u1")).toEqual({
      id: "u1",
      tenant: "acme",
    });
  });

  it("resolves the identity in a tool call", async () => {
    const { service } = crm();
    service.tool(
      defineTool({
        name: "crm_whoami",
        input: t.Object({}),
        output: t.Any(),
        execute: ({ ctx }) => identityOf(ctx),
      }),
    );
    const registry = createMcpRegistry({ services: [service] });
    expect(
      await registry.callTool("crm_whoami", {}, { request: as("u1") }),
    ).toEqual({ id: "u1", tenant: "acme" });
  });

  it("resolves the identity in a socket handler", async () => {
    const { service } = crm();
    service.socket({
      name: "live",
      input: {},
      handlers: {},
      output: { who: t.Json() },
      allowMissingOrigin: true,
      open: async ({ ctx, socket }) =>
        socket.send("who", { ...(await identityOf(ctx)) }),
    });
    const server = track(app(service).listen(0));
    const ws = await openSocket(
      `http://localhost:${server.server!.port}/api/crm/live`,
      { "x-user": "u1" },
    );
    const first = await new Promise<unknown>((resolve) => {
      ws.onmessage = ({ data }) => resolve(JSON.parse(String(data)));
    });
    expect(first).toMatchObject({ data: { id: "u1", tenant: "acme" } });
  });
});
