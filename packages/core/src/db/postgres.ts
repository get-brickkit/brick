import postgres, { type Sql } from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

export interface PostgresDatabaseConfig<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Existing postgres-js client. Connection options are ignored; the caller owns its lifecycle. */
  client?: Sql;
  /** Database connection URL (e.g. postgresql://user:pass@host:5432/dbname) */
  url?: string;
  /** Connection string alias */
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean | "require" | "allow" | "prefer" | "verify-full";
  max?: number;
  /**
   * Disable prepared statements (required for transaction-mode poolers such
   * as Supabase's Supavisor on :6543, which cannot hold named prepared
   * statements across transactions).
   */
  prepare?: boolean;
  /** Optional Drizzle schema for relational queries */
  schema?: TSchema;
  /** Custom schema name for Encore-style isolated schemas */
  schemaName?: string;
}

export type PostgresDatabase<
  _TSchema extends Record<string, unknown> = Record<string, unknown>,
> = any;

/**
 * Creates a PostgreSQL Drizzle instance using postgres-js.
 * Static imports so bundlers (Nitro/Rollup) trace and ship the driver.
 * `bun:sqlite` stays lazy in `sqlite.ts` since it only exists under Bun.
 */
export function createPostgresDatabase<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
>(config: PostgresDatabaseConfig<TSchema> = {}): PostgresDatabase<TSchema> {
  const connectionUrl =
    config.url ??
    config.connectionString ??
    (typeof process !== "undefined" ? process.env?.DATABASE_URL : undefined);

  const client =
    config.client ??
    (connectionUrl
      ? postgres(connectionUrl, {
          max: config.max,
          prepare: config.prepare,
          ssl: config.ssl,
        })
      : postgres({
          host: config.host ?? "localhost",
          port: config.port ?? 5432,
          user: config.user,
          password: config.password,
          database: config.database,
          max: config.max,
          prepare: config.prepare,
          ssl: config.ssl,
        }));

  return drizzle(client, {
    schema: config.schema,
    ...(config.schemaName ? { schemaFilter: [config.schemaName] } : {}),
  });
}
