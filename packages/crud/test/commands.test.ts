import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { defineService, t } from "@brickkit/core";
import { createTestApp } from "@brickkit/core/testing";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { crud } from "../src";
import { clientContract, sqliteDatabase } from "./helpers";

const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  owner: text("owner").notNull(),
  status: text("status").notNull(),
});

function fixture() {
  let sqlite!: Database;
  const testApp = createTestApp(() => {
    const created = sqliteDatabase([orders]);
    const database = created.database;
    sqlite = created.sqlite;
    sqlite.exec(
      "INSERT INTO orders (owner, status) VALUES ('ada', 'paid'), ('bob', 'paid')",
    );
    const service = defineService("orders", {
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
    order.command("markReady", {
      authorize: ({ ctx }) => ctx.user != null,
      access: { scope: ({ ctx }) => eq(orders.owner, ctx.user as string) },
      input: t.Object({ note: t.String() }),
      output: t.Object({ id: t.Number(), status: t.String() }),
      decide: () => ({ set: { status: "ready" } }),
    });
    return { services: [service], docs: false };
  });
  return { sqlite, ...testApp };
}

const call = (
  app: { handle(request: Request): Promise<Response> },
  path: string,
  user?: string,
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(user ? { "x-user": user } : {}),
      },
      body: JSON.stringify({ note: "n" }),
    }),
  );

test("a command loads its row through its own access", async () => {
  const { sqlite, app } = fixture();
  try {
    const own = await call(app, "/api/orders/order/1/mark-ready", "ada");
    expect(own.status).toBe(200);
    // The reply keeps only the output's fields: `owner` stays hidden.
    expect(await own.json()).toEqual({ id: 1, status: "ready" });
    expect(
      (await call(app, "/api/orders/order/2/mark-ready", "ada")).status,
    ).toBe(404);
    expect((await call(app, "/api/orders/order/1/mark-ready")).status).toBe(
      401,
    );
    expect(sqlite.query("SELECT status FROM orders ORDER BY id").all()).toEqual(
      [{ status: "ready" }, { status: "paid" }],
    );
  } finally {
    sqlite.close();
  }
});

test("the typed client calls a command as api.<service>.<resource>.<command>", () => {
  const { sqlite, app } = fixture();
  try {
    const { source: contract, contract: parsed } = clientContract(app);
    expect(parsed.orders.order.markReady.config).toEqual({
      path: "/api/orders/order/:id/mark-ready",
      method: "POST",
    });
    expect(contract).toContain(
      '"markReady": BrickClientAction<{ "note": string; "id": number; }',
    );
  } finally {
    sqlite.close();
  }
});
