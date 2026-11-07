import { beforeEach, expect, it } from "bun:test";
import {
  defineDatabase,
  defineService,
  resetGlobalRegistry,
  syncSchema,
  sqliteTable,
  text,
  integer,
  eq,
  brick,
  compileBrickApplication,
} from "@brickkit/core";
import { crud } from "@brickkit/crud";

beforeEach(resetGlobalRegistry);
const table = sqliteTable("compiled_read_rows", {
  id: text("row_id").primaryKey(),
  title: text("headline").notNull(),
  userId: text("owner_id").notNull(),
  published: integer("is_published", { mode: "boolean" }).notNull(),
  secret: text("secret"),
});
function fixture(name: string) {
  const database = defineDatabase({ tables: [table] });
  const db = database.getDb();
  syncSchema(database.tables, db);
  db.insert(table)
    .values([
      {
        id: "a",
        title: "Alpha",
        userId: "alice",
        published: true,
        secret: "hidden",
      },
      { id: "b", title: "Beta", userId: "bob", published: false },
      { id: "c", title: "Gamma", userId: "alice", published: false },
    ])
    .run();
  const service = defineService(name, {
    database,
    context: () => ({ user: { id: "alice" } }),
  });
  service.resource({ name: "item", table }).use(
    crud({
      access: {
        authorize: () => true,
        scope: ({ ctx }) => eq(table.userId, ctx.user!.id),
      },
      fields: {
        id: { read: true, filter: ["eq", "in"] },
        title: { read: true, filter: ["eq", "contains"], sort: true },
        published: { read: true, filter: ["eq"] },
      },
    }),
  );
  const compilation = compileBrickApplication({ services: [service] });
  const app = brick({
    services: [service],
    compilation,
    requestLogging: false,
  });
  return { app, db, compilation };
}
const query = (input: unknown, service = "compiled") =>
  new Request(`http://localhost/api/${service}/item/query`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-request-id": "parity-request",
    },
    body: JSON.stringify(input),
  });

it("applies query projection, filters, scope and live rows over HTTP", async () => {
  const { app, db } = fixture("compiled");
  try {
    const cases: [unknown, number, unknown?][] = [
      [
        {
          select: ["id", "title"],
          orderBy: [{ field: "title", direction: "desc" }],
          limit: 1,
          includeTotal: true,
        },
        200,
        { items: [{ id: "c", title: "Gamma" }], total: 2 },
      ],
      [
        {
          where: {
            or: [
              { field: "id", op: "eq", value: "b" },
              { field: "published", op: "eq", value: true },
            ],
          },
        },
        200,
        { items: [{ id: "a", title: "Alpha", published: true }] },
      ],
      [
        { where: { field: "title", op: "contains", value: "mm" } },
        200,
        { items: [{ id: "c", title: "Gamma", published: false }] },
      ],
      [{ where: { field: "secret", op: "eq", value: "hidden" } }, 400],
      [{ select: ["secret"] }, 400],
    ];
    for (const [input, status, body] of cases) {
      const response = await app.handle(query(input));
      expect(response.status).toBe(status);
      if (body) expect(await response.json()).toMatchObject(body);
    }
    db.update(table).set({ title: "Changed" }).where(eq(table.id, "a")).run();
    const one = await app.handle(
      new Request("http://localhost/api/compiled/item/a"),
    );
    expect((await one.json()).title).toBe("Changed");
    expect(
      (await app.handle(new Request("http://localhost/api/compiled/item/b")))
        .status,
    ).toBe(404);
  } finally {
    (db as any).$client.close();
  }
});

it("contributes a frozen preparation for its service", () => {
  const { db, compilation } = fixture("prepared");
  try {
    expect(compilation.ir.preparations.length).toBeGreaterThan(0);
    expect(compilation.ir.preparations[0]!.service).toBe("prepared");
    expect(Object.isFrozen(compilation.ir.preparations)).toBe(true);
  } finally {
    (db as any).$client.close();
  }
});

it("a repeated query shape takes new filter values and sees fresh rows", async () => {
  const database = defineDatabase({ tables: [table] });
  const db = database.getDb();
  syncSchema(database.tables, db);
  db.insert(table)
    .values([
      { id: "one", title: "First", userId: "alice", published: true },
      { id: "two", title: "Second", userId: "bob", published: false },
    ])
    .run();
  const service = defineService("cached_reads", { database });
  service.resource({ name: "item", table }).use(
    crud({
      access: "public",
      fields: { id: { read: true, filter: ["eq"] }, title: { read: true } },
    }),
  );
  const app = brick({ services: [service], requestLogging: false });
  try {
    const first = await (
      await app.handle(
        query(
          { where: { field: "id", op: "eq", value: "one" } },
          "cached_reads",
        ),
      )
    ).json();
    expect(first.items).toEqual([{ id: "one", title: "First" }]);
    db.update(table).set({ title: "Fresh" }).where(eq(table.id, "two")).run();
    const second = await (
      await app.handle(
        query(
          { where: { field: "id", op: "eq", value: "two" } },
          "cached_reads",
        ),
      )
    ).json();
    expect(second.items).toEqual([{ id: "two", title: "Fresh" }]);
  } finally {
    (db as any).$client.close();
  }
});
