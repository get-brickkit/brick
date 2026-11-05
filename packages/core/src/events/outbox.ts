import {
  bigserial,
  index as pgIndex,
  integer as pgInteger,
  jsonb,
  pgTable,
  text as pgText,
  timestamp,
} from "drizzle-orm/pg-core";
import {
  index as sqliteIndex,
  integer as sqliteInteger,
  sqliteTable,
  text as sqliteText,
} from "drizzle-orm/sqlite-core";
import { deliveryId } from "./id";
import type { EventDelivery, EventEnvelope } from "./types";

const OUTBOX = Symbol.for("brick.outbox");

export const OUTBOX_STATUSES = [
  "pending",
  "claimed",
  "delivered",
  "dead",
] as const;
/** What the outbox rows are in, by state. */
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

function sqliteOutbox(name: string) {
  const timestampMs = (column: string) =>
    sqliteInteger(column, { mode: "timestamp_ms" });
  return sqliteTable(
    name,
    {
      seq: sqliteInteger("seq").primaryKey({ autoIncrement: true }),
      id: sqliteText("id").notNull().unique(),
      eventId: sqliteText("event_id").notNull(),
      listener: sqliteText("listener").notNull(),
      name: sqliteText("name").notNull(),
      payload: sqliteText("payload", { mode: "json" }).notNull(),
      traceId: sqliteText("trace_id"),
      source: sqliteText("source"),
      occurredAt: timestampMs("occurred_at").notNull(),
      status: sqliteText("status").$type<OutboxStatus>().notNull(),
      attempts: sqliteInteger("attempts").notNull().default(0),
      lastError: sqliteText("last_error"),
      availableAt: timestampMs("available_at").notNull(),
      claimedAt: timestampMs("claimed_at"),
      deliveredAt: timestampMs("delivered_at"),
    },
    (table) => [
      sqliteIndex(`${name}_due`).on(table.status, table.availableAt),
      sqliteIndex(`${name}_event`).on(table.eventId),
    ],
  );
}

function postgresOutbox(name: string) {
  const at = (column: string) => timestamp(column, { withTimezone: true });
  return pgTable(
    name,
    {
      seq: bigserial("seq", { mode: "number" }).primaryKey(),
      id: pgText("id").notNull().unique(),
      eventId: pgText("event_id").notNull(),
      listener: pgText("listener").notNull(),
      name: pgText("name").notNull(),
      payload: jsonb("payload").notNull(),
      traceId: pgText("trace_id"),
      source: pgText("source"),
      occurredAt: at("occurred_at").notNull(),
      status: pgText("status").$type<OutboxStatus>().notNull(),
      attempts: pgInteger("attempts").notNull().default(0),
      lastError: pgText("last_error"),
      availableAt: at("available_at").notNull(),
      claimedAt: at("claimed_at"),
      deliveredAt: at("delivered_at"),
    },
    (table) => [
      pgIndex(`${name}_due`).on(table.status, table.availableAt),
      pgIndex(`${name}_event`).on(table.eventId),
    ],
  );
}

/** The outbox table of a SQLite database. */
export type SQLiteOutboxTable = ReturnType<typeof sqliteOutbox>;
/** The outbox table of a Postgres database. */
export type PostgresOutboxTable = ReturnType<typeof postgresOutbox>;
/** An outbox table, made by `outboxTable`. */
export type OutboxTable = SQLiteOutboxTable | PostgresOutboxTable;

/**
 * The outbox table: where recorded events wait, one row per listener, until they
 * are delivered. A write and the events it causes are inserted in one transaction,
 * so an event is neither lost when the process dies after the write nor sent for a
 * write that was rolled back.
 *
 * Brick does not create tables for you. Put this in the schema of the database
 * whose writes emit events, and your migration tool (such as drizzle-kit) creates
 * it. A service whose database holds the table records events; one without it does
 * not.
 *
 * @param engine - The database engine, `"sqlite"` or `"postgres"`.
 * @param options - `name` to call the table something other than `brick_outbox`.
 * @returns A Drizzle table.
 * @example
 * import { defineDatabase, outboxTable } from "@brickkit/core";
 *
 * export const outbox = outboxTable("postgres");
 * export const database = defineDatabase({
 *   engine: "postgres",
 *   tables: { users, outbox },
 * });
 */
export function outboxTable(
  engine: "sqlite",
  options?: { name?: string },
): SQLiteOutboxTable;
export function outboxTable(
  engine: "postgres",
  options?: { name?: string },
): PostgresOutboxTable;
export function outboxTable(
  engine: "sqlite" | "postgres",
  options: { name?: string } = {},
): OutboxTable {
  const name = options.name ?? "brick_outbox";
  const table = engine === "sqlite" ? sqliteOutbox(name) : postgresOutbox(name);
  Object.defineProperty(table, OUTBOX, { value: { engine } });
  return table;
}

/**
 * Whether a value is an outbox table made by `outboxTable`.
 *
 * @param value - Anything.
 * @returns `true` for an outbox table, narrowing its type.
 */
export function isOutboxTable(value: unknown): value is OutboxTable {
  return typeof value === "object" && value !== null && OUTBOX in value;
}

/** A row of an outbox table. */
export type OutboxRow = OutboxTable["$inferSelect"];

/** The rows that record an event: one per listener, due now. */
export function outboxRows(
  event: Omit<EventEnvelope, "occurredAt"> & { occurredAt: Date },
  listeners: readonly string[],
) {
  return listeners.map((listener) => ({
    id: deliveryId(event.id, listener),
    eventId: event.id,
    listener,
    name: event.name,
    payload: event.payload,
    traceId: event.traceId ?? null,
    source: event.source ?? null,
    occurredAt: event.occurredAt,
    status: "pending" as const,
    attempts: 0,
    availableAt: event.occurredAt,
  }));
}

/** The delivery a row of `outboxRows` is. */
export function deliveryOf(row: OutboxRow): EventDelivery {
  return {
    id: row.eventId,
    name: row.name,
    payload: row.payload,
    occurredAt: row.occurredAt.toISOString(),
    ...(row.traceId ? { traceId: row.traceId } : {}),
    ...(row.source ? { source: row.source } : {}),
    listener: row.listener,
    deliveryId: row.id,
    attempt: row.attempts,
  };
}

export function outboxEngine(table: OutboxTable): "sqlite" | "postgres" {
  return (
    table as unknown as Record<symbol, { engine: "sqlite" | "postgres" }>
  )[OUTBOX].engine;
}
