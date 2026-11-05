import {
  ActionExecutionError,
  deny,
  getHostHooks,
  runInTransaction,
  onTransactionCommit,
  type EventRecorder,
  type ResourcePluginContext,
} from "@brickkit/core";
import {
  type Column,
  type SQL,
  and,
  or,
  eq,
  gt,
  lt,
  asc,
  desc,
  sql,
  Param,
} from "drizzle-orm";

import {
  databaseValue,
  decodeCursor,
  encodeCursor,
  errors,
  invalid,
  jsonValue,
} from "./codec";
import { statements } from "./statement";
import type {
  BulkOperation,
  CrudAuthorizeArgs,
  CrudOptions,
  Fields,
  Operation,
} from "./types";
import { condition } from "./where";

// Each bulk operation runs its single-row operation once per item.
export const bulkOperations: Record<
  BulkOperation,
  "create" | "update" | "delete"
> = {
  bulkCreate: "create",
  bulkUpdate: "update",
  bulkDelete: "delete",
};
type Hooks = NonNullable<CrudOptions<any, any>["hooks"]>;
// The hooks that make a write open its own transaction.
const writeHooks = {
  create: ["beforeCreate", "afterCreate"],
  update: ["beforeUpdate", "afterUpdate"],
  delete: ["beforeDelete", "afterDelete"],
} as const;

