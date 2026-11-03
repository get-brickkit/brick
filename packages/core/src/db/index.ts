import type { Service } from "../types";
import type { DatabaseHandle } from "./define";
import {
  createSQLiteDatabase,
  type SQLiteDatabaseConfig,
  type BunSQLiteDatabase,
} from "./sqlite";
import {
  createPostgresDatabase,
  type PostgresDatabaseConfig,
  type PostgresDatabase,
} from "./postgres";
import { getTableColumns, getTableName, sql, type Table } from "drizzle-orm";
import { getTableConfig, isPgEnum } from "drizzle-orm/pg-core";

export * from "./sqlite";
export * from "./postgres";
export * from "./define";

// Re-export core Drizzle SQL expressions & operators for convenience
export {
  sql,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  and,
  or,
  not,
  desc,
  asc,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  like,
  ilike,
  relations,
  getTableColumns,
  getTableName,
  Table,
  is,
} from "drizzle-orm";

export interface DatabaseConfig<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
>
  extends
    Omit<SQLiteDatabaseConfig<TSchema>, "client">,
    Omit<PostgresDatabaseConfig<TSchema>, "client"> {
  client?:
    | SQLiteDatabaseConfig<TSchema>["client"]
    | PostgresDatabaseConfig<TSchema>["client"];
  /** Database engine. Default: 'sqlite' */
  engine?: "sqlite" | "postgres" | "clickhouse";
  /** Optional service name associated with this database */
  name?: string;
}

export type BrickDatabase<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = BunSQLiteDatabase<TSchema> | PostgresDatabase<TSchema>;

/**
 * Creates a database instance based on the provided configuration.
 * Zero-config: calling `createDatabase()` returns an ultra-fast Bun-native SQLite
 * database in `:memory:` mode wrapped with Drizzle ORM.
 */
export function createDatabase<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
>(
  config: DatabaseConfig<TSchema> = {},
): BunSQLiteDatabase<TSchema> | PostgresDatabase<TSchema> {
  const engine = config.engine ?? "sqlite";

  if (engine === "sqlite") {
    return createSQLiteDatabase<TSchema>(
      config as SQLiteDatabaseConfig<TSchema>,
    );
  }

  if (engine === "postgres") {
    return createPostgresDatabase<TSchema>(
      config as PostgresDatabaseConfig<TSchema>,
    );
  }

  throw new Error(`[Brick-TS DB] Unsupported database engine: '${engine}'`);
}

/** Attach a defined database. Schema changes remain the caller's responsibility. */
export function attachDatabase<TDb>(
  service: Service<TDb, any>,
  database: DatabaseHandle<TDb>,
): TDb {
  service.setDb(database);
  return database.getDb();
}

/**
 * Generates an idempotent SQLite CREATE TABLE IF NOT EXISTS definition
 * directly from a Drizzle table schema.
 */
export function generateSQLiteTableDdl(table: any): string {
  const tableName = getTableName(table);
  const columns = getTableColumns(table);
  const colDefs: string[] = [];

  for (const [, col] of Object.entries(columns) as [string, any][]) {
    let def = `"${col.name}" ${col.getSQLType().toUpperCase()}`;
    if (col.primary) def += " PRIMARY KEY";
    if (col.notNull) def += " NOT NULL";
    if (col.isUnique) def += " UNIQUE";
    if (col.hasDefault) {
      if (typeof col.default === "string") {
        def += ` DEFAULT '${col.default.replace(/'/g, "''")}'`;
      } else if (typeof col.default === "boolean") {
        def += ` DEFAULT ${col.default ? 1 : 0}`;
      } else if (typeof col.default === "number") {
        def += ` DEFAULT ${col.default}`;
      } else if (col.default !== undefined) {
        def += ` DEFAULT ${col.default}`;
      }
    }
    colDefs.push(def);
  }

  return `CREATE TABLE IF NOT EXISTS "${tableName}" (\n  ${colDefs.join(",\n  ")}\n);`;
}

/**
 * Generates idempotent secondary index DDL for a Drizzle table.
 * Covers owner scoping, sort columns, and exact-match filters.
 * UNIQUE columns already carry an implicit index — skipped here.
 * FTS/trigram indexes are handled separately by the search layer.
 */
