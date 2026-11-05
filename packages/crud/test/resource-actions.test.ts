import type { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import {
  brick,
  defineDatabase,
  defineService,
  generateOpenApiSpec,
  resetGlobalRegistry,
  t,
} from "@brickkit/core";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { crud } from "../src";
import { generateClientContract } from "../../cli/src/client-contract";

beforeEach(resetGlobalRegistry);

const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  owner: text("owner").notNull(),
  status: text("status").notNull(),
  secret: text("secret"),
});

function fixture() {
  const database = defineDatabase({ tables: { orders } });
  const db = database.getDb();
  const sqlite = (db as typeof db & { $client: Database }).$client;
  sqlite.exec(
    "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, status TEXT NOT NULL, secret TEXT)",
  );
  sqlite.exec(
    "INSERT INTO orders (owner, status, secret) VALUES ('ada', 'paid', 's1'), ('bob', 'paid', 's2')",
  );
  const service = defineService("orderBilling", {
    database,
    context: ({ request }) => ({ user: request.headers.get("x-user") }),
  });
  const order = service.resource({ name: "order", table: orders }).use(
    crud({
      access: {
        authorize: ({ ctx }) => ctx.user != null,
        scope: ({ ctx }) => eq(orders.owner, ctx.user as string),
      },
      fields: { id: { read: true }, status: { read: true } },
    }),
  );
  const archive = order.action({
    name: "archive",
    record: true,
    authorize: ({ ctx }) => ctx.user != null,
    access: { scope: ({ ctx }) => eq(orders.owner, ctx.user as string) },
    input: t.Object({ reason: t.String() }),
    output: t.Object({
      id: t.Number(),
      reason: t.String(),
      secret: t.String(),
    }),
    execute: async ({ input, row, ctx }) => {
      await ctx.db
        .update(orders)
        .set({ status: "archived" })
        .where(eq(orders.id, row.id));
      return { id: row.id, reason: input.reason, secret: row.secret! };
    },
  });
  order.action({
    name: "importCsv",
    input: t.Object({ csv: t.String() }),
    output: t.Object({ imported: t.Number() }),
    execute: ({ input, row }) => ({
      imported: input.csv.split("\n").length + (row === undefined ? 0 : 100),
    }),
  });
  service.action({
    name: "getSummary",
    method: "GET",
    output: t.Object({ ok: t.Boolean() }),
    execute: () => ({ ok: true }),
  });
  return { sqlite, service, archive };
}

const call = (
  app: { handle(request: Request): Promise<Response> },
  method: string,
  path: string,
  user?: string,
  body?: unknown,
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(user ? { "x-user": user } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );

test("service, CRUD and resource actions follow the owner tree in kebab-case", () => {
  const { sqlite, service } = fixture();
  try {
    const app = brick({ services: [service], docs: false });
    expect(
      app.definition.routes.map((route) => `${route.method} ${route.path}`),
    ).toEqual(
      expect.arrayContaining([
        "POST /api/order-billing/order/query",
        "GET /api/order-billing/order/:id",
        "POST /api/order-billing/order",
        "PATCH /api/order-billing/order/:id",
        "DELETE /api/order-billing/order/:id",
        "POST /api/order-billing/order/find-one",
        "POST /api/order-billing/order/:id/archive",
        "POST /api/order-billing/order/import-csv",
        "GET /api/order-billing/get-summary",
      ]),
    );
    expect(service.getAction("order.archive")).toBeDefined();
  } finally {
    sqlite.close();
  }
});

test("a record action loads its row through its own access and answers 404 for hidden rows", async () => {
  const { sqlite, service } = fixture();
  try {
    const app = brick({ services: [service], docs: false });
    const ok = await call(
      app,
      "POST",
      "/api/order-billing/order/1/archive",
      "ada",
      { reason: "done" },
    );
    expect(ok.status).toBe(200);
    // The row holds every column, including ones crud hides from reads.
    expect(await ok.json()).toEqual({ id: 1, reason: "done", secret: "s1" });

    // Bob's row exists, but the action's scope hides it from ada.
    const hidden = await call(
      app,
      "POST",
      "/api/order-billing/order/2/archive",
      "ada",
      { reason: "x" },
    );
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ code: "NOT_FOUND" });
    const missing = await call(
      app,
      "POST",
      "/api/order-billing/order/99/archive",
      "ada",
      { reason: "x" },
    );
    expect(missing.status).toBe(404);
    // The action's authorize refuses an anonymous caller before any row loads.
    const anonymous = await call(
      app,
      "POST",
      "/api/order-billing/order/1/archive",
      undefined,
      { reason: "x" },
    );
    expect(anonymous.status).toBe(401);
    expect(sqlite.query("SELECT status FROM orders ORDER BY id").all()).toEqual(
      [{ status: "archived" }, { status: "paid" }],
    );

    const imported = await call(
      app,
      "POST",
      "/api/order-billing/order/import-csv",
      "ada",
      { csv: "a\nb" },
    );
    expect(await imported.json()).toEqual({ imported: 2 });
  } finally {
    sqlite.close();
  }
});

