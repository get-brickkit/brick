import { buildErrorHelpers, columnValue, t } from "@brickkit/core";
import { FormatRegistry, Kind, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Column } from "drizzle-orm";

const isoPattern =
  "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$";
if (!FormatRegistry.Has("date-time"))
  FormatRegistry.Set(
    "date-time",
    (value) =>
      new RegExp(isoPattern).test(value) && Number.isFinite(Date.parse(value)),
  );
export function jsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return value.map(jsonValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonValue(item)]),
    );
  return value;
}
/** `columnValue`, with a string the column can't hold rejected as a bad request. */
export function databaseValue(column: Column, value: unknown): unknown {
  const stored = columnValue(column, value);
  return stored === undefined && value !== undefined
    ? invalid(`Invalid value for column '${column.name}'`)
    : stored;
}
export function checkJsonSchema(
  schema: TSchema,
  seen = new Set<object>(),
): void {
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
export function columnSchema(column: Column): TSchema {
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
export function object(properties: Record<string, TSchema>) {
  return t.Object(properties, { additionalProperties: false });
}
/** Core's standard error helpers, for code that runs outside an action's `execute`. */
export const errors = buildErrorHelpers();
export const invalid = (message: string): never => errors.BAD_REQUEST(message);
/** An opaque list cursor: the orderBy it was made for, and the last row's sort values. */
export function encodeCursor(spec: string, values: unknown[]): string {
  return Buffer.from(JSON.stringify([spec, values.map(jsonValue)])).toString(
    "base64url",
  );
}
/** The sort values a client cursor holds, checked against the columns they bind to. */
export function decodeCursor(
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
