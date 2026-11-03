import { beforeEach, expect, it } from "bun:test";
import {
  defineService,
  defineDatabase,
  syncSchema,
  sqliteTable,
  text,
  resetGlobalRegistry,
  brick,
} from "@brickkit/core";
import { crud } from "@brickkit/crud";
beforeEach(resetGlobalRegistry);
const table = sqliteTable("rest_notes", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
it("mounts plugin CRUD routes and read helpers without GET collection or PUT aliases", async () => {
  const database = defineDatabase({ tables: [table] }),
    db = database.getDb();
  syncSchema(database.tables, db);
  const service = defineService("notes", { database });
  service.resource({ name: "note", table }).use(
    crud({
      access: "public",
      fields: {
        id: { read: true, create: true, filter: ["eq"] },
        title: {
          read: true,
          create: true,
          update: true,
          filter: ["contains"],
        },
      },
    }),
  );
  const app = brick({ services: [service], requestLogging: false });
  const call = (method: string, path: string, body?: unknown) =>
    app.handle(
      new Request("http://localhost/api/notes/note" + path, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  try {
    expect(
      await (await call("POST", "", { id: "one", title: "Hello" })).json(),
    ).toEqual({ id: "one", title: "Hello" });
    expect((await call("GET", "/one")).status).toBe(200);
    expect((await call("GET", "")).status).toBe(404);
    expect((await call("PUT", "/one", { title: "Replacement" })).status).toBe(
      404,
    );
    expect(
      (await (await call("POST", "/query", { includeTotal: true })).json())
        .items,
    ).toEqual([{ id: "one", title: "Hello" }]);
    expect(
      await (
        await call("POST", "/find-one", {
          where: { field: "id", op: "eq", value: "missing" },
        })
      ).json(),
    ).toBeNull();
    expect(await (await call("POST", "/count", {})).json()).toEqual({
      count: 1,
    });
    expect(await (await call("POST", "/exists", {})).json()).toEqual({
      exists: true,
    });
    expect(
      await (await call("PATCH", "/one", { data: { title: "Edited" } })).json(),
    ).toEqual({ id: "one", title: "Edited" });
    expect(await (await call("DELETE", "/one")).json()).toEqual({
      success: true,
    });
    expect((await call("GET", "/one")).status).toBe(404);
  } finally {
    db.$client.close();
  }
});

it("rejects over-nested filters over HTTP with 400 instead of hanging", async () => {
  const database = defineDatabase({ tables: [table] }),
    db = database.getDb();
  syncSchema(database.tables, db);
  const service = defineService("notes-deep", { database });
  service.resource({ name: "note", table }).use(
    crud({
      access: "public",
      fields: {
        id: { read: true, create: true, filter: ["eq"] },
        title: { read: true, create: true, filter: ["eq"] },
      },
    }),
  );
  const app = brick({ services: [service], requestLogging: false });
  const postQuery = (body: unknown) =>
    app.handle(
      new Request("http://localhost/api/notes-deep/note/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const deepWhere = (depth: number): unknown => {
    let node: unknown = { field: "title", op: "eq", value: "x" };
    for (let i = 0; i < depth; i++) node = { and: [node] };
    return node;
  };
  try {
    // Past the 20-level CRUD bound: validated by schema, rejected in execute.
    expect((await postQuery({ where: deepWhere(30) })).status).toBe(400);
    // Past the generic HTTP nesting cap: rejected before validation recurses.
    expect((await postQuery({ where: deepWhere(500) })).status).toBe(400);
  } finally {
    db.$client.close();
  }
});
