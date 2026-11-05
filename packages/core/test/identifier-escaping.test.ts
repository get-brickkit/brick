import { describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { createSQLiteDatabase, sql } from "../src";

describe("CVE-2026-39356 identifier escaping", () => {
  const dialects = [
    { name: "PostgreSQL", dialect: new PgDialect(), quote: '"' },
    { name: "SQLite", dialect: new SQLiteSyncDialect(), quote: '"' },
  ];

  for (const { name, dialect, quote } of dialects) {
    it(`${name} keeps embedded delimiters inside identifiers and aliases`, () => {
      const input = `name${quote}, (SELECT secret FROM users) --${quote}`;
      const escaped = `${quote}name${quote}${quote}, (SELECT secret FROM users) --${quote}${quote}${quote}`;
      expect(dialect.sqlToQuery(sql`${sql.identifier(input)}`).sql).toBe(
        escaped,
      );
      expect(dialect.sqlToQuery(sql`${sql`1`.as(input)}`).sql).toBe(escaped);
    });
  }

  it("executes a quoted SQLite alias as a single literal result key", () => {
    const db = createSQLiteDatabase();
    const alias = 'value", (SELECT secret FROM users) --"';
    try {
      const query = db
        .select({ value: sql`1`.as(alias) })
        .from(sql`(SELECT 1)`)
        .toSQL();
      expect(db.$client.query(query.sql).get()).toEqual({ [alias]: 1 });
    } finally {
      db.$client.close();
    }
  });
});