test("a record action needs its own access, with or without crud", async () => {
  const database = defineDatabase({ tables: { orders } });
  const db = database.getDb();
  const sqlite = (db as typeof db & { $client: Database }).$client;
  sqlite.exec(
    "CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, status TEXT NOT NULL, secret TEXT)",
  );
  sqlite.exec("INSERT INTO orders (owner, status) VALUES ('ada', 'paid')");
  try {
    const bare = defineService("bare", { database });
    bare.resource({ name: "order", table: orders }).action({
      name: "ship",
      record: true,
      execute: ({ row }) => row,
    });
    expect(() => brick({ services: [bare], docs: false })).toThrow(
      /needs `access`/,
    );

    const withCrud = defineService("withCrud", { database });
    withCrud
      .resource({ name: "order", table: orders })
      .use(crud({ access: "public", fields: { id: { read: true } } }))
      .action({ name: "ship", record: true, execute: ({ row }) => row });
    expect(() => brick({ services: [withCrud], docs: false })).toThrow(
      /needs `access`/,
    );

    const scoped = defineService("scoped", {
      database,
      context: ({ request }) => ({ user: request.headers.get("x-user") }),
    });
    scoped.resource({ name: "order", table: orders }).action({
      name: "ship",
      record: true,
      method: "GET",
      access: { scope: ({ ctx }) => eq(orders.owner, ctx.user as string) },
      output: t.Object({ status: t.String() }),
      execute: ({ row }) => ({ status: row.status }),
    });
    const app = brick({ services: [scoped], docs: false });
    expect(
      (await call(app, "GET", "/api/scoped/order/1/ship", "ada")).status,
    ).toBe(200);
    expect(
      (await call(app, "GET", "/api/scoped/order/1/ship", "bob")).status,
    ).toBe(404);
  } finally {
    sqlite.close();
  }
});

test("crud's access does not affect how a record action loads its row", async () => {
  const { sqlite, service } = fixture();
  try {
    service.getResource("order")!.action({
      name: "reopen",
      record: true,
      access: "public",
      output: t.Object({ owner: t.String() }),
      execute: ({ row }) => ({ owner: row.owner }),
    });
    const app = brick({ services: [service], docs: false });
    // crud's scope would hide bob's row from an anonymous caller; `access: "public"` loads it.
    const res = await call(app, "POST", "/api/order-billing/order/2/reopen");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ owner: "bob" });
  } finally {
    sqlite.close();
  }
});

test("resource action names can't take a CRUD route or a CRUD action name", () => {
  const { sqlite, service } = fixture();
  try {
    const order = service.getResource("order")!;
    for (const name of ["count", "findOne", "bulkDelete", "query"])
      expect(() => order.action({ name, execute: () => null })).toThrow(
        /duplicate name/,
      );
    expect(() => order.action({ name: "list", execute: () => null })).toThrow(
      /duplicate name "order.list"/,
    );
  } finally {
    sqlite.close();
  }
});

test("crud refuses to install over a resource action that took one of its segments", () => {
  const service = defineService("shop", {
    database: defineDatabase({ tables: { orders } }),
  });
  const order = service.resource({ name: "order", table: orders });
  order.action({ name: "count", execute: () => null });
  expect(() =>
    order.use(crud({ access: "public", fields: { id: { read: true } } })),
  ).toThrow(/duplicate name "order.count".*"count" is a @brickkit\/crud route/);
});

test("OpenAPI groups resource routes under service · resource; the client nests them", () => {
  const { sqlite, service } = fixture();
  try {
    const spec = generateOpenApiSpec({ services: [service] });
    expect(
      spec.paths["/api/order-billing/order/{id}/archive"].post.tags,
    ).toEqual(["orderBilling · order"]);
    expect(spec.paths["/api/order-billing/order/query"].post.tags).toEqual([
      "orderBilling · order",
    ]);
    expect(spec.paths["/api/order-billing/get-summary"].get.tags).toEqual([
      "orderBilling",
    ]);
    expect(spec.tags.map((tag: { name: string }) => tag.name)).toEqual([
      "orderBilling",
      "orderBilling · order",
    ]);

    const contract = generateClientContract(
      brick({ services: [service], docs: false }),
    );
    const parsed = JSON.parse(
      JSON.parse(contract.match(/JSON\.parse\((".*")\);/)![1]!),
    );
    expect(parsed.orderBilling.order.archive.config).toEqual({
      path: "/api/order-billing/order/:id/archive",
      method: "POST",
    });
    expect(parsed.orderBilling.order.list.config).toEqual({
      path: "/api/order-billing/order/query",
      method: "POST",
    });
    expect(parsed.orderBilling.getSummary.config).toEqual({
      path: "/api/order-billing/get-summary",
      method: "GET",
    });
    expect(contract).toContain(
      '"archive": BrickClientAction<{ "reason": string; "id": number; }',
    );
  } finally {
    sqlite.close();
  }
});

test("a record action finds a row whose id column holds dates", async () => {
  const events = sqliteTable("events", {
    at: integer("at", { mode: "timestamp_ms" }).primaryKey(),
    name: text("name").notNull(),
  });
  const database = defineDatabase({ tables: { events } });
  const db = database.getDb();
  const sqlite = (db as typeof db & { $client: Database }).$client;
  try {
    sqlite.exec(
      "CREATE TABLE events (at INTEGER PRIMARY KEY, name TEXT NOT NULL)",
    );
    const at = new Date("2026-01-01T00:00:00.000Z");
    await db.insert(events).values({ at, name: "launch" });
    const service = defineService("calendar", { database });
    service.resource({ name: "event", table: events, id: events.at }).action({
      name: "show",
      record: true,
      method: "GET",
      access: "public",
      output: t.Object({ name: t.String() }),
      execute: ({ row }) => ({ name: row.name }),
    });
    const app = brick({ services: [service], docs: false });
    const response = await call(
      app,
      "GET",
      `/api/calendar/event/${encodeURIComponent(at.toISOString())}/show`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "launch" });
    expect(
      (await call(app, "GET", "/api/calendar/event/not-a-date/show")).status,
    ).toBe(404);
  } finally {
    sqlite.close();
  }
});
