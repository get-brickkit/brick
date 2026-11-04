import {
  defineResourcePlugin,
  t,
  ActionExecutionError,
  setActionAccess,
  runInTransaction,
  onTransactionCommit,
  type EventRecorder,
} from "@brickkit/core";
import { Type, FormatRegistry, Kind, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  getTableColumns,
  type Column,
  type SQL,
  and,
  or,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  inArray,
  notInArray,
  between,
  isNull,
  isNotNull,
  asc,
  desc,
  sql,
  Param,
} from "drizzle-orm";

import type {
  BulkOperation,
  CrudAuthorizeArgs,
  CrudOptions,
  CrudPlugin,
  Fields,
  Operations,
  Operation,
  FilterOperator,
} from "./types";
export type * from "./types";

const methods: Record<
  Operation | BulkOperation,
  { method: "GET" | "POST" | "PATCH" | "DELETE"; path: string }
> = {
  list: { method: "POST", path: "/query" },
  get: { method: "GET", path: "/:id" },
  create: { method: "POST", path: "/" },
  update: { method: "PATCH", path: "/:id" },
  delete: { method: "DELETE", path: "/:id" },
  findOne: { method: "POST", path: "/find-one" },
  count: { method: "POST", path: "/count" },
  exists: { method: "POST", path: "/exists" },
  bulkCreate: { method: "POST", path: "/bulk-create" },
  bulkUpdate: { method: "POST", path: "/bulk-update" },
  bulkDelete: { method: "POST", path: "/bulk-delete" },
};
// Each bulk operation runs its single-row operation once per item.
const bulkOperations: Record<BulkOperation, "create" | "update" | "delete"> = {
  bulkCreate: "create",
  bulkUpdate: "update",
  bulkDelete: "delete",
};
const isoPattern =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$";
if (!FormatRegistry.Has("date-time"))
  FormatRegistry.Set(
    "date-time",
    (value) =>
      new RegExp(isoPattern).test(value) && Number.isFinite(Date.parse(value)),
  );
function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
    );
  return value;
}
function databaseValue(column: Column, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (column.dataType === "date" && typeof value === "string")
    return new Date(value);
  if (column.dataType === "bigint" && typeof value === "string")
    return BigInt(value);
  return value;
}
function checkJsonSchema(schema: TSchema, seen = new Set<object>()): void {
  if (seen.has(schema)) return;
  seen.add(schema);
  if (
    [
      "Date",
      "BigInt",
      "Undefined",
      "Symbol",
      "Function",
      "Constructor",
      "Void",
    ].includes(schema[Kind])
  )
    throw new Error(
      `CRUD schema '${schema[Kind]}' is not JSON-safe; use string date-time or decimal strings`,
    );
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const child of value)
        if (child && typeof child === "object")
          checkJsonSchema(child as TSchema, seen);
    } else if (value && typeof value === "object")
      checkJsonSchema(value as TSchema, seen);
  }
}
function columnSchema(column: Column): TSchema {
  const c = column as Column & { enumValues?: string[] };
  let schema: TSchema;
  if (c.enumValues?.length)
    schema = t.Union(c.enumValues.map((v) => t.Literal(v)));
  else
    switch (c.dataType) {
      case "string":
        schema = t.String();
        break;
      case "number":
        schema = t.Number();
        break;
      case "boolean":
        schema = t.Boolean();
        break;
      case "date":
        schema = t.String({ format: "date-time", pattern: isoPattern });
        break;
      case "bigint":
        schema = t.String({ pattern: "^-?(?:0|[1-9][0-9]*)$" });
        break;
      case "json":
        schema = t.Unknown();
        break;
      case "array":
        schema = t.Array(t.Unknown());
        break;
      default:
        schema = t.Unknown();
    }
  return c.notNull ? schema : t.Union([schema, t.Null()]);
}
function object(properties: Record<string, TSchema>) {
  return t.Object(properties, { additionalProperties: false });
}
const invalid = (message: string): never => {
  throw new ActionExecutionError("BAD_REQUEST", message, 400);
};
/** An opaque list cursor: the orderBy it was made for, and the last row's sort values. */
function encodeCursor(spec: string, values: unknown[]): string {
  return Buffer.from(JSON.stringify([spec, values.map(jsonValue)])).toString(
    "base64url",
  );
}
/** The sort values a client cursor holds, checked against the columns they bind to. */
function decodeCursor(
  cursor: string,
  spec: string,
  keyset: { column: Column }[],
): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    return invalid("Invalid cursor");
  }
  if (
    !Array.isArray(parsed) ||
    parsed[0] !== spec ||
    !Array.isArray(parsed[1]) ||
    parsed[1].length !== keyset.length ||
    keyset.some(
      ({ column }, index) =>
        !Value.Check(columnSchema(column), (parsed as unknown[][])[1][index]),
    )
  )
    return invalid("Invalid cursor for this orderBy");
  return parsed[1];
}
const MAX_WHERE_DEPTH = 20;
// Iterative pre-validation depth walk over raw `where` input. The action
// input validator runs before execute()/condition(), so unbounded `and`/`or`
// nesting would recurse inside the compiled TypeBox check first — past the
// call-stack limit it throws RangeError (HTTP 500) instead of a 400. This
// keeps rejection O(nesting) with constant stack on every entry path.
function whereDepthExceeded(input: unknown): boolean {
  const root =
    input && typeof input === "object"
      ? (input as { where?: unknown }).where
      : undefined;
  if (!root || typeof root !== "object") return false;
  const stack: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_WHERE_DEPTH) return true;
    const record = node as Record<string, unknown>;
    for (const key of ["and", "or"] as const) {
      const children = record[key];
      if (Array.isArray(children))
        for (const child of children)
          stack.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
}
const own = (value: object, key: string) => Object.hasOwn(value, key);

