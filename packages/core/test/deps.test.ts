import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  brick,
  defineDatabase,
  defineListener,
  definePlugin,
  defineService,
  outboxTable,
  port,
  resetGlobalRegistry,
  syncSchema,
  t,
  useDeps,
  useService,
  type BrickApp,
} from "../src";
import { createTestApp } from "../src/testing";

interface Carrier {
  book(orderId: string): string;
}
const carrier = (prefix: string): Carrier => ({
  book: (orderId) => `${prefix}_${orderId}`,
});

const apps: BrickApp[] = [];
beforeEach(resetGlobalRegistry);
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.events?.stop()));
});

function ordersService(name: string) {
  const service = defineService(name, { deps: { carrier: port<Carrier>() } });
  service.action({
    name: "ship",
    input: t.Object({ id: t.String() }),
    output: t.Object({ tracking: t.String() }),
    execute: ({ input, ctx }) => ({
      tracking: ctx.deps.carrier.book(input.id),
    }),
  });
  return service;
}

const call = async (app: BrickApp, path: string, body: unknown) =>
  (
    await app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    )
  )
    .json()
    .then((body: any) => body.tracking);

describe("declared deps", () => {
  for (const compiler of [true, false])
    it(`gives actions the app's deps as ctx.deps (compiler: ${compiler})`, async () => {
      const { client, cleanup } = createTestApp(() => {
        const orders = ordersService("orders");
        const ship = orders.getAction("ship")!;
        return {
          services: [orders],
          deps: { carrier: carrier("trk") },
          compiler,
          docs: false,
          contract: { orders: { ship } },
        };
      });
      expect(await client.orders.ship({ id: "o1" })).toEqual({
        tracking: "trk_o1",
      });
      await cleanup();
    });

  it("fails at brick() when a dep is missing or extra", () => {
    const orders = ordersService("orders");
    expect(() => brick({ services: [orders], docs: false })).toThrow(
      'service "orders" declares dep "carrier", but brick({ deps }) does not provide it',
    );
    expect(() =>
      brick({
        services: [orders],
        deps: { carrier: carrier("a"), mailer: {} },
        docs: false,
      }),
    ).toThrow('brick({ deps }) provides "mailer", but no service declares it');
  });

  it("keeps the deps of two apps in one process apart", async () => {
    const first = createTestApp({
      services: [ordersService("ordersA")],
      deps: { carrier: carrier("a") },
      docs: false,
    });
    const second = createTestApp({
      services: [ordersService("ordersB")],
      deps: { carrier: carrier("b") },
      docs: false,
    });
    expect(await call(first.app, "/api/orders-a/ship", { id: "1" })).toBe(
      "a_1",
    );
    expect(await call(second.app, "/api/orders-b/ship", { id: "1" })).toBe(
      "b_1",
    );
  });

  it("lets a unit test pass fakes to an action directly", async () => {
    const orders = ordersService("orders");
    const ship = orders.getAction("ship")!;
    expect(
      await ship.execute({
        input: { id: "o1" },
        ctx: { deps: { carrier: carrier("fake") } } as any,
      }),
    ).toEqual({ tracking: "fake_o1" });
  });

  it("gives listeners the deps of their own app through useDeps()", async () => {
    const items = sqliteTable("dep_items", {
      id: integer("id").primaryKey(),
      label: text("label"),
    });
    const outbox = outboxTable("sqlite");
    const seen: string[] = [];
    const appWith = (name: string, prefix: string) => {
      const database = defineDatabase({ tables: { items, outbox } });
      syncSchema([items, outbox], database.getDb() as any);
      const service = defineService(name, {
        database,
        deps: { carrier: port<Carrier>() },
      });
      const app = brick({
        services: [service],
        deps: { carrier: carrier(prefix) },
        events: {
          listeners: [
            defineListener({
              name: "book",
              on: "item.create",
              run: ({ payload }) =>
                void seen.push(
                  useDeps<{ carrier: Carrier }>().carrier.book(payload),
                ),
            }),
          ],
          dispatch: { timer: false },
        },
        requestLogging: false,
        docs: false,
      });
      apps.push(app);
      return { app, service, db: database.getDb() };
    };
    for (const [name, prefix] of [
      ["items_a", "a"],
      ["items_b", "b"],
    ] as const) {
      const { app, service, db } = appWith(name, prefix);
      await service.recorder!.transaction(db, {}, (_tx, record) =>
        record("item.create", "x"),
      );
      await app.events!.drain();
    }
    expect(seen).toEqual(["a_x", "b_x"]);
  });

  it("says where useDeps() works when called outside an app", () => {
    expect(() => useDeps()).toThrow("useDeps() was called outside a Brick app");
  });
});