type Hook = (args: any) => unknown;
/** The crud() hooks, then those of plugins installed on the resource, then on the service. */
function withHostHooks(
  hooks: CrudOptions<any, any>["hooks"],
  resource: object,
  service: object,
): Hooks {
  const hosted = [resource, service]
    .map(getHostHooks)
    .filter(Boolean) as Record<string, Hook[]>[];
  if (!hosted.length) return hooks ?? {};
  const merged: Record<string, Hook> = { ...hooks };
  for (const name of new Set(hosted.flatMap((item) => Object.keys(item)))) {
    const chain = [
      (hooks as Record<string, Hook> | undefined)?.[name],
      ...hosted.flatMap((item) => item[name] ?? []),
    ].filter((hook): hook is Hook => typeof hook === "function");
    merged[name] = async (args) => {
      for (const hook of chain) await hook(args);
    };
  }
  return merged;
}
function uniqueViolation(error: unknown): boolean {
  let current = error;
  for (
    let depth = 0;
    depth < 5 && current && typeof current === "object";
    depth++
  ) {
    if (
      "code" in current &&
      [
        "23505",
        "SQLITE_CONSTRAINT_UNIQUE",
        "SQLITE_CONSTRAINT_PRIMARYKEY",
      ].includes(String(current.code))
    )
      return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

/** What the operations need from crud() and its setup. */
export interface CrudModel extends Pick<
  ResourcePluginContext,
  "resource" | "service"
> {
  options: CrudOptions<any, any>;
  fields: Fields;
  columns: Record<string, Column>;
  /** Readable column fields, in field order. */
  readable: string[];
  defaultLimit: number;
}

/** Runs CRUD operations against the resource's table. */
export function operations(model: CrudModel) {
  const { options, resource, service, fields, columns, readable } = model;
  const idColumn: Column = resource.id;
  const cursorColumns = new Set(
    readable.filter((key) => !fields[key].scrub).map((key) => columns[key]),
  );
  const statement = statements();
  // A JS default or update function runs when the query is built, so preparing would freeze its value.
  const freezes = Object.values(columns).some(
    (column) => column.defaultFn || column.onUpdateFn,
  );
  const cacheable = (db: any, scoped: unknown) =>
    !scoped && !freezes && !!db?.$client?.prepare;
  const database = (ctx: any) => {
    const db = ctx.db ?? service.getDb();
    if (!db) throw new Error("CRUD requires a configured database");
    return db;
  };
  const recorder = (operation: string) =>
    options.events !== false &&
    service.recorder?.wants(`${resource.name}.${operation}`)
      ? service.recorder
      : undefined;
  const eventContext = (ctx: any) => ({
    traceId: ctx.traceId,
    source: `${service.name}.${resource.name}`,
  });
  const eventRow = (row: Record<string, unknown>) =>
    Object.fromEntries(readable.map((field) => [field, jsonValue(row[field])]));
  const eventId = (row: Record<string, unknown>) =>
    jsonValue(row[resource.idField]);

  const authorize = async (operation: Operation, input: any, ctx: any) => {
    if (options.access === "public") return;
    const accessConfig = options.access;
    if (
      !accessConfig?.authorize ||
      !(await accessConfig.authorize(
        // inputs[operation] validated this value before execute.
        { operation, input, ctx } as CrudAuthorizeArgs<any>,
      ))
    )
      deny(`${resource.name}.${operation}`, ctx.user);
  };

  /** A call's statement and where: the scope, the filters and, for one row, its ID. */
  const begin = (
    operation: Operation,
    input: any,
    scope: SQL | undefined,
    db: any,
  ) => {
    const derived: string[] = input.include ?? [];
    const selected: string[] = [...(input.select ?? readable), ...derived];
    const query = statement(cacheable(db, scope), [
      operation,
      selected,
      input.orderBy,
    ]);
    const where = and(
      scope,
      input.where ? condition(input.where, columns, query) : undefined,
      ["get", "update", "delete"].includes(operation)
        ? eq(idColumn, query.bind(databaseValue(idColumn, input.id)))
        : undefined,
    );
    return { operation, input, scope, db, derived, selected, query, where };
  };
  type Call = ReturnType<typeof begin> & {
    ctx: any;
    error: any;
    outer?: { tx: any; record?: EventRecorder };
  };

  /** The select behind list, findOne and get, with its cursor and limits bound. */
  const rowsQuery = ({
    operation,
    input,
    query,
    where,
    selected,
    derived,
  }: ReturnType<typeof begin>) => {
    // Keyset pagination: order by the sort fields plus the ID, and start
    // after the row the cursor names.
    const paging = operation === "list" && input.cursor !== undefined;
    const sorts: { field: string; direction: string }[] = input.orderBy ?? [];
    // Postgres timestamps keep microseconds, but a cursor holds a millisecond
    // Date: page on the millisecond so the cursor's tie still matches its row.
    const sortKey = (column: Column): SQL =>
      paging &&
      column.columnType === "PgTimestamp" &&
      ((column as { precision?: number }).precision ?? 6) > 3
        ? sql`date_trunc('milliseconds', ${column})`
        : sql`${column}`;
    const keyset = sorts.map((sort) => ({
      column: columns[sort.field] as Column,
      key: sortKey(columns[sort.field] as Column),
      desc: sort.direction === "desc",
    }));
    if (paging) {
      query.shape.push("cursor");
      if (input.offset) invalid("Use cursor or offset, not both");
      if (!keyset.some((key) => key.column === idColumn))
        keyset.push({ column: idColumn, key: sql`${idColumn}`, desc: false });
      if (keyset.some((key) => !key.column.notNull))
        invalid("Cursor pagination needs sort fields that are not null");
      // A cursor carries its sort values to the client and back, so it may
      // hold only what the caller already reads: no value leaks, and a
      // forged cursor filters on nothing the caller cannot see.
      if (keyset.some((key) => !cursorColumns.has(key.column)))
        invalid(
          "Cursor pagination needs sort fields and an ID that are readable and not scrubbed",
        );
    }
    const cursorSpec = sorts
      .map((sort) => `${sort.field}:${sort.direction}`)
      .join(",");
    let after: SQL | undefined;
    if (paging && input.cursor !== null) {
      const values = decodeCursor(input.cursor, cursorSpec, keyset);
      query.shape.push("after");
      // (a, b) after (x, y): a > x OR (a = x AND b > y), per direction.
      for (let index = keyset.length - 1; index >= 0; index--) {
        const { column, key, desc: down } = keyset[index];
        // Encoded by the column, also when the key is a SQL expression on it.
        const value = () =>
          new Param(query.bind(databaseValue(column, values[index])), column);
        const past = down ? lt(key, value()) : gt(key, value());
        after = after ? or(past, and(eq(key, value()), after)) : past;
      }
    }
    const selectedProjection = Object.fromEntries(
      selected
        .filter((key) => !fields[key].resolve)
        .map((key) => [key, columns[key]]),
    );
    // A sentinel permits resources with no readable fields without exposing the ID.
    const projection = {
      ...(derived.length
        ? columns
        : Object.keys(selectedProjection).length
          ? selectedProjection
          : { __brickSentinel: idColumn }),
      // The next cursor needs the sort values, even when not selected.
      ...(paging
        ? Object.fromEntries(
            keyset.map((key, index) => [`__brickKey${index}`, key.column]),
          )
        : {}),
    };
    const limit =
      operation === "list" ? (input.limit ?? model.defaultLimit) : 1;
    const offset = input.offset ?? 0;
    const ordering = keyset.map((key) =>
      key.desc ? desc(key.key) : asc(key.key),
    );
    // One extra row tells whether there is a next page.
    const boundLimit = query.bind(paging ? limit + 1 : limit),
      boundOffset = query.bind(offset);
    return {
      paging,
      limit,
      offset,
      next: (last: Record<string, unknown>) =>
        encodeCursor(
          cursorSpec,
          keyset.map((_, index) => last[`__brickKey${index}`]),
        ),
      build: (db: any) =>
        db
          .select(projection)
          .from(resource.table)
          .where(after ? and(where, after) : where)
          .orderBy(...ordering)
          .limit(boundLimit)
          .offset(boundOffset),
    };
  };

  /** Adds the derived fields the call includes. */
  const resolveRows = async (call: Call, rows: Record<string, unknown>[]) => {
    if (!rows.length) return rows;
    const resolved = rows.map((row) => ({ ...row }));
    for (const key of call.derived) {
      const values = await fields[key].resolve!({ rows, ctx: call.ctx });
      if (values.length !== rows.length)
        throw new Error(
          `Derived CRUD field '${key}' returned an incorrect number of values`,
        );
      for (let index = 0; index < rows.length; index++)
        resolved[index][key] = values[index];
    }
    return resolved;
  };
  /** The selected fields of a row, as JSON, scrubbed. */
  const scrub = async (call: Call, row: Record<string, unknown>) => {
    const result: Record<string, unknown> = {};
    for (const key of call.selected)
      result[key] = fields[key].scrub
        ? await fields[key].scrub!({
            value: jsonValue(row[key]),
            ctx: call.ctx,
          })
        : jsonValue(row[key]);
    return result;
  };
  const count = async (call: Call, part: string): Promise<number> =>
    (
      await call.query.run(call.db, part, () =>
        call.db
          .select({ count: sql<number>`count(*)`.mapWith(Number) })
          .from(resource.table)
          .where(call.where),
      )
    )[0].count;

  const read = async (call: Call) => {
    const { operation, input, query, db } = call;
    const rowsOf = rowsQuery(call);
    const fetched = await query.run(db, "rows", () => rowsOf.build(db));
    const more = rowsOf.paging && fetched.length > rowsOf.limit;
    const rows = await resolveRows(
      call,
      more ? fetched.slice(0, rowsOf.limit) : fetched,
    );
    if (operation === "get") {
      if (!rows[0])
        errors.NOT_FOUND("Resource not found");
      return scrub(call, rows[0]);
    }
    if (operation === "findOne") return rows[0] ? scrub(call, rows[0]) : null;
    const result: any = {
      items: await Promise.all(rows.map((row) => scrub(call, row))),
      limit: rowsOf.limit,
      offset: rowsOf.offset,
    };
    if (rowsOf.paging) {
      const last = rows.at(-1);
      result.nextCursor = more && last ? rowsOf.next(last) : null;
    }
    if (input.includeTotal) result.total = await count(call, "total");
    return result;
  };

  /** Runs a write in the bulk call's transaction, the event recorder's, or one opened for hooks. */
  const transaction = <R>(
    call: Call,
    hooks: Hooks,
    fn: (tx: any, record?: EventRecorder) => Promise<R>,
  ): Promise<R> => {
    const operation = call.operation as keyof typeof writeHooks;
    if (call.outer) return fn(call.outer.tx, call.outer.record);
    const recording = recorder(operation);
    if (recording)
      return recording.transaction(call.db, eventContext(call.ctx), fn);
    return writeHooks[operation].some((name) => hooks[name])
      ? runInTransaction(call.db, (tx) => fn(tx))
      : fn(call.db);
  };
  const committed = (
    call: Call,
    hooks: Hooks,
    args:
      | { operation: "create" | "update"; row: Record<string, unknown> }
      | { operation: "delete" },
  ) =>
    hooks.afterCommit &&
    onTransactionCommit(call.db, async () => {
      try {
        await hooks.afterCommit!({
          ...args,
          id: "row" in args ? args.row[resource.idField] : call.input.id,
          ctx: call.ctx,
        });
      } catch (cause) {
        // The write is committed: report the failure, keep the result.
        call.ctx.logger?.error?.(
          `${resource.name} afterCommit hook failed`,
          cause,
        );
      }
    });

  const remove = async (call: Call) => {
    const { input, ctx, error, query, where } = call;
    const hooks = withHostHooks(options.hooks, resource, service);
    await transaction(call, hooks, async (target, record) => {
      await hooks.beforeDelete?.({ id: input.id, ctx, error, tx: target });
      const rows = await query.run(
        target,
        record ? "delete-row" : "delete",
        () =>
          target
            .delete(resource.table)
            .where(where)
            .returning(record ? columns : { id: idColumn }),
      );
      if (!rows.length)
        errors.NOT_FOUND("Resource not found");
      if (record)
        await record(`${resource.name}.delete`, {
          id: eventId(rows[0]),
          row: eventRow(rows[0]),
        });
      await hooks.afterDelete?.({ id: input.id, ctx, error, tx: target });
    });
    await committed(call, hooks, { operation: "delete" });
    return { success: true };
  };

  const write = async (call: Call) => {
    const { input, ctx, error, query, where } = call;
    const operation = call.operation as "create" | "update";
    // Create scope cannot be enforced with INSERT WHERE: require explicit authorization.
    if (operation === "create" && call.scope)
      errors.FORBIDDEN("Row-scoped creation requires an explicit create policy");
    const hooks = withHostHooks(options.hooks, resource, service);
    const rows = await transaction(call, hooks, async (target, record) => {
      const data = { ...(operation === "create" ? input : input.data) };
      if (operation === "create")
        await hooks.beforeCreate?.({ data, ctx, error, tx: target });
      else
        await hooks.beforeUpdate?.({
          id: input.id,
          data,
          ctx,
          error,
          tx: target,
        });
      // Hooks are trusted and may set internal columns, but must use real table keys.
      for (const field of Object.keys(data))
        if (!Object.hasOwn(columns, field))
          throw new Error(`Write hook supplied unknown field '${field}'`);
      if (operation === "update" && !Object.keys(data).length)
        invalid("Update requires at least one field");
      const writeFields = Object.keys(data).sort((a, b) => (a < b ? -1 : 1));
      const boundData = Object.fromEntries(
        writeFields.map((field) => [
          field,
          query.bind(databaseValue(columns[field], data[field])),
        ]),
      );
      query.shape.push(writeFields);
      const before =
        record && operation === "update"
          ? ((
              await query.run(target, "before", () => {
                const select = target
                  .select(columns)
                  .from(resource.table)
                  .where(where)
                  .limit(1);
                return typeof select.for === "function"
                  ? select.for("update")
                  : select;
              })
            )[0] as Record<string, unknown> | undefined)
          : undefined;
      const written = await query
        .run(target, "write", () =>
          operation === "create"
            ? target.insert(resource.table).values(boundData).returning(columns)
            : target
                .update(resource.table)
                .set(boundData)
                .where(where)
                .returning(columns),
        )
        .catch((cause: unknown) => {
          if (uniqueViolation(cause))
            errors.CONFLICT("Resource already exists");
          throw cause;
        });
      if (!written[0])
        errors.NOT_FOUND("Resource not found");
      if (record)
        await record(
          `${resource.name}.${operation}`,
          operation === "create"
            ? { id: eventId(written[0]), row: eventRow(written[0]) }
            : {
                id: eventId(written[0]),
                before: eventRow(before ?? {}),
                after: eventRow(written[0]),
              },
        );
      if (operation === "create")
        await hooks.afterCreate?.({ row: written[0], ctx, error, tx: target });
      else
        await hooks.afterUpdate?.({
          id: input.id,
          row: written[0],
          ctx,
          error,
          tx: target,
        });
      return written;
    });
    await committed(call, hooks, { operation, row: rows[0] });
    return scrub(call, (await resolveRows(call, rows))[0]);
  };

  const perform = async (
    operation: Operation,
    input: any,
    ctx: any,
    error: any,
    outer?: Call["outer"],
  ): Promise<any> => {
    await authorize(operation, input, ctx);
    const db = outer?.tx ?? database(ctx);
    const scope =
      options.access === "public"
        ? undefined
        : await options.access?.scope?.({ operation, ctx });
    const call: Call = {
      ...begin(operation, input, scope, db),
      ctx,
      error,
      outer,
    };
    switch (operation) {
      case "list":
      case "findOne":
      case "get":
        return read(call);
      case "count":
        return { count: await count(call, "count") };
      case "exists": {
        const rows = await call.query.run(db, "exists", () =>
          db
            .select({ id: idColumn })
            .from(resource.table)
            .where(call.where)
            .limit(1),
        );
        return { exists: rows.length > 0 };
      }
      case "delete":
        return remove(call);
      default:
        return write(call);
    }
  };

  // One transaction for the whole batch: every item goes through the
  // single-row path (authorize, scope, hooks, events) or nothing is kept.
  const performBulk = async (
    operation: BulkOperation,
    input: any,
    ctx: any,
    error: any,
  ) => {
    const single = bulkOperations[operation];
    const items: any[] =
      single === "delete"
        ? input.ids.map((id: unknown) => ({ id }))
        : input.items;
    const db = database(ctx);
    const run = async (tx: any, record?: EventRecorder) => {
      const results: unknown[] = [];
      for (const [index, item] of items.entries())
        results.push(
          await perform(single, item, ctx, error, { tx, record }).catch(
            (cause: unknown) => {
              if (!(cause instanceof ActionExecutionError)) throw cause;
              throw new ActionExecutionError(
                cause.code,
                `Item ${index}: ${cause.message}`,
                cause.status,
                { index, code: cause.code, message: cause.message },
                { cause },
              );
            },
          ),
        );
      return results;
    };
    const recording = recorder(single);
    const results = recording
      ? await recording.transaction(db, eventContext(ctx), run)
      : await runInTransaction(db, (tx) => run(tx));
    return single === "delete" ? { count: results.length } : { items: results };
  };

  /** Prepares the unfiltered list and get statements ahead of the first call. */
  const prewarm = (enabled: readonly ("list" | "get")[]) => {
    const db: any = service.getDb();
    if (!cacheable(db, options.access !== "public" && options.access.scope))
      return;
    for (const operation of enabled) {
      const call = begin(operation, {}, undefined, db);
      call.query.warm(db, "rows", () => rowsQuery(call).build(db));
    }
  };

  return { perform, performBulk, prewarm };
}
