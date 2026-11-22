import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Effect } from "effect";
import { integer, sqliteTable } from "drizzle-orm/sqlite-core";
import {
  ActionExecutionError,
  brick,
  compileBrickApplication,
  defineDatabase,
  defineListener,
  defineSchedule,
  defineService,
  getPluginEndpoints,
  defineServicePlugin,
  outboxTable,
  resetGlobalRegistry,
  scheduleTable,
  syncSchema,
  t,
} from "../src";
import { settle } from "../src/effect";
import { createTestApp } from "../src/testing";
import { postJson, track } from "./helpers";

afterEach(resetGlobalRegistry);

let serial = 0;
const items = sqliteTable("effect_items", { id: integer("id").primaryKey() });

function serve(
  define: (service: ReturnType<typeof defineService>) => unknown,
  options: Parameters<typeof defineService>[1] = {},
) {
  const service = defineService(`effect_${++serial}`, options);
  const action = define(service) as any;
  const { app } = createTestApp({ services: [service] });
  return {
    action,
    post: (name: string, body: unknown = {}) =>
      postJson(app, `/api/${service.name}/${name}`, body),
  };
}

describe("settle", () => {
  it("returns a value or a Promise untouched, and runs an Effect", async () => {
    const promise = Promise.resolve(1);
    expect(settle(1)).toBe(1);
    expect(settle(promise)).toBe(promise);
    expect(await settle(Effect.succeed(2))).toBe(2);
  });

  it("throws the original error of a failed Effect, or of a defect", async () => {
    const failure = new ActionExecutionError("TAKEN", "Taken", 409);
    await expect(settle(Effect.fail(failure))).rejects.toBe(failure);
    const defect = new Error("boom");
    await expect(settle(Effect.die(defect))).rejects.toBe(defect);
  });
});

describe("an action's execute returning an Effect", () => {
  const log = () => spyOn(console, "error").mockImplementation(() => {});

  it("answers over HTTP and in-process, and checks the output", async () => {
    const { action, post } = serve((service) =>
      service.action({
        name: "add",
        input: t.Object({ a: t.Number(), b: t.Number() }),
        output: t.Object({ sum: t.Number() }),
        execute: ({ input }) =>
          Effect.gen(function* () {
            const a = yield* Effect.succeed(input.a);
            return { sum: a + input.b };
          }),
      }),
    );
    const response = await post("add", { a: 1, b: 2 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sum: 3 });
    expect(await action.run({ a: 2, b: 3 })).toEqual({ sum: 5 });
    expect(await action.execute({ input: { a: 4, b: 4 } })).toEqual({ sum: 8 });
  });

  it("still validates the output", async () => {
    const spy = log();
    const { action, post } = serve((service) =>
      service.action({
        name: "bad",
        output: t.Object({ sum: t.Number() }),
        execute: () => Effect.succeed({ sum: "no" } as any),
      }),
    );
    expect((await post("bad")).status).toBe(500);
    await expect(action.run()).rejects.toMatchObject({ status: 500 });
    spy.mockRestore();
  });

  it("maps a Brick error from Effect.fail or thrown in Effect.gen to its status and code", async () => {
    const { action, post } = serve((service) => {
      service.action({
        name: "failed",
        execute: () =>
          Effect.fail(new ActionExecutionError("TAKEN", "Taken", 409)),
      });
      return service.action({
        name: "missing",
        execute: ({ error }) =>
          Effect.gen(function* () {
            yield* Effect.void;
            return error.NOT_FOUND("No such page");
          }),
      });
    });
    const failed = await post("failed");
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ code: "TAKEN" });
    const missing = await post("missing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "NOT_FOUND" });
    await expect(action.run()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers 500 for an unexpected failure or a defect", async () => {
    const spy = log();
    const { post } = serve((service) => {
      service.action({
        name: "failed",
        execute: () => Effect.fail(new Error("private detail")),
      });
      service.action({
        name: "died",
        execute: () => Effect.die("private detail"),
      });
    });
    for (const name of ["failed", "died"]) {
      const response = await post(name);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("private detail");
    }
    spy.mockRestore();
  });

  it("refuses with 401 or 403 when authorize's Effect is false", async () => {
    const options = (user?: object) => ({ context: () => ({ user }) });
    for (const [user, status] of [
      [undefined, 401],
      [{ id: "u" }, 403],
    ] as const) {
      const { post } = serve(
        (service) =>
          service.action({
            name: "guarded",
            authorize: () => Effect.succeed(false),
            execute: () => "ran",
          }),
        options(user),
      );
      expect((await post("guarded")).status).toBe(status);
    }
    const { post } = serve((service) =>
      service.action({
        name: "open",
        authorize: () => Effect.succeed(true),
        execute: () => Effect.succeed("ran"),
      }),
    );
    expect(await (await post("open")).text()).toBe("ran");
  });

  it("takes an Effect from the service's context hook", async () => {
    const { post } = serve(
      (service) =>
        service.action({
          name: "who",
          execute: ({ ctx }) => (ctx as any).name,
        }),
      { context: () => Effect.succeed({ name: "alice" }) },
    );
    expect(await (await post("who")).text()).toBe("alice");
  });

  it("keeps a handler with no Effect synchronous", () => {
    const service = defineService(`effect_${++serial}`);
    service.action({
      name: "plain",
      method: "GET",
      execute: () => ({ ok: true }),
    });
    const route = compileBrickApplication({ services: [service] }).routes.find(
      (r) => r.ir.method === "GET",
    )!;
    const value = route.handler({
      request: new Request("http://localhost/"),
      set: { headers: {} },
    });
    expect(value).not.toBeInstanceOf(Promise);
    expect(value).toEqual({ ok: true });
  });
});

