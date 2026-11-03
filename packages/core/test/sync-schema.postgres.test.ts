import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { integer, pgEnum, pgTable, serial, text } from "drizzle-orm/pg-core";
import { defineDatabase, outboxTable, syncSchema } from "../src";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("syncSchema on Postgres", () => {
  const suffix = randomUUID().slice(0, 8);
  const mood = pgEnum(`mood_${suffix}`, ["calm", "busy"]);
  const authors = pgTable(`authors_${suffix}`, {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
  });
  const posts = pgTable(`posts_${suffix}`, {
    id: serial("id").primaryKey(),
    authorId: integer("author_id").references(() => authors.id),
    mood: mood("mood").notNull().default("calm"),
  });
  const outbox = outboxTable("postgres", { name: `outbox_${suffix}` });
  const database = defineDatabase({
    engine: "postgres",
    url,
    tables: { authors, posts, outbox },
  });
  const db: any = database.getDb();
  afterAll(async () => {
    await db.$client.unsafe(
      `DROP TABLE IF EXISTS posts_${suffix}, authors_${suffix}, outbox_${suffix}; DROP TYPE IF EXISTS mood_${suffix};`,
    );
    await database.close?.();
  });

  it("creates the missing tables, enums and foreign keys, and keeps existing ones", async () => {
    await db.$client.unsafe(
      `CREATE TABLE authors_${suffix} (id serial PRIMARY KEY, name text NOT NULL, legacy text)`,
    );
    await db.$client.unsafe(
      `INSERT INTO authors_${suffix} (name, legacy) VALUES ('Ada', 'kept')`,
    );
    await syncSchema(database.tables, db);
    await db.insert(posts).values({ authorId: 1 });
    expect(await db.select().from(posts)).toEqual([
      { id: 1, authorId: 1, mood: "calm" },
    ]);
    // The existing table was not altered: its extra column and row remain.
    const [author] = await db.$client.unsafe(
      `SELECT legacy FROM authors_${suffix}`,
    );
    expect(author.legacy).toBe("kept");
    await expect(
      (async () => db.insert(posts).values({ authorId: 99 }))(),
    ).rejects.toMatchObject({ cause: { code: "23503" } }); // foreign_key_violation
    const [{ count }] = await db.$client.unsafe(
      `SELECT count(*)::int AS count FROM outbox_${suffix}`,
    );
    expect(count).toBe(0);
    // Idempotent.
    await syncSchema(database.tables, db);
  });
});
