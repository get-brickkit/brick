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
import { sharedAcrossCoreCopies } from "./deps";
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

interface AuditOptions {
  resource?: string;
  record?: (args: { input: any; result: any }) => unknown;
}

export interface AuditStage {
  readonly service: ServicePort<any, any>;
  readonly table: AuditTable;
  readonly action: string;
  readonly recordsInOwnTransaction: boolean;
  readonly resource?: string;
  readonly record?: AuditOptions["record"];
}

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
    recordsInOwnTransaction: mode === "inline",
    resource: config.audit?.resource ?? resourceAction?.resource,
    record:
      config.audit?.record ??
      (resourceAction?.record ? ({ input }) => input.id : undefined),
  };
}

interface Call {
  readonly audit: AuditStage;
  written: boolean;
}
const calls = sharedAcrossCoreCopies(
  "brickkit.audit.calls",
  () => new AsyncLocalStorage<Call>(),
);

export function runUnaudited<T>(run: () => T): T {
  return calls.getStore() ? calls.exit(run) : run();
}

export interface Entry {
  action: string;
  resource?: string;
  recordId?: unknown;
  meta?: unknown;
}

function recordIdText(id: unknown): string | null {
  if (id === undefined || id === null) return null;
  if (typeof id === "string") return id;
  if (typeof id === "number" || typeof id === "bigint") return String(id);
  return JSON.stringify(id) ?? null;
}

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

function insertOutsideOtherRequestsTransactions<T>(
  db: any,
  fn: (handle: any) => Promise<T>,
): Promise<T> {
  return isSqliteDatabase(db) && !inTransaction(db)
    ? runInTransaction(db, fn)
    : fn(db);
}

async function writeAudit(
  handle: any,
  ctx: { traceId?: string; requestId?: string },
  target: Pick<AuditStage, "service" | "table">,
  entry: Entry,
): Promise<void> {
  await handle.insert(target.table).values(await auditRow(ctx, target, entry));
}

function resolveActorBeforeAction(ctx: ActionContext) {
  return identityOf(ctx);
}

function buildRow(audit: AuditStage, ctx: ActionContext) {
  return auditRow(ctx, audit, {
    action: audit.action,
    resource: audit.resource,
  });
}

function setRecordIdOf(
  row: Awaited<ReturnType<typeof auditRow>>,
  audit: AuditStage,
  input: unknown,
  result: unknown,
) {
  row.recordId = recordIdText(audit.record?.({ input, result }));
}

export async function runAudited(
  audit: AuditStage,
  input: unknown,
  ctx: ActionContext,
  run: () => Promise<unknown>,
): Promise<unknown> {
  await resolveActorBeforeAction(ctx);
  const call: Call = { audit, written: false };
  const result = await calls.run(call, run);
  if (!audit.recordsInOwnTransaction && !call.written) {
    let row: Awaited<ReturnType<typeof auditRow>> | undefined;
    try {
      row = await buildRow(audit, ctx);
      setRecordIdOf(row, audit, input, result);
      await insertOutsideOtherRequestsTransactions(ctx.db, (tx) =>
        tx.insert(audit.table).values(row),
      );
    } catch (error) {
      ctx.logger?.error?.(
        `audit: '${audit.action}' ran but its audit row was not written`,
        row,
        error,
      );
    }
  }
  return result;
}

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

export function inlineAudit(): AuditStage | undefined {
  const audit = calls.getStore()?.audit;
  return audit?.recordsInOwnTransaction ? audit : undefined;
}

export function recordInline(
  audit: AuditStage,
  tx: unknown,
  ctx: ActionContext,
  entry: Entry,
): Promise<void> {
  return writeAudit(tx, ctx, audit, entry);
}

function commitsWithBrickTransaction(tx: unknown, ctx: ActionContext) {
  return tx === ctx.db || inTransaction(tx);
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
    await insertOutsideOtherRequestsTransactions(ctx.db, (tx) =>
      writeAudit(tx, ctx, target, named),
    );
  else {
    await writeAudit(options.tx, ctx, target, named);
    if (call && commitsWithBrickTransaction(options.tx, ctx))
      await onTransactionCommit(options.tx, () => (call.written = true));
  }
}
