import { describe, expect, it, spyOn } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  brick,
  defineDatabase,
  defineError,
  defineListener,
  t,
  defineService,
  DuplicateNameError,
  emitEvent,
  getGlobalRegistry,
  outboxTable,
  onTransactionCommit,
  runInTransaction,
  stopAllEvents,
  syncSchema,
  type CreateServerOptions,
  type EventDelivery,
  type EventsHub,
} from "../src";
import { GLOBAL_SYMBOL } from "../src/telemetry-names";
import { track, waitFor } from "./helpers";

const items = sqliteTable("items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  label: text("label").notNull(),
});
const outbox = outboxTable("sqlite");

let serial = 0;

function app(
  services: CreateServerOptions["services"],
  events: CreateServerOptions["events"],
) {
  return track(brick({ services, events, requestLogging: false, docs: false }));
}

function setup(
  listeners: Parameters<typeof defineListener>[0][],
  dispatch: object | false = {},
) {
  const database = defineDatabase({ tables: { items, outbox } });
  const db: any = database.getDb();
  syncSchema([items, outbox], db);
  const service = defineService(`events_test_${++serial}`, { database });
  const hub = app([service], {
    listeners: listeners.map(defineListener),
    dispatch: dispatch && { timer: false, maxBackoffMs: 5, ...dispatch },
  }).events!;
  return { database, db, service, hub, events: service.recorder! };
}

const rows = (db: any) => db.select().from(outbox).all();
/** Delivers until `done` holds: retries wait out their (short) backoff. */
const settle = (hub: EventsHub, done: () => boolean | Promise<boolean>) =>
  waitFor(async () => (await hub.drain(), done()));

describe("defineListener", () => {
  const run = () => {};
  it("refuses a bad name, no event, and a bad attempt count", () => {
    expect(() => defineListener({ name: "", on: "a", run })).toThrow(
      "needs a name",
    );
    expect(() => defineListener({ name: "a:b", on: "a", run })).toThrow(
      "must not contain ':'",
    );
    expect(() => defineListener({ name: "a", on: [], run })).toThrow(
      "listens for nothing",
    );
    expect(() =>
      defineListener({ name: "a", on: "a", run, maxAttempts: 0 }),
    ).toThrow("maxAttempts");
  });

  it("accepts one name or a list", () => {
    expect(defineListener({ name: "a", on: "x", run }).on).toEqual(["x"]);
    expect(defineListener({ name: "a", on: ["x", "y.*"], run }).on).toEqual([
      "x",
      "y.*",
    ]);
  });
});

describe("EventsHub", () => {
  it("refuses duplicate listener names", () => {
    const listener = defineListener({ name: "same", on: "x", run: () => {} });
    const create = () => app([], { listeners: [listener, listener] });
    expect(create).toThrow("Duplicate event listener 'same'");
    expect(create).toThrow(DuplicateNameError);
  });

  it("gives only a service whose database holds an outbox a recorder", () => {
    const withOutbox = setup([{ name: "a", on: "x", run: () => {} }]);
    expect(withOutbox.events).toBeDefined();
    const plain = defineService(`events_test_${++serial}`, {
      database: defineDatabase({ tables: { items } }),
    });
    app([plain], {});
    expect(plain.recorder).toBeUndefined();
  });

  it("warns when events are set but no database has an outbox", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const plain = defineService(`events_test_${++serial}`, {
      database: defineDatabase({ tables: { items } }),
    });
    app([plain], {
      listeners: [defineListener({ name: "a", on: "x", run() {} })],
    });
    expect(warn.mock.calls[0]?.[0]).toContain(
      "no service database has an outbox table",
    );
    warn.mockRestore();
  });

  it("describes itself as plain data that survives structured clone", () => {
    const { hub, service } = setup([
      { name: "a", on: ["x", "y.*"], run: () => {} },
    ]);
    const described = hub.describe();
    expect(() => structuredClone(described)).not.toThrow();
    expect(described).toEqual({
      listeners: [{ name: "a", on: ["x", "y.*"], kind: "handler" }],
      dispatch: true,
      recorders: [service.name],
    });
  });
});

