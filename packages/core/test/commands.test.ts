import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  ActionExecutionError,
  brick,
  defineDatabase,
  defineListener,
  defineService,
  emitEvent,
  generateOpenApiSpec,
  outboxTable,
  resetGlobalRegistry,
  syncSchema,
  t,
  type EventDelivery,
} from "../src";

const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  status: text("status").notNull(),
  total: integer("total").notNull().default(0),
});
const items = sqliteTable("order_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: text("order_id").notNull(),
  code: text("code").notNull(),
  qty: integer("qty").notNull(),
});
const outbox = outboxTable("sqlite");

const apps: { events?: { stop(): Promise<void> } }[] = [];

function fixture(extra?: (order: any) => void) {
  const database = defineDatabase({ tables: { orders, items, outbox } });
  const db: any = database.getDb();
  syncSchema([orders, items, outbox], db);
  db.insert(orders)
    .values([
      { id: "o1", owner: "ada", status: "paid" },
      { id: "o2", owner: "ada", status: "placed" },
      { id: "o3", owner: "bob", status: "paid" },
    ])
    .run();
  db.insert(items)
    .values([
      { orderId: "o1", code: "a", qty: 1 },
      { orderId: "o1", code: "b", qty: 2 },
      { orderId: "o3", code: "c", qty: 3 },
    ])
    .run();
  const service = defineService("orders", {
    database,
    context: ({ request }) => ({ user: request.headers.get("x-user") }),
    events: {
      shipped: t.Object({ id: t.String(), trackingId: t.String() }),
      itemAdded: t.Object({ id: t.String(), code: t.String() }),
    },
  });
  const order = service.resource({
    name: "order",
    table: orders,
    children: { items: { table: items, parent: items.orderId } },
  });
  const access = {
    scope: ({ ctx }: { ctx: { user: string | null } }) =>
      eq(orders.owner, ctx.user ?? ""),
  };
  const ship = order.command("ship", {
    input: t.Object({ trackingId: t.String() }),
    errors: { NOT_PAID: { status: 409, message: "Only paid orders can ship" } },
    access,
    decide: (row, input, { error }) =>
      row.status !== "paid"
        ? error.NOT_PAID()
        : {
            set: { status: "shipped" },
            emit: { shipped: { id: row.id, trackingId: input.trackingId } },
          },
  });
  const editItems = order.command("editItems", {
    input: t.Object({
      add: t.String(),
      bump: t.Optional(t.Number()),
      drop: t.Optional(t.Number()),
    }),
    output: t.Object({
      id: t.String(),
      total: t.Number(),
      items: t.Array(t.Object({ code: t.String(), qty: t.Number() })),
    }),
    access,
    load: { children: ["items"] },
    decide: (row, input) => ({
      set: { total: row.items.reduce((sum, item) => sum + item.qty, 0) },
      children: {
        items: {
          insert: [{ code: input.add, qty: 5 }],
          update: input.bump === undefined ? [] : [{ id: input.bump, qty: 10 }],
          delete: input.drop === undefined ? [] : [input.drop],
        },
      },
      emit: { itemAdded: { id: row.id, code: input.add } },
    }),
  });
  extra?.(order);
  const seen: EventDelivery<{ id: string; trackingId: string }>[] = [];
  const shippedListener = defineListener({
    name: "on-shipped",
    on: service.events.shipped,
    run: (delivery) => {
      seen.push(delivery);
    },
  });
  const added = defineListener({
    name: "on-added",
    on: service.events.itemAdded,
    run: () => {},
  });
  const app = brick({
    services: [service],
    events: {
      listeners: [shippedListener, added],
      dispatch: { timer: false },
    },
    requestLogging: false,
    docs: false,
  });
  apps.push(app);
  const call = (path: string, body: unknown, user = "ada") =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-user": user },
        body: JSON.stringify(body),
      }),
    );
  return { db, service, order, ship, editItems, app, call, seen };
}

const outboxRows = (db: any) => db.select().from(outbox).all();
const statusOf = (db: any, id: string) =>
  db.select().from(orders).where(eq(orders.id, id)).get().status;

beforeEach(resetGlobalRegistry);
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.events?.stop()));
  resetGlobalRegistry();
});