// Where definePlugin's `hooks.*` puts a plugin's hooks, on the resource or the
// service it is installed on. A process-global symbol, so core needs no crud import.
const HOST_HOOKS = Symbol.for("brickkit.plugin.hooks");
type Hook = (args: any) => unknown;
/** The crud() hooks, then those of plugins installed on the resource, then on the service. */
function withHostHooks(
  hooks: CrudOptions<any, any>["hooks"],
  resource: object,
  service: object,
): NonNullable<CrudOptions<any, any>["hooks"]> {
  const hosted = [resource, service]
    .map((host) => (host as Record<symbol, unknown>)[HOST_HOOKS])
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

/**
 * A plugin that gives a resource its CRUD actions: `list`, `get`, `create`,
 * `update`, `delete`, `findOne`, `count`, and `exists`, with validated input
 * and output, filters and sorting, and access rules. Install it with
 * `resource.use(crud({ ... }))`. The actions are named `<resource>.<operation>`
 * and routed under `/api/<resource>`.
 *
 * It denies by default: `access` is required. A column is hidden from reads,
 * writes, and filters until its `fields` entry allows it.
 *
 * @param options - `fields` (per column: `read`, `create`, `update`, `filter`
 * operators, and `sort`), `access` (`"public"`, or `{ authorize, scope }`),
 * `operations` to switch some off, `routes` to move or disable routes,
 * `hooks` around create, update, and delete, and `defaultLimit` and `maxLimit`
 * for lists.
 * @returns The plugin, for `resource.use`, which returns the resource with its
 * actions attached so they can be called in-process.
 * @example
 * import { crud } from "@brickkit/crud";
 *
 * export const page = pagesService
 *   .resource({ name: "page", table: pages, id: pages.id })
 *   .use(
 *     crud({
 *       access: "public",
 *       fields: {
 *         id: { read: true, filter: ["eq", "in"] },
 *         title: { read: true, create: true, update: true, sort: true },
 *       },
 *     }),
 *   );
 */
export function crud<const F extends Fields, const O extends Operations = {}>(
  options: CrudOptions<F, O>,
): CrudPlugin<F, O> {
  options = {
    ...options,
    fields: Object.fromEntries(
      Object.entries(options.fields).map(([key, value]) => [
        key,
        value.resolve
          ? { ...value }
          : { ...value, filter: value.filter ? [...value.filter] : undefined },
      ]),
    ) as F,
    access:
      typeof options.access === "string"
        ? options.access
        : { ...options.access },
    hooks: options.hooks ? { ...options.hooks } : undefined,
    operations:
      typeof options.operations === "object"
        ? { ...options.operations }
        : options.operations,
  };
  const descriptor = defineResourcePlugin({
    name: "@brickkit/crud",
    routes: options.routes,
    setup({ resource, service, routes }) {
      if (options.operations === false) return {};
      const columns: Record<string, Column> = getTableColumns(resource.table);
      const fields: Fields = Object.fromEntries(
        Object.entries(options.fields).map(([key, value]) => [
          key,
          value.resolve
            ? { ...value }
            : {
                ...value,
                filter: value.filter ? [...value.filter] : undefined,
              },
        ]),
      );
      const schemas: Record<string, TSchema> = {};
      const readable = Object.keys(fields).filter(
        (key) => fields[key].read && !fields[key].resolve,
      );
      const includable = Object.keys(fields).filter(
        (key) => fields[key].resolve,
      );
      const projection: Record<string, Column> = {};
      for (const [key, policy] of Object.entries(fields)) {
        if (policy.resolve) {
          if (
            !policy.read ||
            !policy.schema ||
            policy.create ||
            policy.update ||
            policy.sort ||
            policy.filter?.length
          )
            throw new Error(
              `Derived CRUD field '${key}' requires read/schema and cannot enable writes, filters or sorting`,
            );
          if (own(columns, key))
            throw new Error(
              `Derived CRUD field '${key}' cannot replace a table column`,
            );
          schemas[key] = policy.schema;
          checkJsonSchema(schemas[key]);
          continue;
        }
        if (!own(columns, key))
          throw new Error(`Unknown CRUD field '${key}' on '${resource.name}'`);
        schemas[key] = policy.schema ?? columnSchema(columns[key]);
        checkJsonSchema(schemas[key]);
        if (columns[key] === resource.id && policy.update)
          throw new Error("CRUD primary key cannot be updated");
        for (const operator of policy.filter ?? []) {
          if (
            ![
              "eq",
              "ne",
              "in",
              "notIn",
              "gt",
              "gte",
              "lt",
              "lte",
              "between",
              "contains",
              "startsWith",
              "endsWith",
              "isNull",
              "isNotNull",
            ].includes(operator)
          )
            throw new Error(`Unknown filter operator '${operator}'`);
          if (
            ["contains", "startsWith", "endsWith"].includes(operator) &&
            columns[key].dataType !== "string"
          )
            throw new Error(
              `Text filter '${operator}' requires a string column '${key}'`,
            );
        }
        for (const operator of policy.filter ?? []) {
          if (
            ["gt", "gte", "lt", "lte", "between"].includes(operator) &&
            !["string", "number", "date", "bigint"].includes(
              columns[key].dataType,
            )
          )
            throw new Error(
              `Ordered filter '${operator}' is unsupported for '${key}'`,
            );
          if (
            !["isNull", "isNotNull"].includes(operator) &&
            ["json", "array", "buffer", "custom"].includes(
              columns[key].dataType,
            )
          )
            throw new Error(`Filter '${operator}' is unsupported for '${key}'`);
        }
        if (
          policy.sort &&
          !["string", "number", "date", "bigint", "boolean"].includes(
            columns[key].dataType,
          )
        )
          throw new Error(`Sorting is unsupported for '${key}'`);
        if (policy.read) projection[key] = columns[key];
      }
      const idColumn: Column = resource.id;
      if (!Object.values(columns).includes(idColumn))
        throw new Error("CRUD ID must belong to the resource table");
      const idSchema = columnSchema(idColumn);
      const defaultLimit = options.defaultLimit ?? 20;
      const maxLimit = options.maxLimit ?? 100;
      if (
        !Number.isInteger(defaultLimit) ||
        defaultLimit < 1 ||
        !Number.isInteger(maxLimit) ||
        maxLimit < defaultLimit
      )
        throw new Error("Invalid CRUD pagination limits");
      const maxBatchSize = options.maxBatchSize ?? 100;
      if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1)
        throw new Error("Invalid CRUD maxBatchSize");
      const batch = (item: TSchema, unique = false) =>
        t.Array(item, {
          minItems: 1,
          maxItems: maxBatchSize,
          uniqueItems: unique,
        });
      const fieldLiteral = (keys: string[]) =>
        keys.length ? t.Union(keys.map((key) => t.Literal(key))) : t.Never();
      // Named where leaves: one union schema per filterable field plus named
      // `and`/`or` branches. The client-contract generator only emits aliases
      // for schemas reached via $ref (using `title ?? $id`), so anonymous
      // leaves degrade to hash names. Each field union is imported by $ref
      // from a module: TypeBox hoists every $id subschema into a shared
      // check function, so compilation stays linear. Union nesting is
      // associative, so validation accepts exactly the same inputs.
      const whereId = `CrudWhere:${resource.name}`;
      const whereTitle = (suffix: string) => `Where:${resource.name}:${suffix}`;
      const whereFields: Record<string, TSchema> = {};
      for (const [field, policy] of Object.entries(fields)) {
        const operators = policy.filter ?? [];
        if (!operators.length) continue;
        if (field === "and" || field === "or")
          throw new Error(
            `CRUD filter field '${field}' on '${resource.name}' collides with the '${field}' branch`,
          );
        const fieldLeaves = operators.map((op) => {
          const valueSchema = Type.Exclude(schemas[field], t.Null());
          const value: Record<string, TSchema> = [
            "isNull",
            "isNotNull",
          ].includes(op)
            ? {}
            : {
                value: ["in", "notIn"].includes(op)
                  ? t.Array(valueSchema, { minItems: 1, maxItems: 1000 })
                  : op === "between"
                    ? t.Tuple([valueSchema, valueSchema])
                    : valueSchema,
              };
          return object({
            field: t.Literal(field),
            op: t.Literal(op),
            ...value,
          });
        });
        whereFields[`${whereId}:${field}`] = t.Union(fieldLeaves, {
          title: whereTitle(field),
        });
      }
      const whereModule = t.Module({
        ...whereFields,
        [`${whereId}:and`]: t.Object(
          { and: t.Array(t.Ref(whereId), { minItems: 1, maxItems: 50 }) },
          { additionalProperties: false, title: whereTitle("and") },
        ),
        [`${whereId}:or`]: t.Object(
          { or: t.Array(t.Ref(whereId), { minItems: 1, maxItems: 50 }) },
          { additionalProperties: false, title: whereTitle("or") },
        ),
      });
      // Recursive rather than depth-inlined: TypeCompiler expands shared
      // inlined subschemas exponentially, stalling first validation for
      // seconds. Each $id member above compiles to one shared function, so
      // the recursion through the module $refs stays linear. Runtime
      // `condition()` still rejects nesting beyond 20, and the
      // `validateInput` wrapper below rejects it before validation runs.
      // The Recursive callback ignores Self on purpose: recursion flows
      // through the named module $refs back to this root $id.
      const whereSchema: TSchema =
        Object.keys(whereFields).length > 0
          ? t.Recursive(
              () =>
                t.Union([
                  ...Object.keys(whereFields).map((id) =>
                    whereModule.Import(id),
                  ),
                  whereModule.Import(`${whereId}:and`),
                  whereModule.Import(`${whereId}:or`),
                ]),
              { $id: whereId },
            )
          : t.Never();
      const selection = t.Optional(
        t.Array(fieldLiteral(readable), { minItems: 1, uniqueItems: true }),
      );
      const includes = t.Optional(
        t.Array(fieldLiteral(includable), { uniqueItems: true }),
      );
      const queryProperties = {
        select: selection,
        include: includes,
        where: t.Optional(whereSchema),
        orderBy: t.Optional(
          t.Array(
            object({
              field: fieldLiteral(
                Object.keys(fields).filter((key) => fields[key].sort),
              ),
              direction: t.Union([t.Literal("asc"), t.Literal("desc")]),
            }),
            { maxItems: 20 },
          ),
        ),
        limit: t.Optional(t.Integer({ minimum: 1, maximum: maxLimit })),
        offset: t.Optional(t.Integer({ minimum: 0 })),
        includeTotal: t.Optional(t.Boolean()),
      };
      const querySchema = object(queryProperties);
      const rowFields = Object.fromEntries(
        [...readable, ...includable].map((key) => {
          const schema =
            fields[key].schema ??
            (fields[key].scrub ? t.Unknown() : schemas[key]);
          return [key, fields[key].resolve ? t.Optional(schema) : schema];
        }),
      );
      // Contract rows require parent fields; explicitly included derived fields are optional. Nullable
      // columns already carry `| null` via columnSchema, so they stay
      // `T | null` — never `| undefined`. This is what ships in
      // `config.output` for the browser contract and OpenAPI.
      const rowSchema = object({ ...rowFields });
      // Runtime validation must still accept subset projections (`select`),
      // which return only the requested keys. The loose variant permits
      // omission; it is wired via `outputValidationSchema` below and never
      // leaks into generated types.
      const rowSchemaLoose = object(
        Object.fromEntries(
          Object.entries(rowFields).map(([key, schema]) => [
            key,
            t.Optional(schema),
          ]),
        ),
      );
      const writeSchema = (kind: "create" | "update") =>
        object(
          Object.fromEntries(
            Object.entries(fields)
              .filter(([, p]) => p[kind])
              .map(([key]) => [
                key,
                kind === "update" ||
                columns[key].hasDefault ||
                !columns[key].notNull
                  ? t.Optional(schemas[key])
                  : schemas[key],
              ]),
          ),
        );
      const createSchema = writeSchema("create");
      const updateSchema = writeSchema("update");
      const inputs: Record<Operation | BulkOperation, TSchema> = {
        list: object({
          ...queryProperties,
          // `null` starts keyset pagination; a `nextCursor` continues it.
          cursor: t.Optional(
            t.Union([t.String({ maxLength: 4096 }), t.Null()]),
          ),
        }),
        findOne: querySchema,
        get: object({ id: idSchema, select: selection, include: includes }),
        create: createSchema,
        update: object({ id: idSchema, data: updateSchema }),
        delete: object({ id: idSchema }),
        count: object({ where: t.Optional(whereSchema) }),
        exists: object({ where: t.Optional(whereSchema) }),
        bulkCreate: object({ items: batch(createSchema) }),
        bulkUpdate: object({
          items: batch(object({ id: idSchema, data: updateSchema })),
        }),
        bulkDelete: object({ ids: batch(idSchema, true) }),
      };
      const outputs: Record<Operation | BulkOperation, TSchema> = {
        list: object({
          items: t.Array(rowSchema),
          total: t.Optional(t.Integer()),
          limit: t.Integer(),
          offset: t.Integer(),
          nextCursor: t.Optional(t.Union([t.String(), t.Null()])),
        }),
        findOne: t.Union([rowSchema, t.Null()]),
        get: rowSchema,
        create: rowSchema,
        update: rowSchema,
        delete: object({ success: t.Literal(true) }),
        count: object({ count: t.Integer() }),
        exists: object({ exists: t.Boolean() }),
        bulkCreate: object({ items: t.Array(rowSchema) }),
        bulkUpdate: object({ items: t.Array(rowSchema) }),
        bulkDelete: object({ count: t.Integer() }),
      };
      // Runtime-only outputs: same shape but rows may be subset projections.
      const looseOutputs: Record<Operation | BulkOperation, TSchema> = {
        list: object({
          items: t.Array(rowSchemaLoose),
          total: t.Optional(t.Integer()),
          limit: t.Integer(),
          offset: t.Integer(),
          nextCursor: t.Optional(t.Union([t.String(), t.Null()])),
        }),
        findOne: t.Union([rowSchemaLoose, t.Null()]),
        get: rowSchemaLoose,
        create: rowSchemaLoose,
        update: rowSchemaLoose,
        delete: object({ success: t.Literal(true) }),
        count: object({ count: t.Integer() }),
        exists: object({ exists: t.Boolean() }),
        bulkCreate: object({ items: t.Array(rowSchemaLoose) }),
        bulkUpdate: object({ items: t.Array(rowSchemaLoose) }),
        bulkDelete: object({ count: t.Integer() }),
      };
      const prepared = new WeakMap<object, Map<string, any>>();
      const executeQuery = async (
        db: any,
        key: string,
        build: () => any,
        params: Record<string, unknown>,
        cacheable: boolean,
      ) => {
        if (cacheable && db.$client?.prepare) {
          let cache = prepared.get(db);
          if (!cache) {
            cache = new Map();
            prepared.set(db, cache);
          }
          let statement = cache.get(key);
          if (!statement) {
            statement = build().prepare();
            if (cache.size >= 128) cache.delete(cache.keys().next().value!);
            cache.set(key, statement);
          }
          return statement.execute(params);
        }
        return await build();
      };
      const api: Record<string, unknown> = {};
      // Expose the access policy for introspection: enforcement stays inside
      // execute(), so stamp metadata that getActionAccess() reads. Deny by
      // default — anything that is not explicit "public" is protected, even
      // when authorize is missing (runtime rejects with FORBIDDEN).
      const crudIsPublic = options.access === "public";
      const crudHasScopeFn =
        !crudIsPublic &&
        typeof (options.access as { scope?: unknown } | undefined)?.scope ===
          "function";
      const crudHasAuthorize = !crudIsPublic;
      const eventContext = (ctx: any) => ({
        traceId: ctx.traceId,
        source: `${service.name}.${resource.name}`,
      });
      const perform = async (
        operation: Operation,
        input: any,
        ctx: any,
        error: any,
        outer?: { tx: any; record?: EventRecorder },
      ): Promise<any> => {
        if (options.access !== "public") {
          const accessConfig = options.access;
          if (
            !accessConfig?.authorize ||
            !(await accessConfig.authorize(
              // inputs[operation] validated this value before execute.
              { operation, input, ctx } as CrudAuthorizeArgs<F>,
            ))
          )
            throw new ActionExecutionError(
              ctx.user == null ? "UNAUTHORIZED" : "FORBIDDEN",
              "Access denied",
              ctx.user == null ? 401 : 403,
            );
        }
        const db: any = outer?.tx ?? ctx.db ?? service.getDb();
        if (!db) throw new Error("CRUD requires a configured database");
        const eventName = `${resource.name}.${operation}`;
        const recording =
          !outer &&
          options.events !== false &&
          (operation === "create" ||
            operation === "update" ||
            operation === "delete") &&
          service.recorder?.wants(eventName)
            ? service.recorder
            : undefined;
        const readableEventRow = (row: Record<string, unknown>) =>
          Object.fromEntries(
            readable.map((field) => [field, jsonValue(row[field])]),
          );
        const eventId = (row: Record<string, unknown>) =>
          jsonValue(row[resource.idField]);
        const scope =
          options.access === "public"
            ? undefined
            : await options.access?.scope?.({ operation, ctx });
        const cacheable =
          !scope &&
          !!db.$client?.prepare &&
          !Object.values(columns).some(
            (column) => column.defaultFn || column.onUpdateFn,
          );
        const params: Record<string, unknown> = {};
        let parameter = 0;
        const bind = (value: unknown): any => {
          if (!cacheable) return value;
          const key = `p${parameter++}`;
          params[key] = value;
          return sql.placeholder(key);
        };
        const shape: unknown[] = [];
        const condition = (node: any, depth = 0): SQL => {
          if (depth > MAX_WHERE_DEPTH)
            invalid(`Filter nesting exceeds ${MAX_WHERE_DEPTH} levels`);
          if (node.and) {
            shape.push("and", node.and.length);
            return and(...node.and.map((n: any) => condition(n, depth + 1)))!;
          }
          if (node.or) {
            shape.push("or", node.or.length);
            return or(...node.or.map((n: any) => condition(n, depth + 1)))!;
          }
          const col = columns[node.field];
          shape.push(node.field, node.op);
          switch (node.op as FilterOperator) {
            case "eq":
              return eq(col, bind(databaseValue(col, node.value)));
            case "ne":
              return ne(col, bind(databaseValue(col, node.value)));
            case "gt":
              return gt(col, bind(databaseValue(col, node.value)));
            case "gte":
              return gte(col, bind(databaseValue(col, node.value)));
            case "lt":
              return lt(col, bind(databaseValue(col, node.value)));
            case "lte":
              return lte(col, bind(databaseValue(col, node.value)));
            case "in":
              shape.push(node.value.length);
              return inArray(
                col,
                node.value.map((value: unknown) =>
                  bind(databaseValue(col, value)),
                ),
              );
            case "notIn":
              shape.push(node.value.length);
              return notInArray(
                col,
                node.value.map((value: unknown) =>
                  bind(databaseValue(col, value)),
                ),
              );
            case "between":
              return between(
                col,
                bind(databaseValue(col, node.value[0])),
                bind(databaseValue(col, node.value[1])),
              );
            case "isNull":
              return isNull(col);
            case "isNotNull":
              return isNotNull(col);
            case "contains":
            case "startsWith":
            case "endsWith": {
              const escaped = String(node.value).replace(/[\\%_]/g, "\\$&");
              const pattern =
                node.op === "contains"
                  ? `%${escaped}%`
                  : node.op === "startsWith"
                    ? `${escaped}%`
                    : `%${escaped}`;
              return sql`${col} LIKE ${bind(pattern)} ESCAPE '\\'`;
            }
            default:
              return invalid("Unknown filter operator");
          }
        };
        const where = and(
          scope,
          input.where ? condition(input.where) : undefined,
          ["get", "update", "delete"].includes(operation)
            ? eq(idColumn, bind(databaseValue(idColumn, input.id)))
            : undefined,
        );
        // Keyset pagination: order by the sort fields plus the ID, and start
        // after the row the cursor names.
        const paging = operation === "list" && input.cursor !== undefined;
        const sorts: { field: string; direction: string }[] =
          input.orderBy ?? [];
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
          shape.push("cursor");
          if (input.offset) invalid("Use cursor or offset, not both");
          if (!keyset.some((key) => key.column === idColumn))
            keyset.push({
              column: idColumn,
              key: sql`${idColumn}`,
              desc: false,
            });
          if (keyset.some((key) => !key.column.notNull))
            invalid("Cursor pagination needs sort fields that are not null");
        }
        const cursorSpec = sorts
          .map((sort) => `${sort.field}:${sort.direction}`)
          .join(",");
        let after: SQL | undefined;
        if (paging && input.cursor !== null) {
          const values = decodeCursor(input.cursor, cursorSpec, keyset);
          shape.push("after");
          // (a, b) after (x, y): a > x OR (a = x AND b > y), per direction.
          for (let index = keyset.length - 1; index >= 0; index--) {
            const { column, key, desc: down } = keyset[index];
            // Encoded by the column, also when the key is a SQL expression on it.
            const value = () =>
              new Param(bind(databaseValue(column, values[index])), column);
            const past = down ? lt(key, value()) : gt(key, value());
            after = after ? or(past, and(eq(key, value()), after)) : past;
          }
        }
        const derived: string[] = input.include ?? [];
        const selected: string[] = [...(input.select ?? readable), ...derived];
        const selectedProjection = Object.fromEntries(
          selected
            .filter((key) => !fields[key].resolve)
            .map((key) => [key, columns[key]]),
        );
        // A sentinel permits resources with no readable fields without exposing the ID.
        const dbProjection = {
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
        const resolveRows = async (rows: Record<string, unknown>[]) => {
          if (!rows.length) return rows;
          const resolved = rows.map((row) => ({ ...row }));
          for (const key of derived) {
            const values = await fields[key].resolve!({ rows, ctx });
            if (values.length !== rows.length)
              throw new Error(
                `Derived CRUD field '${key}' returned an incorrect number of values`,
              );
            for (let index = 0; index < rows.length; index++)
              resolved[index][key] = values[index];
          }
          return resolved;
        };
        const scrub = async (row: Record<string, unknown>) => {
          const result: Record<string, unknown> = {};
          for (const key of selected)
            result[key] = fields[key].scrub
              ? await fields[key].scrub!({
                  value: jsonValue(row[key]),
                  ctx,
                })
              : jsonValue(row[key]);
          return result;
        };
        const key = (suffix: string) =>
          JSON.stringify([operation, suffix, shape, selected, input.orderBy]);
        if (["list", "findOne", "get"].includes(operation)) {
          const limit =
            operation === "list" ? (input.limit ?? defaultLimit) : 1;
          const offset = input.offset ?? 0;
          const ordering = keyset.map((key) =>
            key.desc ? desc(key.key) : asc(key.key),
          );
          // One extra row tells whether there is a next page.
          const boundLimit = bind(paging ? limit + 1 : limit),
            boundOffset = bind(offset);
          const fetched = await executeQuery(
            db,
            key("rows"),
            () =>
              db
                .select(dbProjection)
                .from(resource.table)
                .where(after ? and(where, after) : where)
                .orderBy(...ordering)
                .limit(boundLimit)
                .offset(boundOffset),
            params,
            cacheable,
          );
          const more = paging && fetched.length > limit;
          const rows = await resolveRows(
            more ? fetched.slice(0, limit) : fetched,
          );
          if (operation === "get") {
            if (!rows[0])
              throw new ActionExecutionError(
                "NOT_FOUND",
                "Resource not found",
                404,
              );
            return scrub(rows[0]);
          }
          if (operation === "findOne") return rows[0] ? scrub(rows[0]) : null;
          const result: any = {
            items: await Promise.all(rows.map(scrub)),
            limit,
            offset,
          };
          if (paging) {
            const last = rows.at(-1);
            result.nextCursor =
              more && last
                ? encodeCursor(
                    cursorSpec,
                    keyset.map((_, index) => last[`__brickKey${index}`]),
                  )
                : null;
          }
          if (input.includeTotal) {
            const counts = await executeQuery(
              db,
              key("total"),
              () =>
                db
                  .select({ count: sql<number>`count(*)`.mapWith(Number) })
                  .from(resource.table)
                  .where(where),
              params,
              cacheable,
            );
            result.total = counts[0].count;
          }
          return result;
        }
        if (operation === "count") {
          const rows = await executeQuery(
            db,
            key("count"),
            () =>
              db
                .select({ count: sql<number>`count(*)`.mapWith(Number) })
                .from(resource.table)
                .where(where),
            params,
            cacheable,
          );
          return { count: rows[0].count };
        }
        if (operation === "exists") {
          const rows = await executeQuery(
            db,
            key("exists"),
            () =>
              db
                .select({ id: idColumn })
                .from(resource.table)
                .where(where)
                .limit(1),
            params,
            cacheable,
          );
          return { exists: rows.length > 0 };
        }
        const hooks = withHostHooks(options.hooks, resource, service);
        // Hooks get the transaction; a bulk call passes its own in `outer`.
        const inTransaction = <R>(
          fn: (tx: any, record?: EventRecorder) => Promise<R>,
        ): Promise<R> =>
          outer
            ? fn(outer.tx, outer.record)
            : recording
              ? recording.transaction(db, eventContext(ctx), fn)
              : (
                    operation === "create"
                      ? hooks.beforeCreate || hooks.afterCreate
                      : operation === "update"
                        ? hooks.beforeUpdate || hooks.afterUpdate
                        : hooks.beforeDelete || hooks.afterDelete
                  )
                ? runInTransaction(db, (tx) => fn(tx))
                : fn(db);
        const committed = (
          args:
            | { operation: "create" | "update"; row: Record<string, unknown> }
            | { operation: "delete" },
        ) =>
          hooks.afterCommit &&
          onTransactionCommit(db, async () => {
            try {
              await hooks.afterCommit!({
                ...args,
                id: "row" in args ? args.row[resource.idField] : input.id,
                ctx,
              });
            } catch (cause) {
              // The write is committed: report the failure, keep the result.
              ctx.logger?.error?.(
                `${resource.name} afterCommit hook failed`,
                cause,
              );
            }
          });
        if (operation === "delete") {
          await inTransaction(async (target, record) => {
            await hooks.beforeDelete?.({
              id: input.id,
              ctx,
              error,
              tx: target,
            });
            const rows = await executeQuery(
              target,
              key(record ? "delete-row" : "delete"),
              () =>
                target
                  .delete(resource.table)
                  .where(where)
                  .returning(record ? columns : { id: idColumn }),
              params,
              cacheable,
            );
            if (!rows.length)
              throw new ActionExecutionError(
                "NOT_FOUND",
                "Resource not found",
                404,
              );
            if (record)
              await record(eventName, {
                id: eventId(rows[0]),
                row: readableEventRow(rows[0]),
              });
            await hooks.afterDelete?.({ id: input.id, ctx, error, tx: target });
          });
          await committed({ operation: "delete" });
          return { success: true };
        }
        // Create scope cannot be enforced with INSERT WHERE: require explicit authorization.
        if (operation === "create" && scope)
          throw new ActionExecutionError(
            "FORBIDDEN",
            "Row-scoped creation requires an explicit create policy",
            403,
          );
        const rows = await inTransaction(async (target, record) => {
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
            if (!own(columns, field))
              throw new Error(`Write hook supplied unknown field '${field}'`);
          if (operation === "update" && !Object.keys(data).length)
            invalid("Update requires at least one field");
          const writeFields = Object.keys(data).sort((a, b) =>
            a < b ? -1 : 1,
          );
          const boundData = Object.fromEntries(
            writeFields.map((field) => [
              field,
              bind(databaseValue(columns[field], data[field])),
            ]),
          );
          shape.push(writeFields);
          const safeCache =
            cacheable &&
            !writeFields.some(
              (field) => columns[field].defaultFn || columns[field].onUpdateFn,
            ) &&
            !Object.values(columns).some(
              (column) => column.defaultFn || column.onUpdateFn,
            );
          const before =
            record && operation === "update"
              ? ((
                  await executeQuery(
                    target,
                    key("before"),
                    () => {
                      const query = target
                        .select(columns)
                        .from(resource.table)
                        .where(where)
                        .limit(1);
                      return typeof query.for === "function"
                        ? query.for("update")
                        : query;
                    },
                    params,
                    cacheable,
                  )
                )[0] as Record<string, unknown> | undefined)
              : undefined;
          const written = await executeQuery(
            target,
            key("write"),
            () =>
              operation === "create"
                ? target
                    .insert(resource.table)
                    .values(boundData)
                    .returning(columns)
                : target
                    .update(resource.table)
                    .set(boundData)
                    .where(where)
                    .returning(columns),
            params,
            safeCache,
          ).catch((cause: unknown) => {
            if (uniqueViolation(cause))
              throw new ActionExecutionError(
                "CONFLICT",
                "Resource already exists",
                409,
              );
            throw cause;
          });
          if (!written[0])
            throw new ActionExecutionError(
              "NOT_FOUND",
              "Resource not found",
              404,
            );
          if (record)
            await record(
              eventName,
              operation === "create"
                ? {
                    id: eventId(written[0]),
                    row: readableEventRow(written[0]),
                  }
                : {
                    id: eventId(written[0]),
                    before: readableEventRow(before ?? {}),
                    after: readableEventRow(written[0]),
                  },
            );
          if (operation === "create")
            await hooks.afterCreate?.({
              row: written[0],
              ctx,
              error,
              tx: target,
            });
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
        await committed({
          operation: operation as "create" | "update",
          row: rows[0],
        });
        return scrub((await resolveRows(rows))[0]);
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
        const db: any = ctx.db ?? service.getDb();
        if (!db) throw new Error("CRUD requires a configured database");
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
        const results =
          options.events !== false &&
          service.recorder?.wants(`${resource.name}.${single}`)
            ? await service.recorder.transaction(db, eventContext(ctx), run)
            : await runInTransaction(db, (tx) => run(tx));
        return single === "delete"
          ? { count: results.length }
          : { items: results };
      };
      for (const operation of Object.keys(methods) as (
        | Operation
        | BulkOperation
      )[]) {
        if (
          operation in bulkOperations
            ? !options.operations || options.operations[operation] !== true
            : options.operations && options.operations[operation] === false
        )
          continue;
        // Per-operation metadata: `create` never runs row-scoped (its scope
        // is always undefined, and a nonempty create scope is rejected with
        // FORBIDDEN), so it reports authorized rather than scoped.
        const opHasScope =
          crudHasScopeFn &&
          operation !== "create" &&
          operation !== "bulkCreate";
        const crudAccess = {
          hasAuthorize: crudHasAuthorize,
          hasScope: opHasScope,
          policy: (crudIsPublic
            ? "public"
            : opHasScope
              ? "scoped"
              : "authorized") as "public" | "authorized" | "scoped",
        };
        const action = routes.action({
          name: operation,
          ...methods[operation],
          input: inputs[operation],
          output: outputs[operation],
          execute: ({ input, ctx, error }) =>
            operation in bulkOperations
              ? performBulk(operation as BulkOperation, input, ctx, error)
              : perform(operation as Operation, input, ctx, error),
        });
        // Pre-validation depth guard: action input validation runs before
        // execute()/condition(), so reject over-nested `where` here instead
        // of recursing inside the compiled TypeBox check.
        // Runtime output validation accepts subset projections while the
        // published `config.output` stays strict for contracts/OpenAPI.
        action.outputValidationSchema = looseOutputs[operation];
        setActionAccess(action, crudAccess);
        const innerValidateInput = action.validateInput.bind(action);
        action.validateInput = (rawInput: unknown) =>
          whereDepthExceeded(rawInput)
            ? {
                success: false as const,
                errors: [
                  {
                    path: "where",
                    message: `Filter nesting exceeds ${MAX_WHERE_DEPTH} levels`,
                  },
                ],
              }
            : innerValidateInput(rawInput);
        api[operation] = action;
      }
      service.contributePreparation({
        name: `crud:${resource.name}`,
        describe: () => ({
          plugin: "@brickkit/crud",
          resource: resource.name,
          operations: Object.keys(api),
          inputs: Object.fromEntries(
            Object.keys(api).map((operation) => [
              operation,
              inputs[operation as Operation | BulkOperation],
            ]),
          ),
          outputs: Object.fromEntries(
            Object.keys(api).map((operation) => [
              operation,
              outputs[operation as Operation | BulkOperation],
            ]),
          ),
          defaultLimit,
          maxLimit,
          cacheLimit: 128,
        }),
        prepare: () => {
          const db: any = service.getDb();
          if (
            !db?.$client?.prepare ||
            (options.access !== "public" && options.access.scope) ||
            Object.values(columns).some(
              (column) => column.defaultFn || column.onUpdateFn,
            )
          )
            return;
          let cache = prepared.get(db);
          if (!cache) {
            cache = new Map();
            prepared.set(db, cache);
          }
          const dbProjection = readable.length
            ? projection
            : { __brickSentinel: idColumn };
          if (api.list)
            cache.set(
              JSON.stringify(["list", "rows", [], readable, undefined]),
              db
                .select(dbProjection)
                .from(resource.table)
                .limit(sql.placeholder("p0"))
                .offset(sql.placeholder("p1"))
                .prepare(),
            );
          if (api.get)
            cache.set(
              JSON.stringify(["get", "rows", [], readable, undefined]),
              db
                .select(dbProjection)
                .from(resource.table)
                .where(eq(idColumn, sql.placeholder("p0")))
                .limit(sql.placeholder("p1"))
                .offset(sql.placeholder("p2"))
                .prepare(),
            );
        },
      });
      return api;
    },
  });
  return descriptor as CrudPlugin<F, O>;
}
