import { AsyncLocalStorage } from "node:async_hooks";
import {
  bigserial,
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
import { actionMeta } from "./action-meta";
import { serviceOf } from "./context";
import {
  inTransaction,
  isSqliteDatabase,
  onTransactionCommit,
  runInTransaction,
} from "./events/transaction";
import { identityOf } from "./identity";
import { actionMethod } from "./routes";
import { portOf, type ServicePort } from "./service-port";
import type { Action, ActionContext } from "./types";

const AUDIT = Symbol.for("brick.audit");

function sqliteAudit(name: string) {
  return sqliteTable(name, {
    seq: sqliteInteger("seq").primaryKey({ autoIncrement: true }),
    id: sqliteText("id").notNull().unique(),
    at: sqliteInteger("at", { mode: "timestamp_ms" }).notNull(),
    service: sqliteText("service").notNull(),
    action: sqliteText("action").notNull(),
    resource: sqliteText("resource"),
    recordId: sqliteText("record_id"),
    actorId: sqliteText("actor_id"),
    actorLabel: sqliteText("actor_label"),
    tenant: sqliteText("tenant"),
    traceId: sqliteText("trace_id"),
    requestId: sqliteText("request_id"),
    meta: sqliteText("meta", { mode: "json" }),
  });
}

function postgresAudit(name: string) {
  return pgTable(name, {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    id: pgText("id").notNull().unique(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    service: pgText("service").notNull(),
    action: pgText("action").notNull(),
    resource: pgText("resource"),
    recordId: pgText("record_id"),
    actorId: pgText("actor_id"),
    actorLabel: pgText("actor_label"),
    tenant: pgText("tenant"),
    traceId: pgText("trace_id"),
    requestId: pgText("request_id"),
    meta: jsonb("meta"),
  });
}

/** The audit table of a SQLite database. */
export type SQLiteAuditTable = ReturnType<typeof sqliteAudit>;
/** The audit table of a Postgres database. */
export type PostgresAuditTable = ReturnType<typeof postgresAudit>;
/** An audit table, made by `auditTable`. */
export type AuditTable = SQLiteAuditTable | PostgresAuditTable;

/**
 * The audit table: one row per change, saying who made it, what ran and on
 * which record. A service whose database holds it records every create, update
 * and delete, every command, and every other action that is not a `GET`.
 * Brick only ever inserts into it; the docs give the trigger that makes the
 * database refuse anything else.
 *
 * Brick does not create tables for you. Put this in the schema of the database
 * and your migration tool (such as drizzle-kit) creates it. The service must
 * declare an `identity` hook: that is where the actor comes from.
 *
 * @param engine - The database engine, `"sqlite"` or `"postgres"`.
 * @param options - `name` to call the table something other than `brick_audit`.
 * @returns A Drizzle table, which you can also read with a resource of your own.
 * @example
 * import { auditTable, defineDatabase } from "@brickkit/core";
 *
 * export const auditLog = auditTable("postgres");
 * export const database = defineDatabase({
 *   engine: "postgres",
 *   tables: { orders, auditLog },
 * });
 */
export function auditTable(
  engine: "sqlite",
  options?: { name?: string },
): SQLiteAuditTable;
export function auditTable(
  engine: "postgres",
  options?: { name?: string },
): PostgresAuditTable;
export function auditTable(
  engine: "sqlite" | "postgres",
  options: { name?: string } = {},
): AuditTable {
  const name = options.name ?? "brick_audit";
  const table = engine === "sqlite" ? sqliteAudit(name) : postgresAudit(name);
  Object.defineProperty(table, AUDIT, { value: { engine } });
  return table;
}

/** Whether a value is an audit table made by `auditTable`. */
export function isAuditTable(value: unknown): value is AuditTable {
  return typeof value === "object" && value !== null && AUDIT in value;
}

/** What an action's `audit` option says; see `AuditConfig`. */
interface AuditOptions {
  resource?: string;
  record?: (args: { input: any; result: any }) => unknown;
}

/** How one action is recorded, worked out once the service has its audit table. */
export interface AuditStage {
  readonly service: ServicePort<any, any>;
  readonly table: AuditTable;
  readonly action: string;
  /** The write records itself in its own transaction (a CRUD write, a command); else Brick records it after the action succeeds. */
  readonly inline: boolean;
  readonly resource?: string;
  readonly record?: AuditOptions["record"];
}

/**
 * How a call to the action is recorded, or `undefined` when it is not: the
 * service has no audit table, the action says `audit: false` or reads
 * (`GET`, or a plugin that never writes).
 */
export function auditStage(
  service: ServicePort<any, any>,
  action: Action<any, any, any, any>,
): AuditStage | undefined {
  const table = service.getAuditTable();
  const config = action.config as { audit?: false | AuditOptions };
  if (!table || config.audit === false) return undefined;
  const { audit: mode, resourceAction } = actionMeta(action);
  if (mode === "none" || (!mode && actionMethod(action) === "GET"))
    return undefined;
  return {
    service,
    table,
    action: action.name,
    inline: mode === "inline",
    resource: config.audit?.resource ?? resourceAction?.resource,
    record:
      config.audit?.record ??
      (resourceAction?.record ? ({ input }) => input.id : undefined),
  };
}

interface Call {
  readonly audit: AuditStage;
  /** The action recorded itself with `recordAudit(…, { tx })` and `tx` committed, so Brick does not. */
  written: boolean;
}
/** The audited call being run. Global so a second core copy finds it. */
const calls = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("brickkit.audit.calls")
] ??= new AsyncLocalStorage<Call>()) as AsyncLocalStorage<Call>;

