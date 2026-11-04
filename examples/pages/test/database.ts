import { defineDatabase, getTableName } from "@brickkit/core";
import postgres from "postgres";

import { initAuth } from "../src/api/auth";
import { appDb } from "../src/api/db";
import { pagesService } from "../src/api/services/pages/service";
import { applyMigrations } from "../scripts/migrations";

// Postgres-backed test databases. Tests run under Bun; the Start server
// runs the same code on Node (no bun:sqlite anywhere in this chain).
// Override with TEST_DATABASE_URL; the database is created on demand.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://localhost:5432/drafton_test";

// Committed migrations (`bun run db:generate`) are the single schema source:
// applying them here also proves they actually run on Postgres.
const migrateOnce = applyMigrations;

let migratedUrl: string | null = null;

async function truncateAll(url: string): Promise<void> {
  const sql = postgres(url, { max: 1 });
  try {
    const names = Object.values(appDb.schema)
      .map((table) => `"${getTableName(table as never)}"`)
      .join(", ");
    await sql.unsafe(`TRUNCATE TABLE ${names} CASCADE`);
  } finally {
    await sql.end();
  }
}

/**
 * Fresh isolated database: migrate once per process, empty every call
 * (TRUNCATE … CASCADE), then point the service + auth singletons at it.
 */
export async function prepareTestDatabase() {
  if (migratedUrl !== TEST_DATABASE_URL) {
    await migrateOnce(TEST_DATABASE_URL);
    migratedUrl = TEST_DATABASE_URL;
  }
  await truncateAll(TEST_DATABASE_URL);
  const database = defineDatabase({
    engine: "postgres",
    tables: appDb.schema,
    client: postgres(TEST_DATABASE_URL, { max: 1 }),
  });
  pagesService.setDb(database);
  await initAuth(database).$context;
  return database;
}
