import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  brick,
  createMcpRegistry,
  defineDatabase,
  defineListener,
  definePlugin,
  defineSchedule,
  defineService,
  defineTool,
  outboxTable,
  resetGlobalRegistry,
  scheduleTable,
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
      context: (ctx) => {
        seen.push(ctx.deps.carrier);
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

  it("refuses deps that are not an object, and a dep that is undefined", () => {
    for (const deps of ["oops", [1, 2], null, new Map(), new Date()])
      expect(() => defineService("bad", { deps: deps as any })).toThrow(
        'Service "bad": deps must be a plain object of values by name',
      );
    expect(() =>
      defineService("orders", { deps: { carrier: undefined } }),
    ).toThrow(
      'Service "orders": dep "carrier" is undefined; pass a value or leave it out',
    );
  });

  it("keeps the deps of two services in one app apart, over HTTP and through a tool call", async () => {
    const billing = defineService("billing", {
      deps: { carrier: carrier("billing") },
    });
    billing.tool(
      defineTool({
        name: "billing_book",
        input: t.Object({}),
        execute: ({ ctx }) => ctx.deps.carrier.book("x"),
      }),
    );
    const registry = createMcpRegistry({ services: [billing] });
    const orders = ordersService("orders", "orders");
    orders.action({
      name: "viaTool",
      output: t.Object({ tracking: t.String() }),
      execute: async ({ ctx }) => ({
        tracking: (await registry.callTool("billing_book", {}, ctx)) as string,
      }),
    });
    const app = brick({
      services: [billing, orders],
      requestLogging: false,
      docs: false,
    });
    expect(await call(app, "/api/orders/ship", { id: "1" })).toBe("orders_1");
    expect(await call(app, "/api/orders/via-tool", {})).toBe("billing_x");
    expect(await registry.callTool("billing_book", {})).toBe("billing_x");
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
        ctx: { deps: { carrier: carrier("fake") } },
      }),
    ).toBe("kept fake_o1");
    expect(await ship.run({ id: "o1" })).toBe("kept real_o1");
  });

  for (const hook of ["", "a context hook", "a context hook that returns deps"])
    it(`runs a call to another service with that service's deps, never the caller's${hook && ` (caller has ${hook})`}`, async () => {
      const billing = defineService("billing", {
        deps: { carrier: carrier("billing") },
      });
      const book = billing.action({
        name: "book",
        execute: ({ ctx }) =>
          `${ctx.deps.carrier.book("x")} ${Object.keys(ctx.deps)}`,
      });
      const orders = defineService("orders", {
        deps: { carrier: carrier("orders"), secret: "s" },
        ...(hook && {
          context: (base: { deps: object }): any => ({
            user: "u",
            ...(hook.endsWith("deps") && { deps: { ...base.deps, clock: 1 } }),
          }),
        }),
      });
      orders.action({
        name: "ship",
        output: t.Array(t.String()),
        execute: async ({ ctx }) => [
          await useService(billing).book({}, ctx),
          await book.execute({ ctx }),
          await book.run(undefined, ctx),
          await book.execute({ ctx: { ...ctx, db: undefined } }),
          await book.execute({
            ctx: { request: ctx.request, deps: ctx.deps } as any,
          }),
        ],
      });
      const app = brick({
        services: [billing, orders],
        requestLogging: false,
        docs: false,
      });
      const seen = await (await postJson(app, "/api/orders/ship", {})).json();
      expect(seen).toEqual(Array(5).fill("billing_x carrier"));
      expect(
        await orders.getAction("ship")!.execute({
          ctx: { deps: { carrier: carrier("fake") } } as any,
        }),
      ).toEqual(Array(5).fill("billing_x carrier"));
    });

  it("returns a service's deps through useDeps(service), outside any app", async () => {
    const orders = ordersService("orders", "own");
    const deps = useDeps(orders);
    expect(deps.carrier.book("1")).toBe("own_1");
    expect(Object.isFrozen(deps)).toBe(true);
  });

  it("leaves deps out of the architecture schema", () => {
    const client: Record<string, unknown> = { key: "sk_live" };
    client.self = client;
    const service = defineService("circular", { deps: { client } });
    const schema = JSON.stringify(service.introspect());
    expect(schema).not.toContain("sk_live");
    expect(schema).not.toContain('"deps"');
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

  it("gives schedules the deps of their app's services through useDeps()", async () => {
    const table = scheduleTable("sqlite");
    const database = defineDatabase({ tables: { schedules: table } });
    syncSchema([table], database.getDb() as any);
    const service = defineService("scheduled", {
      database,
      deps: { carrier: carrier("sched") },
    });
    const other = defineService("other", { deps: { label: "o" } });
    const names = other.action({
      name: "names",
      execute: ({ ctx }) => Object.keys(ctx.deps).join(),
    });
    const seen: string[] = [];
    const app = brick({
      services: [service, other],
      events: {
        schedules: [
          defineSchedule({
            name: "book",
            every: "1h",
            run: async () =>
              void seen.push(
                useDeps<{ carrier: Carrier }>().carrier.book("x"),
                useDeps(service).carrier.book("y"),
                await names.execute({ ctx: { deps: useDeps() } }),
              ),
          }),
        ],
        dispatch: { timer: false },
      },
      requestLogging: false,
      docs: false,
    });
    apps.push(app);
    expect(await app.events!.schedules!.drain()).toBe(1);
    expect(seen).toEqual(["sched_x", "sched_y", "label"]);
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
              seen.push(Object.keys({ ...deps }));
              seen.push(useDeps(second).carrier.book("x"));
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
      'useDeps().carrier is ambiguous: services "first" and "second" both declare dep "carrier" with different values. Call useDeps(service) with the service you mean.',
    );
    expect(seen.slice(2)).toEqual([["shared"], "b_x"]);
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