describe("recording events", () => {
  it("commits the events with the write, one row per listener", async () => {
    const { db, events } = setup([
      { name: "mail", on: "item.create", run: () => {} },
      { name: "audit", on: "item.*", run: () => {} },
      { name: "all", on: "*", run: () => {} },
      { name: "other", on: "order.create", run: () => {} },
    ]);
    await events.transaction(
      db,
      { traceId: "tr_1", source: "svc.item" },
      async (tx, record) => {
        await tx.insert(items).values({ label: "a" });
        await record("item.create", { id: 1, row: { label: "a" } });
      },
    );

    expect(db.select().from(items).all()).toHaveLength(1);
    const recorded = rows(db);
    expect(recorded.map((row: any) => row.listener).sort()).toEqual([
      "all",
      "audit",
      "mail",
    ]);
    const [first] = recorded;
    expect(first).toMatchObject({
      name: "item.create",
      payload: { id: 1, row: { label: "a" } },
      traceId: "tr_1",
      source: "svc.item",
      status: "pending",
      attempts: 0,
    });
    expect(new Set(recorded.map((row: any) => row.eventId)).size).toBe(1);
    expect(recorded.map((row: any) => row.id).sort()).toEqual([
      `${first.eventId}:all`,
      `${first.eventId}:audit`,
      `${first.eventId}:mail`,
    ]);
  });

  it("records nothing, and undoes the write, when the transaction fails", async () => {
    const { db, events } = setup([
      { name: "mail", on: "item.create", run: () => {} },
    ]);
    await expect(
      events.transaction(db, {}, async (tx, record) => {
        await tx.insert(items).values({ label: "a" });
        await record("item.create", { id: 1 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(db.select().from(items).all()).toHaveLength(0);
    expect(rows(db)).toHaveLength(0);
  });

  it("records nothing for an event nobody listens for", async () => {
    const { db, events } = setup([
      { name: "mail", on: "item.create", run: () => {} },
    ]);
    expect(events.wants("item.create")).toBe(true);
    expect(events.wants("item.delete")).toBe(false);
    await events.transaction(db, {}, async (_tx, record) => {
      await record("item.delete", { id: 1 });
    });
    expect(rows(db)).toHaveLength(0);
  });

  it("lets transactions on one SQLite database take turns", async () => {
    const { db, events } = setup([
      { name: "mail", on: "item.create", run: () => {} },
    ]);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        events.transaction(db, {}, async (tx, record) => {
          await tx.insert(items).values({ label: `item ${index}` });
          await new Promise((resolve) => setTimeout(resolve, 1));
          await record("item.create", { index });
        }),
      ),
    );
    expect(db.select().from(items).all()).toHaveLength(20);
    expect(new Set(rows(db).map((row: any) => row.eventId)).size).toBe(20);
  });
});

describe("delivering events", () => {
  async function record(
    setupResult: ReturnType<typeof setup>,
    name = "item.create",
    payload: unknown = { id: 1 },
  ) {
    await setupResult.events.transaction(
      setupResult.db,
      { traceId: "tr_9", source: "s.i" },
      async (_tx, rec) => {
        await rec(name, payload);
      },
    );
  }

  it("runs the listener with the delivery, then marks the row delivered", async () => {
    const seen: EventDelivery[] = [];
    const ctx = setup([
      { name: "mail", on: "item.create", run: (d) => void seen.push(d) },
    ]);
    await record(ctx);
    expect(await ctx.hub.drain()).toBe(1);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      name: "item.create",
      payload: { id: 1 },
      traceId: "tr_9",
      source: "s.i",
      listener: "mail",
      attempt: 1,
    });
    expect(seen[0].deliveryId).toBe(`${seen[0].id}:mail`);
    expect(Number.isNaN(Date.parse(seen[0].occurredAt))).toBe(false);
    expect(await ctx.hub.counts()).toEqual({
      pending: 0,
      claimed: 0,
      delivered: 1,
      dead: 0,
    });
  });

  it("delivers each listener of an event independently", async () => {
    const calls: string[] = [];
    const ctx = setup([
      { name: "good", on: "item.create", run: () => void calls.push("good") },
      {
        name: "bad",
        on: "item.create",
        run: () => {
          throw new Error("nope");
        },
        maxAttempts: 2,
      },
    ]);
    await record(ctx);
    await ctx.hub.drain();
    expect(calls).toEqual(["good"]);
    await settle(ctx.hub, async () => (await ctx.hub.counts()).dead === 1);
    expect(calls).toEqual(["good"]);
    expect(await ctx.hub.counts()).toEqual({
      pending: 0,
      claimed: 0,
      delivered: 1,
      dead: 1,
    });
  });

  it("retries a failing listener later, with the attempt counted", async () => {
    const attempts: number[] = [];
    const ctx = setup([
      {
        name: "flaky",
        on: "item.create",
        run: (d) => {
          attempts.push(d.attempt);
          if (d.attempt < 3) throw new Error(`fail ${d.attempt}`);
        },
      },
    ]);
    await record(ctx);
    await ctx.hub.drain();
    expect(attempts).toEqual([1]);
    expect(await ctx.hub.counts()).toEqual({
      pending: 1,
      claimed: 0,
      delivered: 0,
      dead: 0,
    });
    expect(rows(ctx.db)[0].lastError).toBe("fail 1");
    await settle(ctx.hub, () => attempts.length === 3);
    expect(attempts).toEqual([1, 2, 3]);
    expect(await ctx.hub.counts()).toEqual({
      pending: 0,
      claimed: 0,
      delivered: 1,
      dead: 0,
    });
  });

  it("waits longer after each failure, up to maxBackoffMs", async () => {
    const ctx = setup(
      [
        {
          name: "down",
          on: "item.create",
          run: () => {
            throw new Error("down");
          },
        },
      ],
      { maxBackoffMs: 60_000 },
    );
    await record(ctx);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      ctx.db.update(outbox).set({ availableAt: new Date() }).run();
      await ctx.hub.drain();
      delays.push(rows(ctx.db)[0].availableAt.getTime() - Date.now());
    }
    expect(rows(ctx.db)[0].attempts).toBe(2);
    expect(delays[0]).toBeGreaterThan(500);
    expect(delays[1]).toBeGreaterThan(delays[0]!);
    expect(delays[1]).toBeLessThanOrEqual(60_000);
  });

  it("parks a delivery as dead when its attempts run out, and retries it on request", async () => {
    let fail = true;
    const ctx = setup(
      [
        {
          name: "stubborn",
          on: "item.create",
          maxAttempts: 2,
          run: () => {
            if (fail) throw new Error("still no");
          },
        },
      ],
      { maxBackoffMs: 1 },
    );
    await record(ctx);
    await settle(ctx.hub, async () => (await ctx.hub.counts()).dead === 1);
    expect(await ctx.hub.counts()).toEqual({
      pending: 0,
      claimed: 0,
      delivered: 0,
      dead: 1,
    });
    expect(rows(ctx.db)[0]).toMatchObject({
      status: "dead",
      attempts: 2,
      lastError: "still no",
    });

    fail = false;
    expect(await ctx.hub.retryDead()).toBe(1);
    await ctx.hub.drain();
    expect(await ctx.hub.counts()).toEqual({
      pending: 0,
      claimed: 0,
      delivered: 1,
      dead: 0,
    });
    expect(rows(ctx.db)[0].attempts).toBe(1);
  });

  it("parks a delivery whose listener is no longer registered", async () => {
    const ctx = setup([{ name: "gone", on: "item.create", run: () => {} }]);
    await record(ctx);
    const elsewhere = defineService(`events_test_${++serial}`, {
      database: ctx.database,
    });
    const other = app([elsewhere], {
      listeners: [],
      dispatch: { timer: false },
    }).events!;
    await other.drain();
    expect(rows(ctx.db)[0]).toMatchObject({ status: "dead" });
    expect(rows(ctx.db)[0].lastError).toContain("No listener named 'gone'");
  });

  it("takes over a claim that was never finished", async () => {
    const calls: string[] = [];
    const ctx = setup(
      [{ name: "mail", on: "item.create", run: () => void calls.push("ran") }],
      {
        claimTimeoutMs: 20,
      },
    );
    await record(ctx);
    ctx.db
      .update(outbox)
      .set({ status: "claimed", claimedAt: new Date(Date.now() - 1000) })
      .run();
    await ctx.hub.drain();
    expect(calls).toEqual(["ran"]);
    expect(await ctx.hub.counts()).toEqual({
      pending: 0,
      claimed: 0,
      delivered: 1,
      dead: 0,
    });
  });

  it("does not take a claim that is still fresh", async () => {
    const calls: string[] = [];
    const ctx = setup(
      [{ name: "mail", on: "item.create", run: () => void calls.push("ran") }],
      {
        claimTimeoutMs: 60_000,
      },
    );
    await record(ctx);
    ctx.db
      .update(outbox)
      .set({ status: "claimed", claimedAt: new Date() })
      .run();
    await ctx.hub.drain();
    expect(calls).toEqual([]);
  });

  it("keeps no delivered rows when retention is zero", async () => {
    const ctx = setup([{ name: "mail", on: "item.create", run: () => {} }], {
      retainDeliveredMs: 0,
    });
    await record(ctx);
    await ctx.hub.drain();
    expect(rows(ctx.db)).toHaveLength(0);
  });

  it("delivers on its own after a commit once started", async () => {
    const seen: string[] = [];
    const ctx = setup(
      [{ name: "mail", on: "item.create", run: (d) => void seen.push(d.name) }],
      {
        timer: true,
        intervalMs: 5_000,
      },
    );
    ctx.hub.start();
    await record(ctx);
    await waitFor(() => seen.length > 0);
    expect(seen).toEqual(["item.create"]);
  });

  it("ignores a start while a stop waits for a delivery", async () => {
    const seen: unknown[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ctx = setup(
      [
        {
          name: "mail",
          on: "item.create",
          run: async ({ payload }) => {
            seen.push(payload);
            if (seen.length === 1) await gate;
          },
        },
      ],
      { timer: true, intervalMs: 5 },
    );
    ctx.hub.start();
    await record(ctx, "item.create", { id: 1 });
    await waitFor(() => seen.length > 0);

    const stopping = ctx.hub.stop();
    // The startup of a process that is being stopped still starts the hub, and a
    // commit does too. Neither may claim what the process will drop on exit.
    ctx.hub.start();
    await record(ctx, "item.create", { id: 2 });
    // Nothing to wait for: the second event must stay undelivered.
    await Bun.sleep(50);
    release();
    await stopping;

    expect(seen).toEqual([{ id: 1 }]);
    expect(rows(ctx.db).map((row: any) => row.status)).toEqual([
      "delivered",
      "pending",
    ]);
  });

  it("only records when this process does not dispatch", async () => {
    const seen: string[] = [];
    const ctx = setup(
      [{ name: "mail", on: "item.create", run: () => void seen.push("x") }],
      false,
    );
    ctx.hub.start();
    await ctx.events.transaction(ctx.db, {}, async (_tx, rec) => {
      await rec("item.create", {});
    });
    // Nothing to wait for: no delivery may happen.
    await Bun.sleep(30);
    expect(rows(ctx.db)[0].status).toBe("pending");
    expect(seen).toEqual([]);
  });

  // Shared by name, so the CLI's copy of the package sees the app's hubs.
  const started = (globalThis as Record<symbol, unknown>)[
    Symbol.for(GLOBAL_SYMBOL.eventsStarted)
  ] as Set<EventsHub>;

  it("keeps the hubs that are started, in a set every copy of the package shares", async () => {
    const { hub } = setup([{ name: "mail", on: "item.create", run: () => {} }]);
    expect(started.has(hub)).toBe(false);
    hub.start();
    expect(started.has(hub)).toBe(true);
    await hub.stop();
    expect(started.has(hub)).toBe(false);
    hub.start();
    expect(started.has(hub)).toBe(true);

    const recordOnly = setup(
      [{ name: "mail", on: "item.create", run: () => {} }],
      false,
    ).hub;
    recordOnly.start();
    expect(started.has(recordOnly)).toBe(false);
  });

  it("stops every started hub once its deliveries finish", async () => {
    const seen: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const ctx = setup(
      [
        {
          name: "mail",
          on: "item.create",
          run: async () => {
            seen.push("started");
            await gate;
            seen.push("finished");
          },
        },
      ],
      { timer: true, intervalMs: 5 },
    );
    // The commit starts the hub, as an event emitted while an entry loads does.
    await record(ctx);
    await waitFor(() => seen.length > 0);

    // Hubs that other test files left started are not this test's to stop.
    const others = [...started].filter((hub) => hub !== ctx.hub);
    for (const hub of others) started.delete(hub);
    let stopped = false;
    const stopping = stopAllEvents().then(() => (stopped = true));
    try {
      // Nothing to wait for: the stop must still be waiting on the delivery.
      await Bun.sleep(30);
      expect(stopped).toBe(false);
    } finally {
      release();
      await stopping;
      for (const hub of others) started.add(hub);
    }
    expect(seen).toEqual(["started", "finished"]);
    expect(started.has(ctx.hub)).toBe(false);
    expect(rows(ctx.db)[0].status).toBe("delivered");
  });

  it("waits for every hub when one of them fails to stop, then reports the failure", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let running = false;
    const slow = setup(
      [
        {
          name: "mail",
          on: "item.create",
          run: async () => {
            running = true;
            await gate;
          },
        },
      ],
      { timer: true, intervalMs: 5 },
    );
    await record(slow);
    await waitFor(() => running);
    const broken = setup([{ name: "mail", on: "item.create", run: () => {} }]);
    broken.hub.start();
    const failure = new Error("close failed");
    const fails = spyOn(broken.hub, "stop").mockRejectedValue(failure);

    const others = [...started].filter(
      (hub) => hub !== slow.hub && hub !== broken.hub,
    );
    for (const hub of others) started.delete(hub);
    let settled = false;
    const stopping = stopAllEvents().then(
      () => new Error("stopAllEvents did not fail"),
      (error: unknown) => error,
    );
    void stopping.then(() => (settled = true));
    try {
      // Nothing to wait for: the failing hub is done, the slow one is still delivering.
      await Bun.sleep(30);
      expect(fails).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      release();
      await stopping;
      fails.mockRestore();
      started.delete(broken.hub);
      for (const hub of others) started.add(hub);
    }
    expect(await stopping).toBe(failure);
    expect(started.has(slow.hub)).toBe(false);
    expect(rows(slow.db)[0].status).toBe("delivered");
  });

  it("starts again once its stop is done", async () => {
    const seen: unknown[] = [];
    const ctx = setup(
      [
        {
          name: "mail",
          on: "item.create",
          run: ({ payload }) => void seen.push(payload),
        },
      ],
      { timer: true, intervalMs: 5 },
    );
    ctx.hub.start();
    await Promise.all([ctx.hub.stop(), ctx.hub.stop()]);
    expect(started.has(ctx.hub)).toBe(false);

    ctx.hub.start();
    expect(started.has(ctx.hub)).toBe(true);
    await record(ctx, "item.create", { id: 1 });
    await waitFor(() => seen.length > 0);
    expect(seen).toEqual([{ id: 1 }]);
  });
});

