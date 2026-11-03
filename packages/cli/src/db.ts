import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  drizzleSchema,
  getTableName,
  migrateDatabase,
  sql,
  type BrickApp,
  type DatabaseHandle,
  type Table,
} from "@brickkit/core";

/** A database the app's services use, with every table Brick knows on it. */
export interface AppDatabase {
  /** `defineDatabase({ name })`, else the first service that uses it. */
  name: string;
  database: DatabaseHandle<unknown>;
  tables: Table[];
}

/**
 * The app's databases and their tables: those passed to `defineDatabase`
 * (outbox tables included), resource tables, and the tables plugins own.
 */
export function appDatabases(app: BrickApp): AppDatabase[] {
  const found = new Map<
    DatabaseHandle<unknown>,
    { name: string; tables: Map<string, Table> }
  >();
  for (const service of app.definition.services) {
    const database = service.getDatabaseHandle?.();
    if (!database) continue;
    let entry = found.get(database);
    if (!entry) {
      entry = { name: database.name ?? service.name, tables: new Map() };
      found.set(database, entry);
    }
    for (const table of [
      ...Object.values(database.tables),
      ...service.tables.values(),
    ])
      entry.tables.set(getTableName(table), table);
  }
  return [...found]
    .filter(([, entry]) => entry.tables.size > 0)
    .map(([database, entry]) => ({
      name: entry.name,
      database,
      tables: [...entry.tables.values()],
    }));
}

export interface DbCommandOptions {
  /** Migrations folder; one subfolder per database when there are several. */
  out: string;
  /** `generate`: the migration's name. */
  name?: string;
  /** `push`: apply changes that drop data. */
  force?: boolean;
  log?: (line: string) => void;
}

/** Run `brick db generate|migrate|push` against every database of the app. */
export async function runDbCommand(
  command: "generate" | "migrate" | "push",
  app: BrickApp,
  options: DbCommandOptions,
): Promise<void> {
  const log = options.log ?? console.log;
  const databases = appDatabases(app);
  if (!databases.length)
    throw new Error("Brick: the app has no database with tables.");
  try {
    for (const entry of databases) {
      const folder =
        databases.length > 1 ? join(options.out, entry.name) : options.out;
      const label = `${entry.name} (${entry.database.engine})`;
      if (command === "generate") {
        const file = await generate(entry, folder, options.name);
        log(file ? `${label}: wrote ${file}` : `${label}: no schema changes`);
      } else if (command === "migrate") {
        if (!existsSync(join(folder, "meta", "_journal.json")))
          throw new Error(
            `Brick: no migrations in ${folder}; run \`brick db generate\` first.`,
          );
        await migrateDatabase(entry.database, folder);
        log(`${label}: migrations in ${folder} applied`);
      } else {
        const applied = await push(entry, options.force ?? false, log);
        log(
          applied
            ? `${label}: applied ${applied} change${applied === 1 ? "" : "s"}`
            : `${label}: no schema changes`,
        );
      }
    }
  } finally {
    await Promise.all(databases.map((entry) => entry.database.close?.()));
  }
}

const kit = () => import("drizzle-kit/api");

type Snapshot = { id: string; version: string };
type Journal = {
  version: string;
  dialect: string;
  entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[];
};

/**
 * Diff the tables against the folder's last snapshot with drizzle-kit and write
 * the SQL, snapshot and journal in drizzle-kit's layout, so drizzle-kit and
 * Drizzle's migrator read the folder too. Returns the SQL file, if any.
 */