export function generateSQLiteIndexDdl(
  table: any,
  opts: { ownerField?: string; sortFields?: string[] } = {},
): string[] {
  const tableName = getTableName(table);
  const columns = getTableColumns(table);
  const stmts: string[] = [];
  const seen = new Set<string>();
  const push = (name: string, cols: string[]) => {
    const clean = cols.filter(Boolean);
    if (clean.length === 0) return;
    const key = `${name}(${clean.join(",")})`;
    if (seen.has(key)) return;
    seen.add(key);
    const colList = clean.map((c) => `"${c}"`).join(", ");
    stmts.push(
      `CREATE INDEX IF NOT EXISTS "${name}" ON "${tableName}" (${colList});`,
    );
  };

  const colNameOf = (field: string): string | undefined => {
    if ((columns as any)[field]) return (columns as any)[field].name ?? field;
    for (const col of Object.values(columns) as any[]) {
      if (col.name === field) return col.name;
    }
    return undefined;
  };

  // Owner scope index: WHERE user_id = ? (+ sort composite below).
  let ownerCol: string | undefined;
  if (opts.ownerField) {
    const oc = colNameOf(opts.ownerField);
    if (oc) {
      ownerCol = oc;
      push(`idx_${tableName}_${oc}`, [oc]);
    }
  }

  // Sort column indexes (updated_at / created_at drive default ORDER BY).
  const sorts = opts.sortFields ?? ["updated_at", "created_at"];
  const sortCols: string[] = [];
  for (const f of sorts) {
    const c = colNameOf(f);
    if (c) {
      sortCols.push(c);
      push(`idx_${tableName}_${c}`, [c]);
    }
  }

  // Composite owner+sort — the hot path for scoped sorted lists.
  if (ownerCol && sortCols.length > 0) {
    push(`idx_${tableName}_${ownerCol}_${sortCols[0]}`, [
      ownerCol,
      sortCols[0],
    ]);
  }

  return stmts;
}

/**
 * Ensures secondary indexes exist for a resource table.
 * SQLite: B-tree indexes for owner scope + sort + composite hot path.
 * Postgres: same B-trees plus pg_trgm GIN indexes for substring search.
 * Best-effort: failures warn and continue (e.g. read-only replicas).
 */
