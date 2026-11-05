import { defineResourcePlugin, t, setActionAccess } from "@brickkit/core";
import { type TSchema } from "@sinclair/typebox";
import { getTableColumns, type Column } from "drizzle-orm";

import { checkJsonSchema, columnSchema, object } from "./codec";
import { bulkOperations, operations } from "./perform";
import { CACHE_LIMIT } from "./statement";
import type {
  BulkOperation,
  CrudOptions,
  CrudPlugin,
  Fields,
  Operations,
  Operation,
} from "./types";
import {
  MAX_WHERE_DEPTH,
  checkFilters,
  whereDepthExceeded,
  whereSchema,
} from "./where";
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
      const fields: Fields = options.fields;
      const schemas: Record<string, TSchema> = {};
      const readable = Object.keys(fields).filter(
        (key) => fields[key].read && !fields[key].resolve,
      );
      const includable = Object.keys(fields).filter(
        (key) => fields[key].resolve,
      );
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
          if (Object.hasOwn(columns, key))
            throw new Error(
              `Derived CRUD field '${key}' cannot replace a table column`,
            );
          schemas[key] = policy.schema;
          checkJsonSchema(schemas[key]);
          continue;
        }
        if (!Object.hasOwn(columns, key))
          throw new Error(`Unknown CRUD field '${key}' on '${resource.name}'`);
        schemas[key] = policy.schema ?? columnSchema(columns[key]);
        checkJsonSchema(schemas[key]);
        if (columns[key] === resource.id && policy.update)
          throw new Error("CRUD primary key cannot be updated");
        checkFilters(key, columns[key], policy.filter ?? []);
        if (
          policy.sort &&
          !["string", "number", "date", "bigint", "boolean"].includes(
            columns[key].dataType,
          )
        )
          throw new Error(`Sorting is unsupported for '${key}'`);
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
      const where = whereSchema(resource.name, fields, schemas);
      const selection = t.Optional(
        t.Array(fieldLiteral(readable), { minItems: 1, uniqueItems: true }),
      );
      const includes = t.Optional(
        t.Array(fieldLiteral(includable), { uniqueItems: true }),
      );
      const queryProperties = {
        select: selection,
        include: includes,
        where: t.Optional(where),
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
      const rowFields = Object.fromEntries(
        [...readable, ...includable].map((key) => {
          const schema =
            fields[key].schema ??
            (fields[key].scrub ? t.Unknown() : schemas[key]);
          return [key, fields[key].resolve ? t.Optional(schema) : schema];
        }),
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
        findOne: object(queryProperties),
        get: object({ id: idSchema, select: selection, include: includes }),
        create: createSchema,
        update: object({ id: idSchema, data: updateSchema }),
        delete: object({ id: idSchema }),
        count: object({ where: t.Optional(where) }),
        exists: object({ where: t.Optional(where) }),
        bulkCreate: object({ items: batch(createSchema) }),
        bulkUpdate: object({
          items: batch(object({ id: idSchema, data: updateSchema })),
        }),
        bulkDelete: object({ ids: batch(idSchema, true) }),
      };
      const outputsFor = (
        row: TSchema,
      ): Record<Operation | BulkOperation, TSchema> => ({
        list: object({
          items: t.Array(row),
          total: t.Optional(t.Integer()),
          limit: t.Integer(),
          offset: t.Integer(),
          nextCursor: t.Optional(t.Union([t.String(), t.Null()])),
        }),
        findOne: t.Union([row, t.Null()]),
        get: row,
        create: row,
        update: row,
        delete: object({ success: t.Literal(true) }),
        count: object({ count: t.Integer() }),
        exists: object({ exists: t.Boolean() }),
        bulkCreate: object({ items: t.Array(row) }),
        bulkUpdate: object({ items: t.Array(row) }),
        bulkDelete: object({ count: t.Integer() }),
      });
      // Contract rows require parent fields, and derived fields are optional.
      // This is what ships in `config.output` for the browser contract and OpenAPI.
      const outputs = outputsFor(object(rowFields));
      // Runtime validation must still accept subset projections (`select`),
      // so every field is optional there. It never leaks into generated types.
      const looseOutputs = outputsFor(
        object(
          Object.fromEntries(
            Object.entries(rowFields).map(([key, schema]) => [
              key,
              t.Optional(schema),
            ]),
          ),
        ),
      );
      const { perform, performBulk, prewarm } = operations({
        options,
        resource,
        service,
        fields,
        columns,
        readable,
        defaultLimit,
      });
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
          hasAuthorize: !crudIsPublic,
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
        // Runtime output validation accepts subset projections while the
        // published `config.output` stays strict for contracts/OpenAPI.
        action.outputValidationSchema = looseOutputs[operation];
        setActionAccess(action, crudAccess);
        // Pre-validation depth guard: action input validation runs before
        // execute()/condition(), so reject over-nested `where` here instead
        // of recursing inside the compiled TypeBox check.
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
          cacheLimit: CACHE_LIMIT,
        }),
        prepare: () =>
          prewarm(
            (["list", "get"] as const).filter((operation) => api[operation]),
          ),
      });
      return api;
    },
  });
  return descriptor as CrudPlugin<F, O>;
}
