import type { Database } from "bun:sqlite";
import { test, expect } from "bun:test";

import {
  defineService,
  defineDatabase,
  brick,
  compileBrickApplication,
  t,
} from "@brickkit/core";
import { eq } from "drizzle-orm";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

import { crud } from "../src";
import { createBrickClient } from "@brickkit/core/client";
import { generateClientContract } from "../../cli/src/client-contract";

const records = sqliteTable("records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  email: text("email"),
  private: text("private"),
  active: integer("active", { mode: "boolean" }).default(true),
});
let sequence = 0;
function fixture(
  options: Parameters<typeof crud>[0] = {
    access: "public",
    fields: {
      id: { read: true, filter: ["eq", "in"] },
      name: {
        read: true,
        create: true,
        update: true,
        filter: ["eq", "contains"],
        sort: true,
      },
      email: {
        read: true,
        create: true,
        scrub: ({ value }) => (value === null ? null : "masked"),
      },
      active: { read: true, create: true },
    },
  },
) {
  const database = defineDatabase({ tables: [records] });
  const db = database.getDb();
  const sqlite = (db as typeof db & { $client: Database }).$client;
  sqlite.exec(
    "CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,email TEXT,private TEXT,active INTEGER DEFAULT 1)",
  );
  const service = defineService(`test_${sequence++}`, { database });
  const resource: any = service
    .resource({ name: "record", table: records, id: records.id })
    .use(crud(options));
  return { sqlite, db, resource, service };
}
test("defaults, explicit fields, scrubbing and writes use real database", async () => {
  const { resource: r, sqlite } = fixture();
  try {
    expect(await r.create.run({ name: "A", email: "a@example.com" })).toEqual({
      id: 1,
      name: "A",
      email: "masked",
      active: true,
    });
    expect(await r.get.run({ id: 1 })).toEqual({
      id: 1,
      name: "A",
      email: "masked",
      active: true,
    });
    expect(await r.update.run({ id: 1, data: { name: "B" } })).toMatchObject({
      name: "B",
      email: "masked",
    });
    expect(await r.list.run({ includeTotal: true })).toEqual({
      items: [{ id: 1, name: "B", email: "masked", active: true }],
      total: 1,
      limit: 20,
      offset: 0,
    });
    expect(await r.delete.run({ id: 1 })).toEqual({ success: true });
    await expect(r.get.run({ id: 1 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await r.findOne.run({})).toBeNull();
  } finally {
    sqlite.close();
  }
});
test("filter AST, selection, total opt-in and bounded prepared reuse", async () => {
  const { resource: r, sqlite } = fixture();
  try {
    await r.create.run({ name: "A%" });
    await r.create.run({ name: "Other" });
    expect(
      await r.list.run({
        where: { field: "name", op: "contains", value: "%" },
        select: ["name"],
      }),
    ).toEqual({ items: [{ name: "A%" }], limit: 20, offset: 0 });
    expect(
      await r.count.run({
        where: {
          or: [
            { field: "id", op: "eq", value: 1 },
            { field: "name", op: "eq", value: "Other" },
          ],
        },
      }),
    ).toEqual({ count: 2 });
    expect(
      await r.count.run({ where: { field: "id", op: "in", value: [2] } }),
    ).toEqual({ count: 1 });
    expect(
      await r.exists.run({ where: { field: "id", op: "eq", value: 99 } }),
    ).toEqual({ exists: false });
    expect(await r.list.run({ select: ["id"], limit: 1, offset: 1 })).toEqual({
      items: [{ id: 2 }],
      limit: 1,
      offset: 1,
    });
  } finally {
    sqlite.close();
  }
});
test("rejects hidden fields, unknown fields, operators and invalid write input", async () => {
  const { resource: r, sqlite } = fixture();
  try {
    for (const input of [
      { select: ["private"] },
      { where: { field: "email", op: "eq", value: "x" } },
      { where: { field: "name", op: "in", value: ["x"] } },
      { limit: 101 },
      { unknown: true },
    ])
      await expect(r.list.run(input as never)).rejects.toMatchObject({
        status: 400,
      });
    await expect(
      r.create.run({ name: "A", private: "secret" } as never),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      r.update.run({ id: 1, data: { email: "x" } } as never),
    ).rejects.toMatchObject({ status: 400 });
  } finally {
    sqlite.close();
  }
});
test("scope protects all reads and mutations even local actions", async () => {
  const {
    resource: r,
    db,
    sqlite,
  } = fixture({
    fields: { id: { read: true }, name: { read: true, update: true } },
    access: {
      authorize: () => true,
      scope: ({ operation }) =>
        operation === "create" ? undefined : eq(records.id, 1),
    },
  });
  try {
    await db.insert(records).values([{ name: "allowed" }, { name: "hidden" }]);
    expect((await r.list.run({})).items).toEqual([{ id: 1, name: "allowed" }]);
    expect(await r.count.run({})).toEqual({ count: 1 });
    expect(await r.exists.run({})).toEqual({ exists: true });
    await expect(r.get.run({ id: 2 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      r.update.run({ id: 2, data: { name: "bad" } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(r.delete.run({ id: 2 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await db.select().from(records))[1].name).toBe("hidden");
  } finally {
    sqlite.close();
  }
});
test("operation disabling removes local capabilities", () => {
  const { resource: r, sqlite } = fixture({
    access: "public",
    fields: { id: { read: true } },
    operations: { delete: false, create: false },
  });
  try {
    expect("delete" in r).toBe(false);
    expect("create" in r).toBe(false);
    expect(typeof r.count).toBe("function");
  } finally {
    sqlite.close();
  }
});
test("trusted hooks can supply internal fields without exposing them", async () => {
  const hooks: string[] = [];
  const {
    resource: r,
    db,
    sqlite,
  } = fixture({
    access: "public",
    fields: {
      id: { read: true },
      name: { read: true, create: true, update: true },
    },
    hooks: {
      beforeCreate: ({ data }) => {
        data.private = "internal";
        hooks.push("beforeCreate");
      },
      afterCreate: ({ row }) => {
        expect(row.private).toBe("internal");
        hooks.push("afterCreate");
      },
      beforeUpdate: () => {
        hooks.push("beforeUpdate");
      },
      afterUpdate: () => {
        hooks.push("afterUpdate");
      },
      beforeDelete: () => {
        hooks.push("beforeDelete");
      },
      afterDelete: () => {
        hooks.push("afterDelete");
      },
    },
  });
  try {
    expect(await r.create.run({ name: "A" })).toEqual({ id: 1, name: "A" });
    expect((await db.select().from(records))[0].private).toBe("internal");
    await r.update.run({ id: 1, data: { name: "B" } });
    await r.delete.run({ id: 1 });
    expect(hooks).toEqual([
      "beforeCreate",
      "afterCreate",
      "beforeUpdate",
      "afterUpdate",
      "beforeDelete",
      "afterDelete",
    ]);
  } finally {
    sqlite.close();
  }
});
test("authorization and scoped-create rejection do not modify storage", async () => {
  const {
    resource: r,
    db,
    sqlite,
  } = fixture({
    fields: { name: { create: true, read: true } },
    access: {
      authorize: ({ operation }) => operation !== "delete",
      scope: () => eq(records.id, 1),
    },
  });
  try {
    await expect(r.create.run({ name: "A" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(r.delete.run({ id: 1 })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      status: 401,
    });
    expect(await db.select().from(records)).toEqual([]);
  } finally {
    sqlite.close();
  }
});
test("preparation prewarming preserves projection and repeated IDs", async () => {
  const { resource: r, service, sqlite } = fixture();
  try {
    compileBrickApplication({ services: [service] });
    await r.create.run({ name: "A" });
    await r.create.run({ name: "B" });
    expect((await r.get.run({ id: 1 })).name).toBe("A");
    expect((await r.get.run({ id: 2 })).name).toBe("B");
    expect((await r.list.run({})).items).toHaveLength(2);
    expect(
      (await r.list.run({ select: ["name"], limit: 1, offset: 1 })).items,
    ).toEqual([{ name: "B" }]);
  } finally {
    sqlite.close();
  }
});

test("unique database constraints return conflict without modifying the existing row", async () => {
  const { resource: r, sqlite } = fixture();
  try {
    await r.create.run({ name: "A" });
    await expect(r.create.run({ name: "A" })).rejects.toMatchObject({
      code: "CONFLICT",
      status: 409,
    });
    expect(await r.count.run({})).toEqual({ count: 1 });
  } finally {
    sqlite.close();
  }
});

test("deeply nested where rejects with 400 before validation recurses", async () => {
  const { resource: r, sqlite } = fixture({
    access: "public",
    fields: {
      id: { read: true },
      name: { read: true, filter: ["eq"] },
    },
  });
  try {
    const deepWhere = (depth: number): unknown => {
      let node: unknown = { field: "name", op: "eq", value: "x" };
      for (let i = 0; i < depth; i++) node = { and: [node] };
      return node;
    };
    // Past the 20-level bound but below any generic HTTP nesting cap.
    await expect(
      r.list.run({ where: deepWhere(64) as never }),
    ).rejects.toMatchObject({ status: 400 });
    // Deep enough to overflow the compiled validator's recursion without
    // the pre-validation walk (RangeError instead of a 400).
    await expect(
      r.list.run({ where: deepWhere(500) as never }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      r.count.run({ where: deepWhere(20_000) as never }),
    ).rejects.toMatchObject({ status: 400 });
  } finally {
    sqlite.close();
  }
});

test("boolean columns are sortable", async () => {
  const { resource: r, sqlite } = fixture({
    access: "public",
    fields: {
      id: { read: true },
      name: { read: true, create: true },
      active: { read: true, create: true, sort: true },
    },
  });
  try {
    await r.create.run({ name: "on", active: true });
    await r.create.run({ name: "off", active: false });
    expect(
      await r.list.run({
        select: ["name"],
        orderBy: [{ field: "active", direction: "asc" }],
      }),
    ).toEqual({
      items: [{ name: "off" }, { name: "on" }],
      limit: 20,
      offset: 0,
    });
    expect(
      await r.list.run({
        select: ["name"],
        orderBy: [{ field: "active", direction: "desc" }],
      }),
    ).toEqual({
      items: [{ name: "on" }, { name: "off" }],
      limit: 20,
      offset: 0,
    });
  } finally {
    sqlite.close();
  }
});

test("authorize receives validated inputs for each operation", async () => {
  const calls: { operation: string; input: unknown }[] = [];
  const { resource: r, sqlite } = fixture({
    fields: {
      id: { read: true, filter: ["eq"] },
      name: {
        read: true,
        create: true,
        update: true,
        filter: ["eq"],
        sort: true,
      },
    },
    access: {
      authorize: ({ operation, input }) => {
        calls.push({ operation, input });
        if (operation === "list" && input.where && "field" in input.where) {
          return (
            input.where.field === "name" &&
            input.where.op === "eq" &&
            input.where.value === "A"
          );
        }
        return true;
      },
    },
  });
  try {
    await expect(r.get.run({ id: "invalid" })).rejects.toThrow(
      "Validation failed",
    );
    expect(calls).toEqual([]);
    await r.create.run({ name: "A" });
    const query = {
      select: ["name"],
      where: { field: "name", op: "eq", value: "A" },
      orderBy: [{ field: "name", direction: "asc" }],
      limit: 1,
      offset: 0,
      includeTotal: true,
    };
    expect((await r.list.run(query)).items).toEqual([{ name: "A" }]);
    await expect(
      r.list.run(
        { where: { field: "name", op: "eq", value: "B" } },
        { user: { id: "member" } },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await r.get.run({ id: 1, select: ["name"] });
    await r.findOne.run({ select: ["name"] });
    await r.count.run({ where: { field: "id", op: "eq", value: 1 } });
    await r.exists.run({});
    await r.update.run({ id: 1, data: { name: "B" } });
    await r.delete.run({ id: 1 });
    expect(calls).toEqual([
      { operation: "create", input: { name: "A" } },
      { operation: "list", input: query },
      {
        operation: "list",
        input: { where: { field: "name", op: "eq", value: "B" } },
      },
      { operation: "get", input: { id: 1, select: ["name"] } },
      { operation: "findOne", input: { select: ["name"] } },
      {
        operation: "count",
        input: { where: { field: "id", op: "eq", value: 1 } },
      },
      { operation: "exists", input: {} },
      { operation: "update", input: { id: 1, data: { name: "B" } } },
      { operation: "delete", input: { id: 1 } },
    ]);
  } finally {
    sqlite.close();
  }
});

test("CRUD authorization distinguishes missing users and signed-in users", async () => {
  const { resource, sqlite } = fixture({
    fields: { name: { read: true } },
    access: { authorize: () => false },
  });
  try {
    for (const user of [undefined, { id: "guest" }]) {
      await expect(resource.list.run({}, { user })).rejects.toMatchObject({
        code: user == null ? "UNAUTHORIZED" : "FORBIDDEN",
        status: user == null ? 401 : 403,
      });
    }
  } finally {
    sqlite.close();
  }
});

for (const compiler of [false, true]) {
  test(`derived read fields batch scoped parents over HTTP, compiler=${compiler}`, async () => {
    let allowed = true;
    const batches: unknown[][] = [];
    const { service, resource, sqlite } = fixture({
      access: {
        authorize: () => allowed,
        scope: () => eq(records.active, true),
      },
      operations: { create: false, update: false, delete: false },
      fields: {
        id: { read: true },
        name: { read: true },
        children: {
          read: true,
          schema: t.Array(t.String()),
          resolve: ({ rows }) => {
            batches.push(rows.map((row) => row.id));
            return rows.map((row) => [`child-${row.id}`]);
          },
          scrub: ({ value }) => value,
        },
      },
    });
    sqlite.exec(
      "INSERT INTO records (name, private, active) VALUES ('A', 'secret', 1), ('hidden', 'secret', 0), ('B', 'secret', 1)",
    );
    const app = brick({
      services: [service],
      compiler,
      docs: false,
      requestLogging: false,
    });
    const request = (path: string, body: unknown) =>
      app.handle(
        new Request(`http://localhost/api/${service.name}/record${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    try {
      const defaultResponse = await request("/query", {});
      expect(await defaultResponse.json()).toEqual({
        items: [
          { id: 1, name: "A" },
          { id: 3, name: "B" },
        ],
        limit: 20,
        offset: 0,
      });
      expect(batches).toEqual([]);
      const defaultOne = await request("/find-one", {});
      expect(await defaultOne.json()).toEqual({ id: 1, name: "A" });
      expect(await resource.get.run({ id: 3 })).toEqual({ id: 3, name: "B" });
      expect(batches).toEqual([]);
      const response = await request("/query", {
        select: ["id"],
        include: ["children"],
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        items: [
          { id: 1, children: ["child-1"] },
          { id: 3, children: ["child-3"] },
        ],
        limit: 20,
        offset: 0,
      });
      expect(batches).toEqual([[1, 3]]);
      const found = await request("/find-one", {
        select: ["name"],
        include: ["children"],
      });
      expect(found.status).toBe(200);
      expect(await found.json()).toEqual({ name: "A", children: ["child-1"] });
      expect(await resource.get.run({ id: 3, include: ["children"] })).toEqual({
        id: 3,
        name: "B",
        children: ["child-3"],
      });
      await expect(resource.get.run({ id: 2 })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      const countBefore = batches.length;
      allowed = false;
      expect((await request("/query", { include: ["children"] })).status).toBe(
        401,
      );
      expect(batches.length).toBe(countBefore);
      allowed = true;
      expect((await request("/query", { include: ["missing"] })).status).toBe(
        400,
      );
      expect(
        (
          await request("/query", {
            where: { field: "children", op: "eq", value: [] },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request("/query", {
            orderBy: [{ field: "children", direction: "asc" }],
          })
        ).status,
      ).toBe(400);
      expect(batches.length).toBe(countBefore);
    } finally {
      sqlite.close();
    }
  });
}

for (const compiler of [false, true]) {
  test(`HTTP SDK serializes explicit includes and typed scrub schemas, compiler=${compiler}`, async () => {
    const { service, sqlite } = fixture({
      access: "public",
      fields: {},
      operations: false,
    });
    let resolved = 0;
    const resource = service
      .resource({ name: "named", table: records, id: records.name })
      .use(
        crud({
          access: "public",
          operations: { create: false, update: false, delete: false },
          fields: {
            name: { read: true },
            email: {
              read: true,
              schema: t.Union([t.String(), t.Null()]),
              scrub: ({ value }) => (value === null ? null : "masked"),
            },
            labels: {
              read: true,
              schema: t.Array(t.String()),
              resolve: ({ rows }) => rows.map(() => ["extra"]),
            },
            children: {
              read: true,
              schema: t.Array(t.String()),
              resolve: ({ rows }) => {
                resolved++;
                return rows.map((row) => [`child-${row.id}`]);
              },
            },
          },
        }),
      );
    sqlite.exec(
      "INSERT INTO records (name, email) VALUES ('A / B', 'secret@example.com')",
    );
    const app = brick({
      services: [service],
      compiler,
      docs: false,
      requestLogging: false,
    });
    const source = generateClientContract(app);
    const serialized = source.match(
      /export const contract: AppContract = JSON.parse\((.+)\);/,
    )?.[1];
    if (!serialized) throw new Error("Generated contract is missing");
    const contract = JSON.parse(JSON.parse(serialized))[service.name];
    const client = createBrickClient<{ named: typeof resource }>({
      baseUrl: "http://localhost",
      contract,
      fetch: async (url, init) => app.handle(new Request(String(url), init)),
    });
    try {
      expect(resource.get.config.output).toMatchObject({
        properties: {
          email: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      });
      expect(await client.named.get({ id: "A / B" })).toEqual({
        name: "A / B",
        email: "masked",
      });
      expect(resolved).toBe(0);
      expect(
        await client.named.get({ id: "A / B", include: ["children"] }),
      ).toEqual({ name: "A / B", email: "masked", children: ["child-1"] });
      expect(resolved).toBe(1);
      expect(
        await client.named.get({
          id: "A / B",
          include: ["children", "labels"],
        }),
      ).toEqual({
        name: "A / B",
        email: "masked",
        children: ["child-1"],
        labels: ["extra"],
      });
      expect(resolved).toBe(2);
      expect(await client.named.get({ id: "A / B" })).toEqual({
        name: "A / B",
        email: "masked",
      });
      expect(resolved).toBe(2);
    } finally {
      sqlite.close();
    }
  });
}