export function ensureResourceIndexes(
  db: any,
  table: any,
  opts: {
    ownerField?: string;
    sortFields?: string[];
    searchFields?: string[];
  } = {},
): void {
  if (!db) return;
  const isPostgres =
    typeof (db as any).execute === "function" && !(db as any).$client?.run;
  const stmts = generateSQLiteIndexDdl(table, opts);
  // Postgres trigram support for LIKE %term% (requires superuser for extension;
  // failure is silently ignored — LIKE still works, just slower).
  if (isPostgres && opts.searchFields && opts.searchFields.length > 0) {
    const tableName = getTableName(table);
    const columns = getTableColumns(table);
    const colNameOf = (f: string): string | undefined => {
      if ((columns as any)[f]) return (columns as any)[f].name ?? f;
      for (const col of Object.values(columns) as any[]) {
        if (col.name === f) return col.name;
      }
      return undefined;
    };
    for (const f of opts.searchFields) {
      const c = colNameOf(f);
      if (c) {
        stmts.push(
          `CREATE INDEX IF NOT EXISTS "idx_${tableName}_${c}_trgm" ON "${tableName}" USING gin ("${c}" gin_trgm_ops);`,
        );
      }
    }
  }
  if (stmts.length === 0) return;
  const run = (stmt: string) => {
    try {
      if ((db as any).$client?.run) {
        (db as any).$client.run(stmt);
      } else if (typeof (db as any).execute === "function") {
        void (db as any).execute(sql.raw(stmt)).catch(() => {});
      } else if ((db as any).run) {
        (db as any).run(stmt);
      }
    } catch {
      // best-effort
    }
  };
  if (isPostgres) {
    run(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
  }
  for (const s of stmts) run(s);
}

/**
 * SQLite FTS5 search layer for resource list (?search=).
 * B-tree indexes cannot serve LIKE '%term%' (leading wildcard forces a full
 * scan). FTS5 gives indexed substring/prefix search on title/slug-scale text.
 * Postgres uses ilike + pg_trgm GIN indexes instead (see ensureResourceIndexes).
 */

function ftsTableName(table: any): string {
  return `${getTableName(table)}_fts`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Creates the FTS5 sidecar table + sync triggers + backfills existing rows.
 * Idempotent; safe to call on every resource registration.
 * No-op on Postgres (relies on pg_trgm instead) and when searchCols is empty.
 */
export function ensureSQLiteFts(
  db: any,
  table: any,
  searchCols: string[],
): void {
  if (!db || searchCols.length === 0) return;
  // SQLite only: Postgres has execute() but no $client.run.
  const client = (db as any).$client;
  const runRaw = (db as any).run;
  if (!client?.run && !runRaw) return;
  const run = (stmt: string) => {
    if (client?.run) client.run(stmt);
    else runRaw(stmt);
  };
  try {
    const tableName = getTableName(table);
    const columns = getTableColumns(table);
    const colNameOf = (f: string): string | undefined => {
      if ((columns as any)[f]) return (columns as any)[f].name ?? f;
      for (const col of Object.values(columns) as any[]) {
        if (col.name === f) return col.name;
      }
      return undefined;
    };
    // Resolve to DB column names, drop unknowns.
    const dbCols = searchCols.map(colNameOf).filter((c): c is string => !!c);
    if (dbCols.length === 0) return;
    const idCol =
      colNameOf("id") ??
      (Object.values(columns) as any[]).find((c) => c.primary)?.name ??
      "id";
    const fts = ftsTableName(table);
    const ftsCols = [
      `"id" UNINDEXED`,
      ...dbCols.map((c) => quoteIdent(c)),
    ].join(", ");
    run(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdent(fts)} USING fts5(${ftsCols}, tokenize='porter');`,
    );
    const colList = dbCols.map(quoteIdent).join(", ");
    const newVals = dbCols.map((c) => `new.${quoteIdent(c)}`).join(", ");
    run(
      `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${fts}_ai`)} AFTER INSERT ON ${quoteIdent(tableName)} BEGIN INSERT INTO ${quoteIdent(fts)}("id", ${colList}) VALUES (new.${quoteIdent(idCol)}, ${newVals}); END;`,
    );
    run(
      `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${fts}_ad`)} AFTER DELETE ON ${quoteIdent(tableName)} BEGIN DELETE FROM ${quoteIdent(fts)} WHERE "id" = old.${quoteIdent(idCol)}; END;`,
    );
    run(
      `CREATE TRIGGER IF NOT EXISTS ${quoteIdent(`${fts}_au`)} AFTER UPDATE ON ${quoteIdent(tableName)} BEGIN DELETE FROM ${quoteIdent(fts)} WHERE "id" = old.${quoteIdent(idCol)}; INSERT INTO ${quoteIdent(fts)}("id", ${colList}) VALUES (new.${quoteIdent(idCol)}, ${newVals}); END;`,
    );
    // Backfill rows predating the FTS table (dedupe via NOT IN).
    run(
      `INSERT INTO ${quoteIdent(fts)}("id", ${colList}) SELECT ${quoteIdent(idCol)}, ${colList} FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(idCol)} NOT IN (SELECT "id" FROM ${quoteIdent(fts)});`,
    );
  } catch {
    // best-effort: LIKE fallback in the list path covers FTS absence.
  }
}

/**
 * Builds an FTS5 MATCH condition for a resource search term.
 * Returns null when the term has no usable tokens or FTS errors.
 * Caller falls back to LIKE in that case.
 */
export function buildFtsMatchQuery(search: string): string | null {
  const terms = search
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (terms.length === 0) return null;
  const escaped = terms
    .map((term) => {
      const clean = term.replace(/"/g, "").trim();
      if (!clean) return null;
      return `"${clean.replace(/"/g, '""')}"*`;
    })
    .filter((x): x is string => !!x);
  if (escaped.length === 0) return null;
  return escaped.join(" AND ");
}

