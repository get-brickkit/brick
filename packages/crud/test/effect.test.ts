import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";

import { crud } from "../src";
import { sqliteService } from "./helpers";

const notes = sqliteTable("effect_notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  owner: text("owner").notNull(),
  body: text("body").notNull(),
});

test("crud callbacks may return an Effect", async () => {
  const { service, sqlite } = sqliteService("effect", [notes]);
  const seen: string[] = [];
  const notes_: any = service
    .resource({ name: "note", table: notes, id: notes.id })
    .use(
      crud({
        fields: {
          id: { read: true, filter: ["eq"] },
          owner: { read: true, create: true },
          body: {
            read: true,
            create: true,
            scrub: ({ value }) => Effect.succeed(`<${value}>`),
          },
        },
        access: {
          authorize: ({ operation }) => Effect.succeed(operation !== "delete"),
          scope: ({ operation }) =>
            Effect.succeed(
              operation === "create" ? undefined : eq(notes.owner, "me"),
            ),
        },
        hooks: {
          beforeCreate: ({ data }) =>
            Effect.sync(() => void seen.push(`before:${data.body}`)),
          afterCommit: ({ operation }) =>
            Effect.sync(() => void seen.push(`commit:${operation}`)),
        },
      }),
    );
  try {
    const created = await notes_.create.run({ owner: "me", body: "hi" });
    expect(created).toMatchObject({ id: 1, body: "<hi>" });
    expect(seen).toEqual(["before:hi", "commit:create"]);
    expect(await notes_.get.run({ id: 1 })).toMatchObject({ body: "<hi>" });
    await expect(notes_.delete.run({ id: 1 })).rejects.toMatchObject({
      status: 401,
    });
  } finally {
    sqlite.close();
  }
});
