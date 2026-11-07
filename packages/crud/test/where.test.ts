import { test, expect } from "bun:test";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { brick, defineService, defineDatabase } from "@brickkit/core";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { crud } from "../src";
import { clientContract, sqliteService } from "./helpers";

const records = sqliteTable("where_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email"),
  active: integer("active", { mode: "boolean" }).default(true),
});

function fixture() {
  const { sqlite, service } = sqliteService("where_test", [records]);
  const resource: any = service
    .resource({ name: "record", table: records, id: records.id })
    .use(
      crud({
        access: "public",
        fields: {
          id: {
            read: true,
            filter: [
              "eq",
              "ne",
              "in",
              "notIn",
              "gt",
              "gte",
              "lt",
              "lte",
              "between",
              "isNull",
              "isNotNull",
            ],
          },
          name: {
            read: true,
            create: true,
            filter: [
              "eq",
              "ne",
              "in",
              "notIn",
              "gt",
              "gte",
              "lt",
              "lte",
              "between",
              "contains",
              "startsWith",
              "endsWith",
              "isNull",
              "isNotNull",
            ],
          },
          email: {
            read: true,
            create: true,
            filter: ["eq", "ne", "in", "isNull", "isNotNull"],
          },
          active: { read: true, create: true, filter: ["eq"] },
        },
      }),
    );
  return { sqlite, resource, service };
}

async function seed(resource: any) {
  await resource.create.run({ name: "Alice", email: "alice@example.com" });
  await resource.create.run({ name: "Bob", email: null });
  await resource.create.run({ name: "Carol", email: "carol@example.com" });
}

test("the typed client names each where leaf, and the where schema compiles in linear size", () => {
  const { service, resource, sqlite } = fixture();
  try {
    const { source } = clientContract(
      brick({ services: [service], docs: false }),
    );
    expect(source).toContain(
      "export type BrickCrudWhere_record = (BrickWhere_record_id | BrickWhere_record_name | BrickWhere_record_email | BrickWhere_record_active | BrickWhere_record_and | BrickWhere_record_or);",
    );
    const compiled = TypeCompiler.Compile(
      resource.list.config.input.properties.where,
    );
    expect(compiled.Code().match(/function check_/g)?.length).toBeLessThan(40);
  } finally {
    sqlite.close();
  }
});

test("every filter operator shape validates and filters", async () => {
  const { resource, sqlite } = fixture();
  try {
    await seed(resource);
    const names = async (where: unknown) =>
      ((await resource.list.run({ where, select: ["name"] })) as any).items.map(
        (row: any) => row.name,
      );
    expect(await names({ field: "id", op: "eq", value: 1 })).toEqual(["Alice"]);
    expect(await names({ field: "id", op: "ne", value: 1 })).toEqual([
      "Bob",
      "Carol",
    ]);
    expect(await names({ field: "id", op: "in", value: [1, 3] })).toEqual([
      "Alice",
      "Carol",
    ]);
    expect(await names({ field: "id", op: "notIn", value: [1, 3] })).toEqual([
      "Bob",
    ]);
    expect(await names({ field: "id", op: "gt", value: 1 })).toEqual([
      "Bob",
      "Carol",
    ]);
    expect(await names({ field: "id", op: "gte", value: 2 })).toEqual([
      "Bob",
      "Carol",
    ]);
    expect(await names({ field: "id", op: "lt", value: 3 })).toEqual([
      "Alice",
      "Bob",
    ]);
    expect(await names({ field: "id", op: "lte", value: 2 })).toEqual([
      "Alice",
      "Bob",
    ]);
    expect(await names({ field: "id", op: "between", value: [2, 3] })).toEqual([
      "Bob",
      "Carol",
    ]);
    expect(await names({ field: "name", op: "contains", value: "o" })).toEqual([
      "Bob",
      "Carol",
    ]);
    expect(
      await names({ field: "name", op: "startsWith", value: "A" }),
    ).toEqual(["Alice"]);
    expect(await names({ field: "name", op: "endsWith", value: "b" })).toEqual([
      "Bob",
    ]);
    expect(await names({ field: "name", op: "isNull" })).toEqual([]);
    expect(await names({ field: "name", op: "isNotNull" })).toEqual([
      "Alice",
      "Bob",
      "Carol",
    ]);
    expect(await names({ field: "email", op: "isNull" })).toEqual(["Bob"]);
    expect(await names({ field: "email", op: "eq", value: "x" })).toEqual([]);
    expect(await names({ field: "active", op: "eq", value: true })).toEqual([
      "Alice",
      "Bob",
      "Carol",
    ]);
    // Nesting across named branches.
    expect(
      await resource.count.run({
        where: {
          or: [
            { field: "id", op: "eq", value: 1 },
            {
              and: [
                { field: "name", op: "startsWith", value: "C" },
                { field: "email", op: "isNotNull" },
              ],
            },
          ],
        },
      }),
    ).toEqual({ count: 2 });
    expect(
      await names({
        and: [
          { field: "id", op: "gte", value: 1 },
          { or: [{ field: "email", op: "isNull" }] },
        ],
      }),
    ).toEqual(["Bob"]);
  } finally {
    sqlite.close();
  }
});

test("malformed where shapes reject with 400", async () => {
  const { resource, sqlite } = fixture();
  try {
    await seed(resource);
    for (const where of [
      { field: "id", op: "eq", value: "1" },
      { field: "id", op: "in", value: [] },
      { field: "id", op: "in", value: Array.from({ length: 1001 }, () => 1) },
      { field: "id", op: "between", value: [1] },
      { field: "id", op: "isNull", value: 1 },
      { field: "email", op: "eq", value: null },
      { field: "name", op: "eq", value: 1, extra: true },
      { field: "active", op: "contains", value: "x" },
      { field: "missing", op: "eq", value: "x" },
      { field: "id", op: "nope", value: 1 },
      { and: [] },
      { or: [{ field: "id", op: "eq", value: 1 }, { bad: true }] },
      { unknown: true },
    ])
      await expect(
        resource.list.run({ where: where as never }),
      ).rejects.toMatchObject({ status: 400 });
  } finally {
    sqlite.close();
  }
});

test("filter fields colliding with branch names fail fast", () => {
  for (const branch of ["and", "or"]) {
    const odd = sqliteTable(`where_odd_${branch}`, {
      id: integer("id").primaryKey({ autoIncrement: true }),
      [branch]: text(branch),
    });
    const database = defineDatabase({ tables: [odd] });
    const service = defineService(`where_collision_${branch}`, { database });
    expect(() =>
      service.resource({ name: "record", table: odd, id: odd.id }).use(
        crud({
          access: "public",
          fields: {
            id: { read: true },
            [branch]: { read: true, filter: ["eq"] },
          },
        }),
      ),
    ).toThrow(`collides with the '${branch}' branch`);
  }
});
