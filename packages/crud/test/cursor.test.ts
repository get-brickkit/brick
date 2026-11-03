import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { brick, defineDatabase, defineService } from "@brickkit/core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { crud } from "../src";
import { generateClientContract } from "../../cli/src/client-contract";

const posts = sqliteTable("posts", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  rank: integer("rank").notNull(),
  note: text("note"),
});

let sequence = 0;
function fixture() {
  const database = defineDatabase({ tables: [posts] });
  const db = database.getDb() as ReturnType<typeof database.getDb> & {
    $client: Database;
  };
  db.$client.exec(
    "CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, rank INTEGER NOT NULL, note TEXT)",
  );
  // Ranks repeat, so the ID has to break ties.
  for (let id = 1; id <= 7; id++)
    db.$client.run(
      `INSERT INTO posts VALUES (${id}, 'p${id}', ${id % 3}, NULL)`,
    );
  const service = defineService(`cursor_${sequence++}`, { database });
  const resource: any = service
    .resource({ name: "post", table: posts, id: posts.id })
    .use(
      crud({
        access: "public",
        fields: {
          id: { read: true, sort: true },
          title: { read: true },
          rank: { read: true, sort: true },
          note: { read: true, sort: true },
        },
      }),
    );
  return { service, resource };
}

async function walk(resource: any, input: Record<string, unknown>) {
  const pages: number[][] = [];
  let cursor: string | null = null;
  do {
    const page: any = await resource.list.run({ ...input, cursor });
    pages.push(page.items.map((item: { id: number }) => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  return pages;
}

test("cursor pages walk every row once, ties broken by the ID", async () => {
  const { resource } = fixture();
  expect(await walk(resource, { limit: 3 })).toEqual([
    [1, 2, 3],
    [4, 5, 6],
    [7],
  ]);
  // rank desc: 2 (2, 5), 1 (1, 4, 7), 0 (3, 6)
  const ranked = await walk(resource, {
    limit: 2,
    orderBy: [{ field: "rank", direction: "desc" }],
  });
  expect(ranked).toEqual([[2, 5], [1, 4], [7, 3], [6]]);
});

test("a cursor page keeps the selection, the total and the offset fields", async () => {
  const { resource } = fixture();
  const first = await resource.list.run({
    limit: 4,
    select: ["title"],
    includeTotal: true,
    cursor: null,
  });
  expect(first).toEqual({
    items: ["p1", "p2", "p3", "p4"].map((title) => ({ title })),
    total: 7,
    limit: 4,
    offset: 0,
    nextCursor: expect.any(String),
  });
  const second = await resource.list.run({
    limit: 4,
    select: ["title"],
    includeTotal: true,
    cursor: first.nextCursor,
  });
  expect(second).toMatchObject({ total: 7, nextCursor: null });
  expect(second.items).toEqual(["p5", "p6", "p7"].map((title) => ({ title })));
  // Offset pagination is unchanged: no nextCursor.
  expect(await resource.list.run({ limit: 1 })).toEqual({
    items: [{ id: 1, title: "p1", rank: 1, note: null }],
    limit: 1,
    offset: 0,
  });
});

test("bad cursors are 400s", async () => {
  const { resource } = fixture();
  const { nextCursor } = await resource.list.run({ limit: 1, cursor: null });
  await expect(
    resource.list.run({ cursor: nextCursor, offset: 2 }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    resource.list.run({
      cursor: nextCursor,
      orderBy: [{ field: "rank", direction: "asc" }],
    }),
  ).rejects.toMatchObject({ message: "Invalid cursor for this orderBy" });
  await expect(
    resource.list.run({ cursor: "not a cursor" }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  const forged = Buffer.from(JSON.stringify(["", ["1 OR 1=1"]])).toString(
    "base64url",
  );
  await expect(resource.list.run({ cursor: forged })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });
  await expect(
    resource.list.run({
      cursor: null,
      orderBy: [{ field: "note", direction: "asc" }],
    }),
  ).rejects.toMatchObject({
    message: "Cursor pagination needs sort fields that are not null",
  });
  // findOne takes no cursor.
  await expect(
    resource.findOne.run({ cursor: null } as never),
  ).rejects.toBeDefined();
});

test("the typed client contract carries cursor and nextCursor", () => {
  const { service } = fixture();
  const contract = generateClientContract(
    brick({ services: [service], requestLogging: false }),
  );
  expect(contract).toContain(`"cursor"?: (string | null); }, { "items"`);
  expect(contract).toContain(`"nextCursor"?: (string | null); }`);
});
