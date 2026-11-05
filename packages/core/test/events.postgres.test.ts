import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import postgres from "postgres";
import {
  brick,
  defineDatabase,
  defineListener,
  defineService,
  Dispatcher,
  outboxTable,
  syncSchema,
  type EventDelivery,
} from "../src";
import type { Deliverable } from "../src/events/hub";
import { requireService, track, waitFor } from "./helpers";

const url = requireService("TEST_DATABASE_URL", "events.postgres");
const suite = url ? describe : describe.skip;

const clients: ReturnType<typeof postgres>[] = [];
const tables: string[] = [];
afterAll(async () => {
  if (tables.length)
    await clients[0]!.unsafe(
      `DROP TABLE IF EXISTS ${tables.map((name) => `"${name}"`).join(", ")}`,
    );
  await Promise.all(clients.map((client) => client.end()));
});

let serial_ = 0;

async function setup(
  listeners: Parameters<typeof defineListener>[0][],
  dispatch = {},
) {
  const suffix = `${Date.now().toString(36)}_${++serial_}_${randomUUID().slice(0, 6)}`;
  const outboxName = `outbox_${suffix}`;
  const itemsName = `items_${suffix}`;
  const outbox = outboxTable("postgres", { name: outboxName });
  const items = pgTable(itemsName, {
    id: serial("id").primaryKey(),
    label: text("label").notNull(),
    count: integer("count").notNull().default(0),
  });
  const client = postgres(url!, { max: 10, onnotice: () => {} });
  clients.push(client);
  const database = defineDatabase({
    engine: "postgres",
    client,
    tables: { [itemsName]: items, [outboxName]: outbox },
  });
  const db: any = database.getDb();
  tables.push(outboxName, itemsName);
  await syncSchema([outbox, items], db);
  const service = defineService(`events_pg_${suffix}`, { database });
  const hub = track(
    brick({
      services: [service],
      events: {
        listeners: listeners.map(defineListener),
        dispatch: { timer: false, maxBackoffMs: 5, ...dispatch },
      },
      requestLogging: false,
      docs: false,
    }),
  ).events!;
  const rows = () => db.select().from(outbox);
  return {
    db,
    service,
    hub,
    events: service.recorder!,
    items,
    outbox,
    rows,
  };
}

suite("events on Postgres", () => {
  it("commits the events with the write, and undoes both together", async () => {
    const { db, events, items, rows } = await setup([
      { name: "mail", on: "item.create", run: () => {} },
    ]);
    await events.transaction(db, { traceId: "tr_1" }, async (tx, record) => {
      await tx.insert(items).values({ label: "kept" });
      await record("item.create", { id: 1 });
    });
    await expect(
      events.transaction(db, {}, async (tx, record) => {
        await tx.insert(items).values({ label: "undone" });
        await record("item.create", { id: 2 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(
      (await db.select().from(items)).map((row: any) => row.label),
    ).toEqual(["kept"]);
    const recorded = await rows();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      payload: { id: 1 },
      traceId: "tr_1",
      status: "pending",
    });
  });

  it("round-trips a nested payload as jsonb", async () => {
    const seen: EventDelivery[] = [];
    const { hub, events, db } = await setup([
      { name: "mail", on: "item.*", run: (d) => void seen.push(d) },
    ]);
    const payload = {
      id: 7,
      row: {
        tags: ["a", "b"],
        nested: { deep: [1, { x: null }] },
        at: "2026-10-17T00:00:00.000Z",
      },
    };
    await events.transaction(db, {}, async (_tx, record) =>
      record("item.update", payload),
    );
    await hub.drain();
    expect(seen[0].payload).toEqual(payload);
  });

  it("keeps events out of rolled-back writes under concurrency", async () => {
    const { db, events, items, rows } = await setup([
      { name: "mail", on: "item.create", run: () => {} },
    ]);
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, index) =>
        events.transaction(db, {}, async (tx, record) => {
          await tx.insert(items).values({ label: `item ${index}` });
          await record("item.create", { index });
          if (index % 2 === 1) throw new Error(`rollback ${index}`);
        }),
      ),
    );
    const committed = results.filter(
      (result) => result.status === "fulfilled",
    ).length;
    expect(committed).toBe(20);
    expect(await db.select().from(items)).toHaveLength(20);
    expect(await rows()).toHaveLength(20);
  });

  it("lets two dispatchers share a table without delivering anything twice", async () => {
    const deliveries = new Map<string, number>();
    const listener = defineListener({
      name: "mail",
      on: "item.create",
      run: async (d) => {
        await new Promise((resolve) => setTimeout(resolve, 2));
        deliveries.set(d.deliveryId, (deliveries.get(d.deliveryId) ?? 0) + 1);
      },
    });
    const ctx = await setup([
      { name: "mail", on: "item.create", run: () => {} },
    ]);
    await ctx.events.transaction(ctx.db, {}, async (_tx, record) => {
      for (let index = 0; index < 200; index++)
        await record("item.create", { index });
    });

    const otherClient = postgres(url!, { max: 5 });
    clients.push(otherClient);
    const otherDb: any = defineDatabase({
      engine: "postgres",
      client: otherClient,
      tables: {},
    }).getDb();
    const deliverable = listener as unknown as Deliverable;
    const first = new Dispatcher(ctx.db, ctx.outbox, () => deliverable, {
      timer: false,
      batchSize: 20,
    });
    const second = new Dispatcher(otherDb, ctx.outbox, () => deliverable, {
      timer: false,
      batchSize: 20,
    });
    const [a, b] = await Promise.all([first.drain(), second.drain()]);

    expect(a + b).toBe(200);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(deliveries.size).toBe(200);
    expect([...deliveries.values()].every((count) => count === 1)).toBe(true);
    expect(await first.counts()).toEqual({
      pending: 0,
      claimed: 0,
      delivered: 200,
      dead: 0,
    });
  });

  it("retries a failing listener, then parks the delivery", async () => {
    let calls = 0;
    const ctx = await setup(
      [
        {
          name: "flaky",
          on: "item.create",
          maxAttempts: 2,
          run: () => {
            calls++;
            throw new Error("no");
          },
        },
      ],
      { maxBackoffMs: 1 },
    );
    await ctx.events.transaction(ctx.db, {}, async (_tx, record) =>
      record("item.create", {}),
    );
    await waitFor(
      async () => (await ctx.hub.drain(), (await ctx.hub.counts()).dead === 1),
    );
    expect(calls).toBe(2);
    expect(await ctx.hub.counts()).toEqual({
      pending: 0,
      claimed: 0,
      delivered: 0,
      dead: 1,
    });
    expect((await ctx.rows())[0]).toMatchObject({
      status: "dead",
      attempts: 2,
      lastError: "no",
    });
  });

  it("takes over a claim whose process died", async () => {
    let calls = 0;
    const ctx = await setup(
      [{ name: "mail", on: "item.create", run: () => void calls++ }],
      {
        claimTimeoutMs: 20,
      },
    );
    await ctx.events.transaction(ctx.db, {}, async (_tx, record) =>
      record("item.create", {}),
    );
    await ctx.db
      .update(ctx.outbox)
      .set({ status: "claimed", claimedAt: new Date(Date.now() - 60_000) });
    await ctx.hub.drain();
    expect(calls).toBe(1);
    expect(await ctx.hub.counts()).toEqual({
      pending: 0,
      claimed: 0,
      delivered: 1,
      dead: 0,
    });
  });
});