describe("events", () => {
  it("runs a listener that returns an Effect, and parks it as dead when it fails", async () => {
    const outbox = outboxTable("sqlite");
    const database = defineDatabase({ tables: { items, outbox } });
    const db: any = database.getDb();
    syncSchema([items, outbox], db);
    const service = defineService(`effect_${++serial}`, { database });
    const seen: string[] = [];
    const app = track(
      brick({
        services: [service],
        events: {
          listeners: [
            defineListener({
              name: "ok",
              on: "ok.event",
              run: ({ payload }) =>
                Effect.sync(() => void seen.push(String((payload as any).n))),
            }),
            defineListener({
              name: "broken",
              on: "bad.event",
              maxAttempts: 1,
              run: () => Effect.fail(new Error("nope")),
            }),
          ],
          dispatch: { timer: false },
        },
        requestLogging: false,
        docs: false,
      }),
    );
    const spy = spyOn(console, "error").mockImplementation(() => {});
    await service.recorder!.transaction(
      db,
      { traceId: "t", source: "s" },
      async (_tx, record) => {
        await record("ok.event", { n: 7 });
        await record("bad.event", { n: 8 });
      },
    );
    await app.events!.drain();
    spy.mockRestore();
    expect(seen).toEqual(["7"]);
    expect(await app.events!.counts()).toMatchObject({ delivered: 1, dead: 1 });
  });

  it("runs a schedule that returns an Effect", async () => {
    const table = scheduleTable("sqlite");
    const database = defineDatabase({ tables: { schedules: table } });
    syncSchema([table], database.getDb() as any);
    const service = defineService(`effect_${++serial}`, { database });
    const runs: string[] = [];
    const app = track(
      brick({
        services: [service],
        events: {
          schedules: [
            defineSchedule({
              name: "tick",
              every: "1h",
              run: ({ schedule }) =>
                Effect.sync(() => void runs.push(schedule)),
            }),
          ],
          dispatch: { timer: false },
        },
        requestLogging: false,
        docs: false,
      }),
    );
    expect(await app.events!.schedules!.drain()).toBe(1);
    expect(runs).toEqual(["tick"]);
  });
});

describe("plugins", () => {
  it("answers a plugin endpoint that returns an Effect", async () => {
    const service = defineService(`effect_${++serial}`);
    service.use(
      defineServicePlugin({
        name: "effectful",
        setup({ routes }) {
          routes.endpoint({
            name: "raw",
            method: "GET",
            path: "/raw",
            handler: () => Effect.succeed("from effect"),
          });
        },
      }),
    );
    const [endpoint] = getPluginEndpoints(service);
    expect(
      await endpoint.handler({
        request: new Request("http://localhost/"),
      } as any),
    ).toBe("from effect");
  });
});
