import {
  integer as sqliteInteger,
  real as sqliteReal,
  sqliteTable,
  text as sqliteText,
  type SQLiteColumnBuilderBase,
} from "drizzle-orm/sqlite-core";
import {
  boolean as pgBoolean,
  doublePrecision,
  integer as pgInteger,
  jsonb,
  pgTable,
  text as pgText,
  timestamp as pgTimestamp,
} from "drizzle-orm/pg-core";

const OWNER = Symbol.for("brickkit.plugin.owner");
/** Mark a table as owned by a plugin. */
export function setPluginOwner(table: object, plugin: string): void {
  Object.defineProperty(table, OWNER, { value: plugin });
}
/** The plugin that owns a table, for tables a `definePlugin` contributed. */
export function pluginOwner(table: unknown): string | undefined {
  return table && typeof table === "object"
    ? (table as Record<symbol, string | undefined>)[OWNER]
    : undefined;
}

const sqliteBuilders = {
  /** A table. Its name gets the plugin's prefix (`page_comments`). */
  table: <C extends Record<string, SQLiteColumnBuilderBase>>(
    name: string,
    columns: C,
  ) => sqliteTable(name, columns),
  text: (name: string) => sqliteText(name),
  integer: (name: string) => sqliteInteger(name, { mode: "number" }),
  real: (name: string) => sqliteReal(name),
  boolean: (name: string) => sqliteInteger(name, { mode: "boolean" }),
  /** A `Date`, stored as epoch milliseconds or `timestamptz`. */
  timestamp: (name: string) => sqliteInteger(name, { mode: "timestamp_ms" }),
  json: (name: string) => sqliteText(name, { mode: "json" }),
};

/**
 * Engine-neutral column builders for `tables`. Brick passes the SQLite or
 * Postgres ones to match the host database; the types follow SQLite's, and the
 * JavaScript values are the same on both (a `Date` for `timestamp`).
 */
export type PluginTableBuilders = typeof sqliteBuilders & {
  /** The host database's engine. */
  readonly engine: "sqlite" | "postgres";
};

export function builders(
  engine: "sqlite" | "postgres",
  tableName: (name: string) => string,
): PluginTableBuilders {
  if (engine === "postgres")
    return {
      engine,
      table: (name, columns) =>
        pgTable(tableName(name), columns as never) as never,
      text: (name) => pgText(name) as never,
      integer: (name) => pgInteger(name) as never,
      real: (name) => doublePrecision(name) as never,
      boolean: (name) => pgBoolean(name) as never,
      timestamp: (name) =>
        pgTimestamp(name, { mode: "date", withTimezone: true }) as never,
      json: (name) => jsonb(name) as never,
    };
  return {
    ...sqliteBuilders,
    engine,
    table: (name, columns) => sqliteTable(tableName(name), columns),
  };
}
