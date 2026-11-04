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
function fixture(name: string, compiler: boolean) {
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
  const compilation = compileBrickApplication({
    services: [service],
    mode: compiler ? "specialized" : "generic",
  });
  const app = brick({
    services: [service],
    compilation,
    compiler,
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

it("preserves query projection, filters, scope and live rows in specialized and generic handlers", async () => {
  const a = fixture("compiled", true),
    b = fixture("generic", false);
  try {
    const inputs = [
      {
        select: ["id", "title"],
        orderBy: [{ field: "title", direction: "desc" }],
        limit: 1,
        includeTotal: true,
      },
      {
        where: {
          or: [
            { field: "id", op: "eq", value: "b" },
            { field: "published", op: "eq", value: true },
          ],
        },
      },
      { where: { field: "title", op: "contains", value: "mm" } },
      { where: { field: "secret", op: "eq", value: "hidden" } },
      { select: ["secret"] },
    ];
    for (const input of inputs) {
      const ra = await a.app.handle(query(input)),
        rb = await b.app.handle(query(input, "generic"));
      expect(ra.status).toBe(rb.status);
      expect(await ra.json()).toEqual(await rb.json());
    }
    const response = await a.app.handle(
      query({ select: ["id"], includeTotal: true }),
    );
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.items.map((row: any) => row.id).sort()).toEqual(["a", "c"]);
    expect(value.total).toBe(2);
    expect(value.items[0].secret).toBeUndefined();
    a.db.update(table).set({ title: "Changed" }).where(eq(table.id, "a")).run();
    const one = await a.app.handle(
      new Request("http://localhost/api/compiled/item/a"),
    );
    expect((await one.json()).title).toBe("Changed");
    expect(
      (await a.app.handle(new Request("http://localhost/api/compiled/item/b")))
        .status,
    ).toBe(404);
  } finally {
    a.db.$client.close();
    b.db.$client.close();
  }
});

it("discovers plugin preparation contributions without CRUD-specific compiler imports", () => {
  const { db, compilation } = fixture("prepared", true);
  try {
    expect(compilation.ir.preparations.length).toBeGreaterThan(0);
    expect(compilation.ir.preparations[0]!.service).toBe("prepared");
    expect(Object.isFrozen(compilation.ir.preparations)).toBe(true);
  } finally {
    db.$client.close();
  }
});

it("reuses a prepared query shape with new filter values and observes fresh database rows", async () => {
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
  let builds = 0;
  const select = db.select.bind(db);
  (db as any).select = (...args: any[]) => {
    builds++;
    return select(...args);
  };
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
    const warmBuilds = builds;
    expect(warmBuilds).toBeGreaterThan(0);
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
    expect(builds).toBe(warmBuilds);
  } finally {
    db.$client.close();
  }
});
