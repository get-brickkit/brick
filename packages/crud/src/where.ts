import { t } from "@brickkit/core";
import { Type, type TSchema } from "@sinclair/typebox";
import {
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
  sql,
} from "drizzle-orm";

import { databaseValue, invalid, object } from "./codec";
import type { Fields, FilterOperator } from "./types";

type Operator = {
  /** What a leaf's `value` holds. */
  operand: "none" | "one" | "list" | "pair";
  /** Needs a column whose values sort. */
  ordered?: true;
  /** Needs a string column. */
  text?: true;
  /** The condition, given a function that binds one value for the column. */
  build: (column: Column, value: any, bind: (value: unknown) => any) => SQL;
};
const like = (column: Column, pattern: string, bind: (value: unknown) => any) =>
  sql`${column} LIKE ${bind(pattern)} ESCAPE '\\'`;
const escape = (value: unknown) => String(value).replace(/[\\%_]/g, "\\$&");

/** Every filter operator: the `FilterOperator` type, validation and SQL all come from here. */
export const OPERATORS = {
  eq: { operand: "one", build: (c, v, bind) => eq(c, bind(v)) },
  ne: { operand: "one", build: (c, v, bind) => ne(c, bind(v)) },
  in: { operand: "list", build: (c, v, bind) => inArray(c, v.map(bind)) },
  notIn: {
    operand: "list",
    build: (c, v, bind) => notInArray(c, v.map(bind)),
  },
  gt: { operand: "one", ordered: true, build: (c, v, bind) => gt(c, bind(v)) },
  gte: {
    operand: "one",
    ordered: true,
    build: (c, v, bind) => gte(c, bind(v)),
  },
  lt: { operand: "one", ordered: true, build: (c, v, bind) => lt(c, bind(v)) },
  lte: {
    operand: "one",
    ordered: true,
    build: (c, v, bind) => lte(c, bind(v)),
  },
  between: {
    operand: "pair",
    ordered: true,
    build: (c, v, bind) => between(c, bind(v[0]), bind(v[1])),
  },
  contains: {
    operand: "one",
    text: true,
    build: (c, v, bind) => like(c, `%${escape(v)}%`, bind),
  },
  startsWith: {
    operand: "one",
    text: true,
    build: (c, v, bind) => like(c, `${escape(v)}%`, bind),
  },
  endsWith: {
    operand: "one",
    text: true,
    build: (c, v, bind) => like(c, `%${escape(v)}`, bind),
  },
  isNull: { operand: "none", build: (c) => isNull(c) },
  isNotNull: { operand: "none", build: (c) => isNotNull(c) },
} as const satisfies Record<string, Operator>;
const operator = (name: string): Operator | undefined =>
  Object.hasOwn(OPERATORS, name)
    ? OPERATORS[name as FilterOperator]
    : undefined;

/** Throws when a field's filter operators do not fit its column. */
export function checkFilters(
  key: string,
  column: Column,
  operators: readonly string[],
): void {
  for (const name of operators) {
    const op = operator(name);
    if (!op) throw new Error(`Unknown filter operator '${name}'`);
    if (op.text && column.dataType !== "string")
      throw new Error(
        `Text filter '${name}' requires a string column '${key}'`,
      );
    if (
      op.ordered &&
      !["string", "number", "date", "bigint"].includes(column.dataType)
    )
      throw new Error(`Ordered filter '${name}' is unsupported for '${key}'`);
    if (
      op.operand !== "none" &&
      ["json", "array", "buffer", "custom"].includes(column.dataType)
    )
      throw new Error(`Filter '${name}' is unsupported for '${key}'`);
  }
}

/** The `where` input schema: field leaves plus recursive `and`/`or` branches. */
export function whereSchema(
  resourceName: string,
  fields: Fields,
  schemas: Record<string, TSchema>,
): TSchema {
  // Named where leaves: one union schema per filterable field plus named
  // `and`/`or` branches. The client-contract generator only emits aliases
  // for schemas reached via $ref (using `title ?? $id`), so anonymous
  // leaves degrade to hash names. Each field union is imported by $ref
  // from a module: TypeBox hoists every $id subschema into a shared
  // check function, so compilation stays linear. Union nesting is
  // associative, so validation accepts exactly the same inputs.
  const whereId = `CrudWhere:${resourceName}`;
  const whereTitle = (suffix: string) => `Where:${resourceName}:${suffix}`;
  const whereFields: Record<string, TSchema> = {};
  for (const [field, policy] of Object.entries(fields)) {
    const operators = policy.filter ?? [];
    if (!operators.length) continue;
    if (field === "and" || field === "or")
      throw new Error(
        `CRUD filter field '${field}' on '${resourceName}' collides with the '${field}' branch`,
      );
    const valueSchema = Type.Exclude(schemas[field], t.Null());
    const operands: Record<Operator["operand"], Record<string, TSchema>> = {
      none: {},
      one: { value: valueSchema },
      list: { value: t.Array(valueSchema, { minItems: 1, maxItems: 1000 }) },
      pair: { value: t.Tuple([valueSchema, valueSchema]) },
    };
    whereFields[`${whereId}:${field}`] = t.Union(
      operators.map((op) =>
        object({
          field: t.Literal(field),
          op: t.Literal(op),
          ...operands[OPERATORS[op].operand],
        }),
      ),
      { title: whereTitle(field) },
    );
  }
  if (!Object.keys(whereFields).length) return t.Never();
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
  // `validateInput` wrapper rejects it before validation runs.
  // The Recursive callback ignores Self on purpose: recursion flows
  // through the named module $refs back to this root $id.
  return t.Recursive(
    () =>
      t.Union([
        ...Object.keys(whereFields).map((id) => whereModule.Import(id)),
        whereModule.Import(`${whereId}:and`),
        whereModule.Import(`${whereId}:or`),
      ]),
    { $id: whereId },
  );
}

export const MAX_WHERE_DEPTH = 20;
// Iterative pre-validation depth walk over raw `where` input. The action
// input validator runs before execute()/condition(), so unbounded `and`/`or`
// nesting would recurse inside the compiled TypeBox check first — past the
// call-stack limit it throws RangeError (HTTP 500) instead of a 400. This
// keeps rejection O(nesting) with constant stack on every entry path.
export function whereDepthExceeded(input: unknown): boolean {
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

/** The SQL for a validated `where`, its values bound and its shape recorded on `query`. */
export function condition(
  node: any,
  columns: Record<string, Column>,
  query: { bind: (value: unknown) => any; shape: unknown[] },
  depth = 0,
): SQL {
  if (depth > MAX_WHERE_DEPTH)
    invalid(`Filter nesting exceeds ${MAX_WHERE_DEPTH} levels`);
  if (node.and) {
    query.shape.push("and", node.and.length);
    return and(
      ...node.and.map((n: any) => condition(n, columns, query, depth + 1)),
    )!;
  }
  if (node.or) {
    query.shape.push("or", node.or.length);
    return or(
      ...node.or.map((n: any) => condition(n, columns, query, depth + 1)),
    )!;
  }
  const column = columns[node.field];
  query.shape.push(node.field, node.op);
  const op = operator(node.op);
  if (!op) return invalid("Unknown filter operator");
  if (op.operand === "list") query.shape.push(node.value.length);
  return op.build(column, node.value, (value) =>
    query.bind(databaseValue(column, value)),
  );
}
