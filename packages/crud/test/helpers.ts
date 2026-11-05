import type { Database } from "bun:sqlite";
import { defineDatabase, defineService, syncSchema } from "@brickkit/core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { generateClientContract } from "../../cli/src/client-contract";

let sequence = 0;

/** A fresh in-memory SQLite database with `tables` created. */
export function sqliteDatabase(tables: SQLiteTable[]) {
  const database = defineDatabase({ tables });
  const db = database.getDb();
  syncSchema(tables, db);
  const sqlite = (db as typeof db & { $client: Database }).$client;
  return { database, db, sqlite };
}

/** A uniquely named service on a fresh in-memory SQLite database holding `tables`. */
export function sqliteService(prefix: string, tables: SQLiteTable[]) {
  const { database, db, sqlite } = sqliteDatabase(tables);
  const service = defineService(`${prefix}_${sequence++}`, { database });
  return { database, db, sqlite, service };
}

/** The generated client contract: its source, and the contract object it embeds. */
export function clientContract(
  app: Parameters<typeof generateClientContract>[0],
) {
  const source = generateClientContract(app);
  const serialized = source.match(
    /export const contract: AppContract = JSON.parse\((.+)\);/,
  )?.[1];
  if (!serialized) throw new Error("Generated contract is missing");
  return { source, contract: JSON.parse(JSON.parse(serialized)) };
}
