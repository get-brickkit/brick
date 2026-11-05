import { beforeEach, expect, it } from "bun:test";
import {
  defineDatabase,
  defineService,
  resetGlobalRegistry,
  syncSchema,
  sqliteTable,
  text,
  integer,
  brick,
} from "@brickkit/core";
import { crud } from "@brickkit/crud";
beforeEach(resetGlobalRegistry);
const table = sqliteTable("compiled_writes", {
  id: text("row_id").primaryKey(),
  title: text("headline").notNull(),
  published: integer("published", { mode: "boolean" }).notNull().default(false),
  secret: text("secret"),
});
function fixture(name: string) {
  const database = defineDatabase({ tables: [table] }),
    db = database.getDb();
  syncSchema(database.tables, db);
  const hooks: string[] = [];
  const service = defineService(name, { database });
  service.resource({ name: "item", table }).use(
    crud({
      access: "public",
      fields: {
        id: { read: true, create: true },
        title: { read: true, create: true, update: true },
        published: { read: true, create: true, update: true },
      },
      hooks: {
        beforeCreate: ({ data }) => {
          hooks.push("create");
          data.title = String(data.title).trim();
        },
        beforeUpdate: ({ data }) => {
          hooks.push("update");
          if (data.title) data.title = String(data.title).trim();
        },
      },
    }),
  );
  return {
    app: brick({ services: [service], requestLogging: false }),
    db,
    hooks,
  };
}
const request = (method: string, path: string, body?: unknown) =>
  new Request("http://localhost" + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-request-id": "parity-request",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
it("applies defaults, column mapping, write permissions, hooks and persistence over HTTP", async () => {
  const a = fixture("items");
  try {
    const commands = [
      ["POST", "/api/item", { id: "one", title: " First " }],
      [
        "PATCH",
        "/api/item/one",
        { data: { title: " Changed ", published: true } },
      ],
      ["PATCH", "/api/item/one", { data: { secret: "forbidden" } }],
      ["GET", "/api/item/one"],
      ["DELETE", "/api/item/one"],
      ["GET", "/api/item/one"],
    ] as const;
    const results: any[] = [];
    for (const [method, path, body] of commands) {
      const response = await a.app.handle(
        request(method, path.replace("/api/", "/api/items/"), body),
      );
      results.push({ status: response.status, value: await response.json() });
    }
    expect(results[0]).toEqual({
      status: 200,
      value: { id: "one", title: "First", published: false },
    });
    expect(results[1]).toEqual({
      status: 200,
      value: { id: "one", title: "Changed", published: true },
    });
    expect(results[2].status).toBe(400);
    expect(results[3]).toEqual(results[1]);
    expect(results[4].value).toEqual({ success: true });
    expect(results[5].status).toBe(404);
    expect(a.hooks).toEqual(["create", "update"]);
    expect(a.db.select().from(table).all()).toEqual([]);
  } finally {
    (a.db as any).$client.close();
  }
});