describe("useService", () => {
  function billingService() {
    const invoices = sqliteTable("ref_invoices", {
      id: text("id").primaryKey(),
      status: text("status").notNull(),
    });
    const database = defineDatabase({ tables: { invoices } });
    syncSchema([invoices], database.getDb() as any);
    (database.getDb() as any)
      .insert(invoices)
      .values({ id: "i1", status: "open" })
      .run();
    const billing = defineService("billing", { database });
    billing.action({
      name: "charge",
      input: t.Object({ cents: t.Integer() }),
      output: t.Object({ cents: t.Integer(), caller: t.String() }),
      execute: ({ input, ctx }) => ({
        cents: input.cents,
        caller: ctx.caller!,
      }),
    });
    const invoice = billing.resource({
      name: "invoice",
      table: invoices,
      id: invoices.id,
    });
    invoice.action({
      name: "void",
      input: t.Object({ reason: t.String() }),
      output: t.String(),
      execute: ({ input }) => `voided: ${input.reason}`,
    });
    invoice.command("close", {
      access: "public",
      decide: () => ({ set: { status: "closed" } }),
    });
    return billing;
  }

  it("calls service and resource actions in-process as the caller", async () => {
    const billing = useService(billingService(), { from: "orders" });
    expect(await billing.charge({ cents: 5 })).toEqual({
      cents: 5,
      caller: "orders",
    });
    expect(await billing.invoice.void({ reason: "dup" })).toBe("voided: dup");
    expect(await billing.invoice.close({ id: "i1" })).toEqual({ id: "i1" });
    await expect(billing.refund({})).rejects.toThrow(
      "Action 'refund' does not exist on service 'billing'",
    );
  });

  it("is not a promise", async () => {
    const billing = useService(billingService());
    expect(await Promise.resolve(billing)).toBe(billing);
  });
});

describe("plugins with deps", () => {
  it("runs plugin actions with the plugin's deps through useService, and plugin listeners with useDeps(), never the host's", async () => {
    const items = sqliteTable("dep_plugin_items", {
      id: integer("id").primaryKey(),
    });
    const outbox = outboxTable("sqlite");
    const database = defineDatabase({ tables: { items, outbox } });
    syncSchema([items, outbox], database.getDb() as any);
    const service = defineService("shipping", {
      database,
      deps: { carrier: port<Carrier>() },
    });
    const item = service.resource({ name: "item", table: items, id: items.id });
    const seen: string[] = [];
    const tracking = definePlugin({
      name: "@acme/tracking",
      deps: { carrier: port<Carrier>() },
      resource: ({ routes }) => ({
        tracking: {
          book: routes.action({
            name: "book",
            path: "/book",
            method: "POST",
            input: t.Object({ id: t.String() }),
            output: t.String(),
            execute: ({ input, ctx }) => ctx.deps.carrier.book(input.id),
          }),
        },
      }),
      app: ({ listeners }) =>
        listeners(
          defineListener({
            name: "plugin-book",
            on: "item.create",
            run: ({ payload }) =>
              void seen.push(
                useDeps<{ carrier: Carrier }>().carrier.book(payload),
              ),
          }),
        ),
    });
    item.use(tracking({}, { deps: { carrier: carrier("p") } }));
    const app = brick({
      services: [service],
      deps: { carrier: carrier("host") },
      events: { dispatch: { timer: false } },
      requestLogging: false,
      docs: false,
    });
    apps.push(app);
    const shipping = useService(service) as any;
    expect(await shipping.item.tracking.book({ id: "o1" })).toBe("p_o1");
    await service.recorder!.transaction(database.getDb(), {}, (_tx, record) =>
      record("item.create", "x"),
    );
    await app.events!.drain();
    expect(seen).toEqual(["p_x"]);
  });
});
