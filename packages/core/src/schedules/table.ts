import {
  integer as pgInteger,
  jsonb,
  pgTable,
  text as pgText,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  integer as sqliteInteger,
  sqliteTable,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";

const SCHEDULES = Symbol.for("brick.schedules");

/** One finished run of a schedule, as the schedule table keeps it. */
export interface ScheduleRunRecord {
  /** The time the run was due, as an ISO timestamp. */
  slot: string;
  trigger: "schedule" | "manual";
  attempt: number;
  startedAt: string;
  finishedAt: string;
  /** `skipped`: a slot missed while no process ran, with `catchUp: "skip"`. */
  outcome: "succeeded" | "failed" | "skipped";
  error?: string;
}

function sqliteSchedules(name: string) {
  const at = (column: string) =>
    sqliteInteger(column, { mode: "timestamp_ms" });
  return sqliteTable(name, {
    name: sqliteText("name").primaryKey(),
    spec: sqliteText("spec").notNull(),
    slot: at("slot").notNull(),
    nextAt: at("next_at").notNull(),
    attempts: sqliteInteger("attempts").notNull().default(0),
    trigger: sqliteText("trigger")
      .$type<ScheduleRunRecord["trigger"]>()
      .notNull(),
    runId: sqliteText("run_id"),
    startedAt: at("started_at"),
    leaseUntil: at("lease_until"),
    lastSuccessAt: at("last_success_at"),
    runs: sqliteText("runs", { mode: "json" })
      .$type<ScheduleRunRecord[]>()
      .notNull(),
  });
}

function postgresSchedules(name: string) {
  const at = (column: string) => timestamp(column, { withTimezone: true });
  return pgTable(name, {
    name: pgText("name").primaryKey(),
    spec: pgText("spec").notNull(),
    slot: at("slot").notNull(),
    nextAt: at("next_at").notNull(),
    attempts: pgInteger("attempts").notNull().default(0),
    trigger: pgText("trigger").$type<ScheduleRunRecord["trigger"]>().notNull(),
    runId: pgText("run_id"),
    startedAt: at("started_at"),
    leaseUntil: at("lease_until"),
    lastSuccessAt: at("last_success_at"),
    runs: jsonb("runs").$type<ScheduleRunRecord[]>().notNull(),
  });
}

/** The schedule table of a SQLite database. */
export type SQLiteScheduleTable = ReturnType<typeof sqliteSchedules>;
/** The schedule table of a Postgres database. */
export type PostgresScheduleTable = ReturnType<typeof postgresSchedules>;
/** A schedule table, made by `scheduleTable`. */
export type ScheduleTable = SQLiteScheduleTable | PostgresScheduleTable;
export type ScheduleRow = ScheduleTable["$inferSelect"];

/**
 * The schedule table: one row per schedule, holding when it is next due, which
 * process is running it, and its last runs. Processes that share the table
 * share the schedules: each due time runs once among them, and a restart
 * picks up where the last process stopped.
 *
 * Brick does not create tables for you. Put it in the schema of one of the
 * app's databases, and your migration tool (such as drizzle-kit) creates it.
 *
 * @param engine - The database engine, `"sqlite"` or `"postgres"`.
 * @param options - `name` to call the table something other than `brick_schedules`.
 * @returns A Drizzle table.
 * @example
 * import { defineDatabase, outboxTable, scheduleTable } from "@brickkit/core";
 *
 * export const schedules = scheduleTable("postgres");
 * export const database = defineDatabase({
 *   engine: "postgres",
 *   tables: { users, schedules },
 * });
 */
export function scheduleTable(
  engine: "sqlite",
  options?: { name?: string },
): SQLiteScheduleTable;
export function scheduleTable(
  engine: "postgres",
  options?: { name?: string },
): PostgresScheduleTable;
export function scheduleTable(
  engine: "sqlite" | "postgres",
  options: { name?: string } = {},
): ScheduleTable {
  const name = options.name ?? "brick_schedules";
  const table =
    engine === "sqlite" ? sqliteSchedules(name) : postgresSchedules(name);
  Object.defineProperty(table, SCHEDULES, { value: { engine } });
  return table;
}

/** Whether a value is a table made by `scheduleTable`. */
export function isScheduleTable(value: unknown): value is ScheduleTable {
  return typeof value === "object" && value !== null && SCHEDULES in value;
}