describe("brick({ events })", () => {
  it("puts the hub on the app and its description in the definition", () => {
    const database = defineDatabase({ tables: { items, outbox } });
    const service = defineService(`events_test_${++serial}`, { database });
    const made = app([service], {
      listeners: [defineListener({ name: "a", on: "x.*", run: () => {} })],
    });
    expect(service.recorder).toBeDefined();
    expect(made.definition.events).toEqual({
      listeners: [{ name: "a", on: ["x.*"], kind: "handler" }],
      dispatch: true,
      recorders: [service.name],
    });
    // The architecture export carries it to the dashboard and `brick info`.
    expect(
      getGlobalRegistry().exportArchitecture(made.definition).events,
    ).toEqual(made.definition.events);
  });

  it("changes nothing when events are not set", () => {
    const service = defineService(`events_test_${++serial}`, {
      database: defineDatabase({ tables: { items, outbox } }),
    });
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    expect(app.events).toBeUndefined();
    expect(app.definition.events).toBeUndefined();
    expect(service.recorder).toBeUndefined();
  });
});

describe("emitEvent", () => {
  function emitting(listener: (delivery: EventDelivery) => void) {
    const made = setup([{ name: "heard", on: "item.refunded", run: listener }]);
    const action = made.service.action({
      name: "refund",
      execute: async ({ ctx }: any) => {
        await emitEvent(ctx, "item.refunded", { id: 7 }, { source: "tests" });
        return "ok";
      },
    });
    return { ...made, action };
  }

  it("records an event of your own, delivered with the payload and the trace", async () => {
    const heard: EventDelivery[] = [];
    const { action, hub, db } = emitting(
      (delivery) => void heard.push(delivery),
    );

    await action.run({}, { traceId: "tr_custom" });
    expect(rows(db)).toHaveLength(1);
    await hub.drain();

    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({
      name: "item.refunded",
      payload: { id: 7 },
      traceId: "tr_custom",
      source: "tests",
      listener: "heard",
    });
  });

  it("records nothing when no listener wants the event", async () => {
    const { service, db } = setup([
      { name: "other", on: "x.y", run: () => {} },
    ]);
    const action = service.action({
      name: "quiet",
      execute: async ({ ctx }: any) => emitEvent(ctx, "item.refunded", {}),
    });
    await action.run({});
    expect(rows(db)).toHaveLength(0);
  });

  it("commits with a transaction you hold, or not at all", async () => {
    const { service, hub, db } = setup([
      { name: "heard", on: "item.refunded", run: () => {} },
    ]);
    const ctx = { db: service.getDb(), traceId: "tr_tx" };

    await expect(
      runInTransaction(db, async (tx) => {
        await tx.insert(items).values({ label: "gone" });
        await emitEvent(ctx, "item.refunded", { id: 1 }, { tx });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(rows(db)).toHaveLength(0);
    expect(db.select().from(items).all()).toHaveLength(0);

    await runInTransaction(db, async (tx) => {
      await tx.insert(items).values({ label: "kept" });
      await emitEvent(ctx, "item.refunded", { id: 2 }, { tx });
    });
    expect(rows(db)).toHaveLength(1);
    expect(await hub.drain()).toBe(1);
  });

  it("joins a transaction already open on the same handle", async () => {
    const { db } = setup([]);
    const label = (tx: any) =>
      tx
        .select()
        .from(items)
        .all()
        .map((r: any) => r.label);
    const committed: string[] = [];
    await runInTransaction(db, async (tx) => {
      await tx.insert(items).values({ label: "outer" });
      await runInTransaction(tx, async (inner) => {
        await inner.insert(items).values({ label: "inner" });
        await onTransactionCommit(inner, () => committed.push("inner"));
      });
      await expect(
        runInTransaction(tx, async (inner) => {
          await inner.insert(items).values({ label: "undone" });
          await onTransactionCommit(inner, () => committed.push("undone"));
          throw new Error("nested failure");
        }),
      ).rejects.toThrow("nested failure");
      expect(committed).toEqual([]);
    });
    expect(label(db)).toEqual(["outer", "inner"]);
    expect(committed).toEqual(["inner"]);

    await expect(
      runInTransaction(db, async (tx) => {
        await runInTransaction(tx, async (inner) => {
          await inner.insert(items).values({ label: "gone" });
          await onTransactionCommit(inner, () => committed.push("gone"));
        });
        throw new Error("outer failure");
      }),
    ).rejects.toThrow("outer failure");
    expect(label(db)).toEqual(["outer", "inner"]);
    expect(committed).toEqual(["inner"]);
    await onTransactionCommit(db, () => committed.push("now"));
    expect(committed).toEqual(["inner", "now"]);
  });

  it("still makes separate callers take turns", async () => {
    const { db } = setup([]);
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = runInTransaction(db, async () => {
      order.push("first");
      await held;
      order.push("first done");
    });
    const second = runInTransaction(db, async () => void order.push("second"));
    // Nothing to wait for: the second caller must not start yet.
    await Bun.sleep(5);
    expect(order).toEqual(["first"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "first done", "second"]);
  });

  it("explains a context whose database has no outbox", async () => {
    const plain = defineDatabase({ tables: { items } });
    await expect(
      emitEvent({ db: plain.getDb() }, "item.refunded", {}),
    ).rejects.toThrow("outbox table");
    await expect(emitEvent({}, "item.refunded", {})).rejects.toThrow(
      "Cannot emit",
    );
  });
});

describe("typed listener errors", () => {
  const Declined = defineError("CARD_DECLINED", {
    status: 402,
    message: "Card declined",
    details: t.Object({ reason: t.String() }),
  });

  async function runWith(
    run: Parameters<typeof defineListener>[0]["run"],
    retry: (error: any) => "retry" | "dead",
    maxAttempts = 3,
  ) {
    const seen: unknown[] = [];
    const ctx = setup([
      {
        name: "charge",
        on: "item.create",
        errors: { ...Declined },
        retry: (error: any) => (seen.push(error), retry(error)),
        run,
        maxAttempts,
      } as any,
    ]);
    await ctx.events.transaction(ctx.db, {}, async (_tx, rec) => {
      await rec("item.create", { id: 1 });
    });
    await ctx.hub.drain();
    return { ctx, seen };
  }

  it("parks at once when retry says dead for a declared code", async () => {
    const { ctx, seen } = await runWith(
      (_d: any, { error }: any) =>
        error.CARD_DECLINED(undefined, { reason: "x" }),
      (error) => (error.code === "CARD_DECLINED" ? "dead" : "retry"),
    );
    expect(seen).toEqual([
      {
        code: "CARD_DECLINED",
        message: "Card declined",
        details: { reason: "x" },
      },
    ]);
    expect((await ctx.hub.counts()).dead).toBe(1);
  });

  it("retries as before when retry says retry, and for undeclared failures", async () => {
    const { ctx, seen } = await runWith(
      () => {
        throw new Error("boom");
      },
      () => "retry",
    );
    expect(seen[0]).toMatchObject({ code: "UNKNOWN", message: "boom" });
    expect((await ctx.hub.counts()).pending).toBe(1);
  });

  it("retries, and logs, when retry itself throws", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { ctx } = await runWith(
        () => {
          throw new Error("boom");
        },
        () => {
          throw new Error("bad policy");
        },
      );
      expect((await ctx.hub.counts()).pending).toBe(1);
      const logged = log.mock.calls.find((call) =>
        String(call[0]).includes("its retry() threw"),
      );
      expect(logged?.[1]).toMatchObject({ message: "bad policy" });
    } finally {
      log.mockRestore();
    }
  });
});