/**
 * The schema drizzle-kit reads: the tables, plus the Postgres enums their
 * columns use (drizzle-kit only creates enums it is handed).
 *
 * @param tables - Drizzle tables, all of one engine.
 * @returns A record to pass to drizzle-kit's API (`pushSchema`, `generateDrizzleJson`).
 */
export function drizzleSchema(
  tables: readonly Table[],
): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  for (const table of tables) {
    schema[`table:${getTableName(table)}`] = table;
    for (const column of Object.values(getTableColumns(table)) as any[])
      if (isPgEnum(column.enum))
        schema[`enum:${column.enum.enumName}`] = column.enum;
  }
  return schema;
}

/** drizzle-kit's programmatic API, an optional peer dependency. */
async function loadDrizzleKit(): Promise<typeof import("drizzle-kit/api")> {
  // A variable specifier keeps `brick build` from bundling drizzle-kit (and
  // every driver it can load) into the app server.
  const specifier = "drizzle-kit/api";
  try {
    return await import(specifier);
  } catch (err: any) {
    throw new Error(
      `[Brick-TS DB] Postgres schema tools need drizzle-kit: run \`bun add -d drizzle-kit\`, or use \`brick db push\`. (${err?.message ?? err})`,
    );
  }
}

/**
 * Create the declared tables that do not exist yet. A development and test
 * helper: never called by services, resources or server startup, and never
 * changes a table that exists. Use `brick db generate` / `brick db migrate`
 * for production schema changes.
 *
 * SQLite: `CREATE TABLE IF NOT EXISTS` per table, synchronously.
 * Postgres: drizzle-kit (an optional peer dependency) writes the DDL for the
 * missing tables, their enums, indexes and foreign keys, applied in one
 * transaction. Returns a promise to await.
 */
export function syncSchema(
  tablesOrService: Map<string, any> | any[] | Record<string, any> | Service,
  dbInstance?: any,
): Promise<void> | void {
  let db = dbInstance;
  let tables: any[] = [];

  if (
    tablesOrService &&
    typeof (tablesOrService as any).listActions === "function" &&
    (tablesOrService as any).tables
  ) {
    const service = tablesOrService as Service;
    tables = Array.from(service.tables.values());
    if (!db) {
      db = service.getDb();
    }
  } else if (tablesOrService instanceof Map) {
    tables = Array.from(tablesOrService.values());
  } else if (Array.isArray(tablesOrService)) {
    tables = tablesOrService;
  } else if (tablesOrService && typeof tablesOrService === "object") {
    tables = Object.values(tablesOrService);
  }

  if (!db || tables.length === 0) return;

  // Bun SQLite
  if ((db as any).$client?.run || (db as any).run) {
    for (const table of tables) {
      try {
        const ddl = generateSQLiteTableDdl(table);
        if ((db as any).$client?.run) {
          (db as any).$client.run(ddl);
        } else if ((db as any).run) {
          (db as any).run(sql.raw(ddl));
        }
      } catch (err: any) {
        console.warn(`[Brick-TS DB] Failed to create table:`, err.message);
      }
    }
    return;
  }

  return createMissingPostgresTables(db, tables);
}

async function createMissingPostgresTables(
  db: any,
  tables: Table[],
): Promise<void> {
  const kit = await loadDrizzleKit();
  const rows: { schema: string; name: string }[] = await db.execute(
    sql`select table_schema as schema, table_name as name from information_schema.tables`,
  );
  const present = new Set(rows.map((row) => `${row.schema}.${row.name}`));
  const existing = tables.filter((table) => {
    const { schema = "public", name } = getTableConfig(table as any);
    return present.has(`${schema}.${name}`);
  });
  if (existing.length === tables.length) return;
  // Diff the tables that exist against all of them: only the missing tables
  // (and what only they use) come out, as CREATE statements.
  const statements = await kit.generateMigration(
    kit.generateDrizzleJson(drizzleSchema(existing)),
    kit.generateDrizzleJson(drizzleSchema(tables)),
  );
  await db.transaction(async (tx: any) => {
    for (const statement of statements) await tx.execute(sql.raw(statement));
  });
}
