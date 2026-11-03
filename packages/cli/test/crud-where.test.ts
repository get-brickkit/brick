import { beforeEach, expect, it } from "bun:test";
import {
  defineService,
  defineDatabase,
  syncSchema,
  sqliteTable,
  text,
  integer,
  resetGlobalRegistry,
  brick,
} from "@brickkit/core";
import { crud } from "@brickkit/crud";
import { generateClientContract } from "../src/client-contract";

beforeEach(resetGlobalRegistry);

const table = sqliteTable("contract_pages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  slug: text("slug"),
});

function app() {
  const database = defineDatabase({ tables: [table] });
  const db = database.getDb();
  syncSchema(database.tables, db);
  const service = defineService("content", { database });
  service.resource({ name: "page", table, id: table.id }).use(
    crud({
      access: "public",
      fields: {
        id: { read: true, filter: ["eq", "in", "isNull"] },
        title: {
          read: true,
          create: true,
          filter: ["eq", "contains", "notIn"],
        },
        slug: { read: true, filter: ["eq", "ne"] },
      },
    }),
  );
  return { app: brick({ services: [service], requestLogging: false }), db };
}

it("generates readable named where types instead of hash aliases", () => {
  const { app: application, db } = app();
  try {
    const source = generateClientContract(application);
    const whereLine = source
      .split("\n")
      .find((line) => line.startsWith("export type BrickCrudWhere_page ="));
    expect(whereLine).toBe(
      "export type BrickCrudWhere_page = (BrickWhere_page_id | BrickWhere_page_title | BrickWhere_page_slug | BrickWhere_page_and | BrickWhere_page_or);",
    );
    expect(source).toContain(
      'export type BrickWhere_page_and = { "and": Array<BrickCrudWhere_page>; };',
    );
    expect(source).toContain(
      'export type BrickWhere_page_or = { "or": Array<BrickCrudWhere_page>; };',
    );
    // Per-field unions keep that field's operators together, even when the
    // generator hoists a repeated union body into a shared fragment.
    const schemaLines = source
      .split("\n")
      .filter((line) => line.startsWith("export type BrickSchema_"));
    const titleHolders = schemaLines.filter((line) =>
      line.includes('"field": "title"'),
    );
    expect(titleHolders.length).toBeGreaterThan(0);
    for (const line of titleHolders) {
      expect(line).toContain('"op": "contains"');
      expect(line).not.toContain('"field": "id"');
      expect(line).not.toContain('"field": "slug"');
    }
  } finally {
    db.$client.close();
  }
});

it("emits the named where schemas in OpenAPI and still queries through them", async () => {
  const { app: application, db } = app();
  try {
    const spec = await (
      await application.handle(new Request("http://localhost/openapi.json"))
    ).json();
    const serialized = JSON.stringify(spec);
    expect(serialized).toContain("Where:page:title");
    expect(serialized).toContain("Where:page:and");
    expect(serialized).toContain("CrudWhere:page:id");
    const call = (path: string, body?: unknown) =>
      application.handle(
        new Request(`http://localhost/api/content/page${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    await (await call("", { title: "Hello" })).json();
    await (await call("", { title: "Other" })).json();
    expect(
      await (
        await call("/query", {
          where: {
            or: [
              { field: "title", op: "contains", value: "ell" },
              {
                and: [
                  { field: "id", op: "in", value: [2] },
                  { field: "title", op: "notIn", value: ["x"] },
                ],
              },
            ],
          },
        })
      ).json(),
    ).toMatchObject({ items: [{ title: "Hello" }, { title: "Other" }] });
    expect(
      (await call("/query", { where: { field: "id", op: "eq", value: "x" } }))
        .status,
    ).toBe(400);
  } finally {
    db.$client.close();
  }
});