/** What a row says about one change; the actor, trace and time are added. */
export interface Entry {
  action: string;
  resource?: string;
  recordId?: unknown;
  meta?: unknown;
}

/** A record id as text: a string or number as itself, anything else (a composite key) as JSON. */
function recordIdText(id: unknown): string | null {
  if (id === undefined || id === null) return null;
  if (typeof id === "string") return id;
  if (typeof id === "number" || typeof id === "bigint") return String(id);
  return JSON.stringify(id) ?? null;
}

/** The row of one change: the entry, the actor and the trace. */
async function auditRow(
  ctx: { traceId?: string; requestId?: string },
  target: Pick<AuditStage, "service">,
  entry: Entry,
) {
  const who = await identityOf(ctx);
  return {
    id: crypto.randomUUID(),
    at: new Date(),
    service: target.service.name,
    action: entry.action,
    resource: entry.resource ?? null,
    recordId: recordIdText(entry.recordId),
    actorId: who?.id ?? null,
    actorLabel: who?.label ?? null,
    tenant: who?.tenant ?? null,
    traceId: ctx.traceId ?? null,
    requestId: ctx.requestId ?? null,
    meta: entry.meta ?? null,
  };
}

/**
 * Runs an insert so another request's rollback cannot take it. Only SQLite needs a
 * transaction opened for that: its one connection would put the row in whatever
 * transaction is open. Inside the caller's own transaction the row joins it.
 */
function own<T>(db: any, fn: (handle: any) => Promise<T>): Promise<T> {
  return isSqliteDatabase(db) && !inTransaction(db)
    ? runInTransaction(db, fn)
    : fn(db);
}

/** Inserts a row through `handle`: a transaction, or the database. */
async function writeAudit(
  handle: any,
  ctx: { traceId?: string; requestId?: string },
  target: Pick<AuditStage, "service" | "table">,
  entry: Entry,
): Promise<void> {
  await handle.insert(target.table).values(await auditRow(ctx, target, entry));
}

/**
 * Runs one audited call of an action: the actor is resolved before it runs, so
 * a write can record itself in its transaction without waiting on the
 * `identity` hook; a plain action is recorded after it succeeded, in a statement
 * of its own, unless it recorded itself with `recordAudit(…, { tx })`.
 */
