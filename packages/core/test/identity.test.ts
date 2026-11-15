import { beforeEach, describe, expect, it } from "bun:test";
import { defineService, resetGlobalRegistry, t, useService } from "../src";
import { hasIdentity, identityOf, type Identity } from "../src/identity";
import { portOf } from "../src/service-port";

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
});
