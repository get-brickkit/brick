import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

/**
 * Create the database if it is missing, then apply the committed migrations
 * (drizzle/) it has not run yet, recorded in `_applied_migrations`. Used by the
 * tests and the benchmark on their own databases; the app never migrates.
 */
export async function applyMigrations(url: string): Promise<void> {
  const name = new URL(url).pathname.replace(/^\//, "");
  const adminUrl = new URL(url);
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
  try {
    const found =
      await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (found.length === 0)
      await admin.unsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  } finally {
    await admin.end();
  }
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS _applied_migrations (name text PRIMARY KEY)`;
    const dir = join(import.meta.dir, "../drizzle");
    const files = readdirSync(dir)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    const applied = new Set(
      (await sql`SELECT name FROM _applied_migrations`).map((row) => row.name),
    );
    // A database migrated before this table existed has the first migration.
    const legacy =
      await sql`SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'pages'`;
    if (legacy.length > 0 && !applied.has(files[0])) {
      await sql`INSERT INTO _applied_migrations (name) VALUES (${files[0]!})`;
      applied.add(files[0]);
    }
    // A database `drizzle-kit migrate` set up has the first N, in order, in its journal.
    const [journal] =
      await sql`SELECT to_regclass('drizzle.__drizzle_migrations') AS name`;
    if (journal?.name) {
      const [{ count }] =
        await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
      for (const file of files.slice(0, count))
        if (!applied.has(file)) {
          await sql`INSERT INTO _applied_migrations (name) VALUES (${file})`;
          applied.add(file);
        }
    }
    for (const file of files) {
      if (applied.has(file)) continue;
      await sql.begin(async (tx) => {
        for (const raw of readFileSync(join(dir, file), "utf8").split(
          "--> statement-breakpoint",
        )) {
          const statement = raw.trim();
          if (statement) await tx.unsafe(statement);
        }
        await tx`INSERT INTO _applied_migrations (name) VALUES (${file}) ON CONFLICT DO NOTHING`;
      });
    }
  } finally {
    await sql.end();
  }
}

/**
 * The benchmark's lookup table, in the benchmark's database only (bench/run.ts):
 * it is not part of the app's schema or migrations.
 */
export async function seedBench(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`CREATE TABLE IF NOT EXISTS bench_items (id integer PRIMARY KEY, name text NOT NULL, value integer NOT NULL)`;
    await sql`INSERT INTO bench_items (id, name, value) SELECT i, 'item-' || i, i * 10 FROM generate_series(1, 100) AS i ON CONFLICT (id) DO NOTHING`;
  } finally {
    await sql.end();
  }
}
