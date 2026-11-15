import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  brick,
  defineDatabase,
  defineListener,
  definePlugin,
  defineService,
  outboxTable,
  resetGlobalRegistry,
  syncSchema,
  t,
  useDeps,
  useService,
  type BrickApp,
} from "../src";
import { createTestApp } from "../src/testing";
import { postJson } from "./helpers";

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

function ordersService(name: string, prefix = "trk") {
  const service = defineService(name, { deps: { carrier: carrier(prefix) } });
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
  ((await (await postJson(app, path, body)).json()) as any).tracking;

describe("service deps", () => {
  it("gives actions the service's deps as ctx.deps", async () => {
    const { client, cleanup } = createTestApp(() => {
      const orders = ordersService("orders");
      const ship = orders.getAction("ship")!;
      return {
        services: [orders],
        docs: false,
        contract: { orders: { ship } },
      };
    });
    expect(await client.orders.ship({ id: "o1" })).toEqual({
      tracking: "trk_o1",
    });
    await cleanup();
  });

  it("gives the service's context hook its deps, over HTTP and in-process alike", async () => {
    const seen: unknown[] = [];
    const booked = carrier("trk");
    const orders = defineService("hooked", {
      deps: { carrier: booked },
      context: (ctx: any) => {
        seen.push(ctx.deps?.carrier);
        return {};
      },
    });
    orders.action({ name: "ping", execute: () => ({ tracking: "ok" }) });
    const app = brick({
      services: [orders],
      requestLogging: false,
      docs: false,
    });
    await call(app, "/api/hooked/ping", {});
    await orders.getAction("ping")!.run();
    expect(seen).toEqual([booked, booked]);
  });

  it("refuses brick({ deps }) and names where the values go now", () => {
    const orders = ordersService("orders");
    expect(() =>
      brick({ services: [orders], deps: { carrier: carrier("a") } } as any),
    ).toThrow(
      "brick({ deps }) was removed in 0.16. Move each value into the service that uses it: defineService(name, { deps: { ... } })",
    );
  });

  it("keeps the deps of two services in one process apart", async () => {
    const first = createTestApp({
      services: [ordersService("ordersA", "a")],
      docs: false,
    });
    const second = createTestApp({
      services: [ordersService("ordersB", "b")],
      docs: false,
    });
    expect(await call(first.app, "/api/orders-a/ship", { id: "1" })).toBe(
      "a_1",
    );
    expect(await call(second.app, "/api/orders-b/ship", { id: "1" })).toBe(
      "b_1",
    );
  });

  it("lets a unit test replace one dep when calling an action directly", async () => {
    const orders = defineService("orders", {
      deps: { carrier: carrier("real"), label: "kept" },
    });
    const ship = orders.action({
      name: "ship",
      input: t.Object({ id: t.String() }),
      execute: ({ input, ctx }) =>
        `${ctx.deps.label} ${ctx.deps.carrier.book(input.id)}`,
    });
    expect(
      await ship.execute({
        input: { id: "o1" },
        ctx: { deps: { carrier: carrier("fake") } } as any,
      }),
    ).toBe("kept fake_o1");
    expect(await ship.run({ id: "o1" })).toBe("kept real_o1");
  });

  it("runs a call to another service with that service's deps, never the caller's", async () => {
    const billing = defineService("billing", {
      deps: { carrier: carrier("billing") },
    });
    billing.action({
      name: "book",
      execute: ({ ctx }) => ctx.deps.carrier.book("x"),
    });
    const orders = defineService("orders", {
      deps: { carrier: carrier("orders") },
    });
    const ship = orders.action({
      name: "ship",
      execute: async ({ ctx }) => {
        const viaService = await useService(billing).book({});
        // A context this service resolved, handed straight to the other's action.
        const direct = await billing.getAction("book")!.execute({ ctx });
        return [viaService, direct];
      },
    });
    expect(
      await ship.execute({
        ctx: { deps: { carrier: carrier("fake") } } as any,
      }),
    ).toEqual(["billing_x", "billing_x"]);
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
        deps: { carrier: carrier(prefix) },
      });
      const app = brick({
        services: [service],
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

  it("makes useDeps() throw on a name two services give different values", async () => {
    const outbox = outboxTable("sqlite");
    const database = defineDatabase({ tables: { outbox } });
    syncSchema([outbox], database.getDb() as any);
    const shared = carrier("s");
    const first = defineService("first", {
      database,
      deps: { carrier: carrier("a"), shared },
    });
    const second = defineService("second", {
      deps: { carrier: carrier("b"), shared },
    });
    const seen: unknown[] = [];
    const app = brick({
      services: [first, second],
      events: {
        listeners: [
          defineListener({
            name: "read",
            on: "ping",
            run: () => {
              const deps = useDeps<{ carrier: Carrier; shared: Carrier }>();
              seen.push(deps.shared);
              seen.push(() => deps.carrier);
            },
          }),
        ],
        dispatch: { timer: false },
      },
      requestLogging: false,
      docs: false,
    });
    apps.push(app);
    await first.recorder!.transaction(database.getDb(), {}, (_tx, record) =>
      record("ping", {}),
    );
    await app.events!.drain();
    expect(seen[0]).toBe(shared);
    expect(seen[1] as () => unknown).toThrow(
      'useDeps().carrier is ambiguous: services "first" and "second" both declare dep "carrier" with different values',
    );
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
      deps: { carrier: carrier("host") },
    });
    const item = service.resource({ name: "item", table: items, id: items.id });
    const seen: string[] = [];
    const tracking = definePlugin({
      name: "@acme/tracking",
      deps: { carrier: {} as Carrier },
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
