import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { defineDatabase, defineService } from "@brickkit/core";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { crud } from "../src";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite("cursor pagination on Postgres", () => {
  const name = `cursor_${randomUUID().slice(0, 8)}`;
  const events = pgTable(name, {
    id: text("id").primaryKey(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull(),
  });
  const database = defineDatabase({
    engine: "postgres",
    url,
    tables: { [name]: events },
  });
  const db: any = database.getDb();
  afterAll(async () => {
    await db.$client.unsafe(`DROP TABLE IF EXISTS ${name}`);
    await database.close?.();
  });

  it("walks timestamps newest first, ties broken by text IDs", async () => {
    await db.$client.unsafe(
      `CREATE TABLE ${name} (id text PRIMARY KEY, at timestamptz(3) NOT NULL)`,
    );
    const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n, 123));
    await db.insert(events).values([
      { id: "a", at: at(1) },
      { id: "b", at: at(2) },
      { id: "c", at: at(2) },
      { id: "d", at: at(3) },
      { id: "e", at: at(1) },
    ]);
    const resource: any = defineService(name, { database })
      .resource({ name: "event", table: events, id: events.id })
      .use(
        crud({
          access: "public",
          fields: { id: { read: true }, at: { read: true, sort: true } },
        }),
      );
    const seen: string[][] = [];
    let cursor: string | null = null;
    do {
      const page: any = await resource.list.run({
        limit: 2,
        orderBy: [{ field: "at", direction: "desc" }],
        select: ["id"],
        cursor,
      });
      seen.push(page.items.map((item: { id: string }) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual([["d", "b"], ["c", "a"], ["e"]]);
  });

  it("pages microsecond timestamps that share a millisecond, both ways", async () => {
    const micro = pgTable(`${name}_us`, {
      id: text("id").primaryKey(),
      at: timestamp("at", { withTimezone: true }).notNull(),
    });
    await db.$client.unsafe(
      `CREATE TABLE ${name}_us (id text PRIMARY KEY, at timestamptz NOT NULL)`,
    );
    try {
      // a and b share one millisecond; their microseconds sort them b, a.
      await db.$client.unsafe(
        `INSERT INTO ${name}_us VALUES
          ('a', '2026-01-01 00:00:01.123900+00'),
          ('b', '2026-01-01 00:00:01.123100+00'),
          ('c', '2026-01-01 00:00:02+00')`,
      );
      const resource: any = defineService(`${name}_us`, { database })
        .resource({ name: "event", table: micro, id: micro.id })
        .use(
          crud({
            access: "public",
            fields: { id: { read: true }, at: { read: true, sort: true } },
          }),
        );
      const walk = async (direction: "asc" | "desc") => {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page: any = await resource.list.run({
            limit: 1,
            orderBy: [{ field: "at", direction }],
            select: ["id"],
            cursor,
          });
          seen.push(...page.items.map((item: { id: string }) => item.id));
          cursor = page.nextCursor;
        } while (cursor && seen.length < 10);
        return seen;
      };
      expect(await walk("asc")).toEqual(["a", "b", "c"]);
      expect(await walk("desc")).toEqual(["c", "a", "b"]);
    } finally {
      await db.$client.unsafe(`DROP TABLE IF EXISTS ${name}_us`);
    }
  });
});
