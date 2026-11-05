import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { defineDatabase, SecretRef } from "../src";

describe("database handle disposal", () => {
  it("closes an owned SQLite client once and rejects further access", () => {
    const handle = defineDatabase();
    const db = handle.getDb();
    expect(db.get(sql`select 42 as value`)).toEqual([42]);
    handle.close?.();
    expect(() => db.get(sql`select 42 as value`)).toThrow();
    expect(() => handle.getDb()).toThrow("Brick database handle is closed");
    expect(() => handle.close?.()).not.toThrow();
  });

  it("leaves an injected SQLite client usable", () => {
    const client = new Database(":memory:");
    try {
      const handle = defineDatabase({ client });
      handle.getDb();
      handle.close?.();
      handle.close?.();
      expect(client.query("select 42 as value").get()).toEqual({ value: 42 });
      expect(() => handle.getDb()).toThrow("Brick database handle is closed");
    } finally {
      client.close();
    }
  });

  it("closes unopened handles without resolving their connection secrets", () => {
    for (const handle of [
      defineDatabase({ path: new SecretRef("BRICK_DISPOSE_UNUSED_SQLITE") }),
      defineDatabase({
        engine: "postgres",
        url: new SecretRef("BRICK_DISPOSE_UNUSED_PG"),
      }),
    ]) {
      expect(() => handle.close?.()).not.toThrow();
      expect(() => handle.getDb()).toThrow("Brick database handle is closed");
    }
  });

  it("ends an owned Postgres client without opening a connection", async () => {
    const handle = defineDatabase({
      engine: "postgres",
      url: "postgres://localhost:1/unused",
    });
    handle.getDb();
    const closing = handle.close?.();
    expect(handle.close?.()).toBe(closing);
    await closing;
    expect(() => handle.getDb()).toThrow("Brick database handle is closed");
  });

  it("does not end an injected Postgres client", async () => {
    const client = postgres("postgres://localhost:1/unused");
    const originalEnd = client.end;
    let ended = false;
    client.end = async () => {
      ended = true;
    };
    try {
      const handle = defineDatabase({ engine: "postgres", client });
      handle.getDb();
      await handle.close?.();
      expect(ended).toBe(false);
    } finally {
      client.end = originalEnd;
      await client.end();
    }
  });
});
