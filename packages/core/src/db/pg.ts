// Postgres schema builders from drizzle-orm/pg-core. drizzle-orm is a peer
// dependency, so the app and Brick share one copy and tables from either
// `@brickkit/core/pg` or `drizzle-orm/pg-core` work.
//
// This entry is deliberately separate from the package root: several builder
// names (`text`, `integer`, `index`, …) exist in both `sqlite-core` and
// `pg-core` with different implementations, so they cannot share one barrel.

export {
  pgTable,
  pgEnum,
  pgSchema,
  pgView,
  boolean,
  timestamp,
  date,
  time,
  text,
  varchar,
  char,
  uuid,
  integer,
  bigint,
  smallint,
  serial,
  bigserial,
  real,
  doublePrecision,
  numeric,
  decimal,
  json,
  jsonb,
  interval,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/pg-core";

export { relations, sql } from "drizzle-orm";

export type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

/** Typed Postgres Drizzle instance, as held by `defineDatabase({engine})`. */
export type PgDatabase<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> = PostgresJsDatabase<TSchema>;