async function generate(
  entry: AppDatabase,
  folder: string,
  name = "migration",
): Promise<string | undefined> {
  const { generateDrizzleJson, generateMigration, ...sqlite } = await kit();
  const postgres = entry.database.engine === "postgres";
  const meta = join(folder, "meta");
  const journalFile = join(meta, "_journal.json");
  const journal: Journal = existsSync(journalFile)
    ? JSON.parse(readFileSync(journalFile, "utf8"))
    : {
        version: "7",
        dialect: postgres ? "postgresql" : "sqlite",
        entries: [],
      };
  const last = journal.entries.at(-1);
  const idx = last ? last.idx + 1 : 0;
  const prev: Snapshot | undefined = last
    ? JSON.parse(
        readFileSync(
          join(meta, `${last.tag.slice(0, 4)}_snapshot.json`),
          "utf8",
        ),
      )
    : undefined;
  const schema = drizzleSchema(entry.tables);
  let cur: Snapshot;
  let statements: string[];
  if (postgres) {
    const next = generateDrizzleJson(schema, prev?.id);
    statements = await generateMigration(
      (prev as never) ?? generateDrizzleJson({}),
      next,
    );
    cur = next;
  } else {
    const next = await sqlite.generateSQLiteDrizzleJson(schema, prev?.id);
    statements = await sqlite.generateSQLiteMigration(
      (prev as never) ?? (await sqlite.generateSQLiteDrizzleJson({})),
      next,
    );
    cur = next;
  }
  if (!statements.length) return undefined;
  const prefix = String(idx).padStart(4, "0");
  const tag = `${prefix}_${name}`;
  mkdirSync(meta, { recursive: true });
  const file = join(folder, `${tag}.sql`);
  writeFileSync(file, statements.join("\n--> statement-breakpoint\n"));
  writeFileSync(
    join(meta, `${prefix}_snapshot.json`),
    JSON.stringify(cur, null, 2),
  );
  journal.entries.push({
    idx,
    version: cur.version,
    when: Date.now(),
    tag,
    breakpoints: true,
  });
  writeFileSync(journalFile, JSON.stringify(journal, null, 2));
  return file;
}

/**
 * Make the database match the tables with drizzle-kit's push, touching only
 * the tables Brick knows. Returns how many statements ran.
 */
async function push(
  entry: AppDatabase,
  force: boolean,
  log: (line: string) => void,
): Promise<number> {
  const { pushSchema, pushSQLiteSchema } = await kit();
  const db = entry.database.getDb() as any;
  const names = new Set(entry.tables.map((table) => getTableName(table)));
  const schema = drizzleSchema(entry.tables);
  const postgres = entry.database.engine === "postgres";
  const result = postgres
    ? await pushSchema(
        schema,
        // drizzle-kit reads `rows` (node-postgres); postgres-js returns the rows.
        {
          execute: async (query: never) => ({ rows: await db.execute(query) }),
        } as never,
        [
          ...new Set(
            entry.tables.map(
              // What drizzle's getTableConfig(table).schema reads.
              (table) =>
                ((table as never)[Symbol.for("drizzle:Schema")] as
                  | string
                  | undefined) ?? "public",
            ),
          ),
        ],
        [...names],
      )
    : await pushSQLiteSchema(schema, onlyTables(db, names) as never);
  const statements = result.statementsToExecute;
  if (!statements.length) return 0;
  for (const warning of result.warnings) log(warning);
  if (result.hasDataLoss && !force)
    throw new Error(
      `Brick: pushing ${entry.name} would lose data (see above). Rerun with --force to apply it, or use \`brick db generate\` and edit the migration.`,
    );
  if (postgres)
    await db.transaction(async (tx: any) => {
      for (const statement of statements) await tx.execute(sql.raw(statement));
    });
  else await result.apply();
  return statements.length;
}

/**
 * drizzle-kit's SQLite push has no table filter: hide the tables Brick does not
 * know (FTS sidecars, other apps' tables) from what it reads, so it neither
 * drops them nor asks whether a new table renames one.
 */
function onlyTables(db: any, names: Set<string>) {
  return {
    all: (query: unknown) =>
      db.all(query).filter((row: Record<string, unknown>) => {
        const table =
          row.tableName ?? row.tableFrom ?? row.tbl_name ?? row.view_name;
        return table === undefined || names.has(table as string);
      }),
    run: (query: unknown) => db.run(query),
  };
}
