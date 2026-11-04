import { expect, test } from "bun:test";
import {
  defineDatabase,
  defineService,
  getTableName,
  sqliteTable,
  syncSchema,
  text,
  ValidationError,
} from "@brickkit/core";
import { createTestApp } from "@brickkit/core/testing";
import { crud } from "@brickkit/crud";
import { comments } from "../src/extensions/comments";

const pages = sqliteTable("pages", { id: text("id").primaryKey() });

function setup(name: string) {
  const database = defineDatabase({ tables: { pages } });
  const service = defineService(name, { database });
  const page = service
    .resource({ name: "page", table: pages, id: pages.id })
    .use(
      crud({ access: "public", fields: { id: { read: true, create: true } } }),
    )
    .use(comments());
  const db = database.getDb();
  syncSchema(service);
  return { database, db, page, service };
}

test("the plugin owns its table in the host database", () => {
  const { database, page } = setup("comment_tables");
  expect(getTableName(page.comments.table)).toBe("page_comments");
  expect(Object.keys(database.tables)).toEqual(["pages", "page_comments"]);
});

test("comment creation rejects missing, null and blank bodies without inserting", async () => {
  const { db, page } = setup("comment_body_validation");
  const table = page.comments.table;
  await db.insert(pages).values({ id: "page-1" });

  for (const input of [
    { targetId: "page-1" },
    { targetId: "page-1", body: undefined },
    { targetId: "page-1", body: null },
  ]) {
    // @ts-expect-error Exercise invalid inputs that can arrive from external callers.
    await expect(page.comments.create.run(input)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await db.select().from(table)).toEqual([]);
  }

  for (const body of ["", "   ", "\n\t"]) {
    await expect(
      page.comments.create.run({ targetId: "page-1", body }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Comment body cannot be blank",
      status: 400,
    });
    expect(await db.select().from(table)).toEqual([]);
  }

  await page.comments.create.run({ targetId: "page-1", body: "  Hello  " });
  expect(await db.select({ body: table.body }).from(table)).toEqual([
    { body: "Hello" },
  ]);
});

test("deleting the host record deletes its comments in the same transaction", async () => {
  const { db, page } = setup("comment_cascade");
  await db.insert(pages).values([{ id: "a" }, { id: "b" }]);
  await page.comments.create.run({ targetId: "a", body: "on a" });
  await page.comments.create.run({ targetId: "b", body: "on b" });
  await page.delete.run({ id: "a" });
  expect(
    (await db.select().from(page.comments.table)).map((row) => row.targetId),
  ).toEqual(["b"]);
});

test("comments.added joins the host's catalog and dashboard extension is declared", async () => {
  const { service } = setup("comment_events");
  const catalog: Record<string, { name: string }> = service.events;
  expect(catalog["comments.added"]?.name).toBe("comment_events.comments.added");
  const { app, cleanup } = createTestApp({ services: [service] });
  expect(app.definition.plugins).toEqual([
    {
      name: "@brick-examples/comments",
      brick: ">=0.10.0 <0.13.0",
      scope: "resource",
      service: "comment_events",
      resource: "page",
      dashboard: expect.stringMatching(/extensions\/comments\/dashboard\.tsx$/),
    },
  ]);
  await cleanup();
});