describe("commands", () => {
  it("decide runs alone, without a database", () => {
    const { ship } = fixture();
    const rejected = ship.decide(
      { id: "o2", owner: "ada", status: "placed", total: 0 },
      { id: "o2", trackingId: "t" },
    );
    expect(rejected).toBeInstanceOf(ActionExecutionError);
    expect(rejected).toMatchObject({ code: "NOT_PAID", status: 409 });
    expect(
      ship.decide(
        { id: "o1", owner: "ada", status: "paid", total: 0 },
        { id: "o1", trackingId: "t" },
      ),
    ).toEqual({
      set: { status: "shipped" },
      emit: { shipped: { id: "o1", trackingId: "t" } },
    });
  });

  it("mounts at /:id/<kebab name> and is registered as <resource>.<name>", () => {
    const { app, service } = fixture();
    expect(service.getAction("order.ship")).toBeDefined();
    const paths = app.definition.routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain("POST /api/orders/order/:id/ship");
    expect(paths).toContain("POST /api/orders/order/:id/edit-items");
  });

  it("writes the change and records the event in one transaction", async () => {
    const { db, call, app, seen } = fixture();
    const response = await call("/api/orders/order/o1/ship", {
      trackingId: "trk_1",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "o1" });
    expect(statusOf(db, "o1")).toBe("shipped");
    expect(outboxRows(db)).toEqual([
      expect.objectContaining({
        name: "orders.shipped",
        listener: "on-shipped",
        payload: { id: "o1", trackingId: "trk_1" },
        source: "orders.order",
      }),
    ]);
    await app.events!.drain();
    expect(seen.map((delivery) => delivery.payload)).toEqual([
      { id: "o1", trackingId: "trk_1" },
    ]);
  });

  it("a rejection writes nothing and records no event", async () => {
    const { db, call } = fixture();
    const response = await call("/api/orders/order/o2/ship", {
      trackingId: "t",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "NOT_PAID" });
    expect(statusOf(db, "o2")).toBe("placed");
    expect(outboxRows(db)).toEqual([]);
  });

  it("rolls the write back when the event cannot be recorded", async () => {
    const { db, call } = fixture();
    db.$client.exec("DROP TABLE brick_outbox");
    const response = await call("/api/orders/order/o1/ship", {
      trackingId: "t",
    });
    expect(response.status).toBe(500);
    expect(statusOf(db, "o1")).toBe("paid");
  });

  it("loads the row through its access scope: a hidden row is 404", async () => {
    const { db, call } = fixture();
    const hidden = await call("/api/orders/order/o3/ship", { trackingId: "t" });
    expect(hidden.status).toBe(404);
    const missing = await call("/api/orders/order/nope/ship", {
      trackingId: "t",
    });
    expect(missing.status).toBe(404);
    expect(statusOf(db, "o3")).toBe("paid");
    expect(outboxRows(db)).toEqual([]);
  });

  it("loads child rows and applies inserts, updates and deletes to this parent only", async () => {
    const { db, call } = fixture();
    const [a, b] = db.select().from(items).where(eq(items.orderId, "o1")).all();
    const other = db.select().from(items).where(eq(items.orderId, "o3")).get();
    // Updating or deleting another order's item changes nothing.
    const response = await call("/api/orders/order/o1/edit-items", {
      add: "z",
      bump: a.id,
      drop: other.id,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "o1",
      total: 3,
      items: [
        { code: "a", qty: 10 },
        { code: "b", qty: 2 },
        { code: "z", qty: 5 },
      ],
    });
    await call("/api/orders/order/o1/edit-items", { add: "y", drop: b.id });
    expect(
      db
        .select()
        .from(items)
        .all()
        .map((item: any) => `${item.orderId}:${item.code}`),
    ).toEqual(["o1:a", "o3:c", "o1:z", "o1:y"]);
  });
});

describe("event catalog", () => {
  it("names events <service>.<event> and lists them in OpenAPI and introspection", () => {
    const { service } = fixture();
    expect(service.events.shipped.name).toBe("orders.shipped");
    const spec = generateOpenApiSpec({ services: [service] });
    expect(spec["x-brick-events"]["orders.shipped"]).toMatchObject({
      service: "orders",
      payload: { type: "object", required: ["id", "trackingId"] },
    });
    expect(service.introspect().events?.map((e) => e.name)).toEqual([
      "orders.shipped",
      "orders.itemAdded",
    ]);
    expect(service.introspect().options.events).toBeUndefined();
  });

  it("emitEvent checks the payload against the schema and the name against the catalog", async () => {
    const { db, service } = fixture();
    const ctx = { db };
    await emitEvent(ctx, service.events.shipped, { id: "o1", trackingId: "x" });
    await expect(
      // @ts-expect-error the payload is typed from the catalog
      emitEvent(ctx, service.events.shipped, { id: "o1" }),
    ).rejects.toThrow(/payload does not match/);
    await expect(
      emitEvent(ctx, "orders.shipped", { id: 1, trackingId: "x" }),
    ).rejects.toThrow(/payload does not match/);
    await expect(emitEvent(ctx, "orders.refunded", {})).rejects.toThrow(
      /not in the event catalog/,
    );
    // An event another service declares is checked against its own schema.
    const billing = defineService("billing", {
      events: { paid: t.Object({ id: t.String() }) },
    });
    await expect(
      emitEvent(ctx, billing.events.paid, { id: 1 } as never),
    ).rejects.toThrow(/"billing.paid" payload does not match/);
    // CRUD events of the service's resources keep their names.
    await emitEvent(ctx, "order.update", { id: "o1" });
    expect(outboxRows(db).map((row: any) => row.name)).toEqual([
      "orders.shipped",
    ]);
  });

  it("a command that emits an undeclared event or a bad payload writes nothing", async () => {
    const { db, call } = fixture((order) => {
      order.command("cancel", {
        access: "public",
        decide: () => ({ set: { status: "x" }, emit: { cancelled: {} } }),
      });
      order.command("shipBadly", {
        access: "public",
        decide: (row: any) => ({
          set: { status: "x" },
          emit: { shipped: { id: row.id } },
        }),
      });
    });
    for (const path of ["cancel", "ship-badly"])
      expect((await call(`/api/orders/order/o1/${path}`, {})).status).toBe(500);
    expect(statusOf(db, "o1")).toBe("paid");
    expect(outboxRows(db)).toEqual([]);
  });

  it("rejects catalog names that are not plain identifiers", () => {
    expect(() =>
      defineService("bad", { events: { "a.b": t.Object({}) } }),
    ).toThrow(/plain name/);
  });
});