export async function runAudited(
  audit: AuditStage,
  input: unknown,
  ctx: ActionContext,
  run: () => Promise<unknown>,
): Promise<unknown> {
  await identityOf(ctx);
  const call: Call = { audit, written: false };
  const result = await calls.run(call, run);
  if (!audit.inline && !call.written) {
    let row: Awaited<ReturnType<typeof auditRow>> | undefined;
    try {
      // The row first, so a `record` that throws still leaves the rest of it for the log.
      row = await auditRow(ctx, audit, {
        action: audit.action,
        resource: audit.resource,
      });
      row.recordId = recordIdText(audit.record?.({ input, result }));
      await own(ctx.db, (tx) => tx.insert(audit.table).values(row));
    } catch (error) {
      // The action's effects are done: keep its result, and log the whole row so it can be rebuilt.
      ctx.logger?.error?.(
        `audit: '${audit.action}' ran but its audit row was not written`,
        row,
        error,
      );
    }
  }
  return result;
}

/** The row of a call of `audit`'s action, from its input and result. */
export function entryOf(
  audit: AuditStage,
  input: unknown,
  result: unknown,
): Entry {
  return {
    action: audit.action,
    resource: audit.resource,
    recordId: audit.record?.({ input, result }),
  };
}

/** The audit of the current call when its write records itself, as a CRUD write or a command does. */
export function inlineAudit(): AuditStage | undefined {
  const audit = calls.getStore()?.audit;
  return audit?.inline ? audit : undefined;
}

/** Inserts the row of a write through its own transaction `tx`. */
export function recordInline(
  audit: AuditStage,
  tx: unknown,
  ctx: ActionContext,
  entry: Entry,
): Promise<void> {
  return writeAudit(tx, ctx, audit, entry);
}

/**
 * Record a change of your own from an action: for what Brick cannot see, or to
 * add `meta`. By default the row is inserted at once. Pass the `tx` of a
 * transaction you have open to commit it with your writes instead; once `tx`
 * commits it is the record of this call, and Brick does not add the automatic row.
 *
 * Brick copies no input or output into the log: `meta` holds what you pass.
 *
 * @param ctx - The action context: it names the service and the actor.
 * @param entry - `action` defaults to the running action's name, and is needed
 * in an action that is not itself recorded (a `GET`, `audit: false`).
 * `resource` and `recordId` say which record; `meta` is JSON of your choosing.
 * @param options - `tx`: an open transaction on the service's database.
 * @throws When `ctx` is not from an action of a service whose database holds an
 * audit table (a listener, a schedule or a workflow step has no such context),
 * or when `action` is missing.
 * @example
 * await runInTransaction(ctx.db, async (tx) => {
 *   await tx.update(orders).set({ status: "refunded" }).where(eq(orders.id, input.orderId));
 *   await recordAudit(ctx, { resource: "order", recordId: input.orderId, meta: { reason: input.reason } }, { tx });
 * });
 */
export async function recordAudit(
  ctx: ActionContext,
  entry: {
    action?: string;
    resource?: string;
    recordId?: string | number;
    meta?: unknown;
  },
  options: { tx?: unknown } = {},
): Promise<void> {
  const service = serviceOf(ctx);
  const table = service && portOf(service).getAuditTable();
  if (!service || !table)
    throw new Error(
      "recordAudit needs the ctx of an action of a service whose database holds an audit table",
    );
  const call = calls.getStore();
  const action = entry.action ?? call?.audit.action;
  if (!action)
    throw new Error(
      "recordAudit needs an action: it defaults to the running action only when that action is recorded",
    );
  const target = { service: portOf(service), table };
  const named = { ...entry, action };
  if (options.tx === undefined)
    await own(ctx.db, (tx) => writeAudit(tx, ctx, target, named));
  else {
    await writeAudit(options.tx, ctx, target, named);
    // Only a commit makes it the call's record: a rolled-back `tx` leaves the automatic row to Brick.
    // A transaction Brick did not open (Drizzle's own) never reports its commit, so it cannot stand in for the automatic row.
    if (call && (options.tx === ctx.db || inTransaction(options.tx)))
      await onTransactionCommit(options.tx, () => (call.written = true));
  }
}
