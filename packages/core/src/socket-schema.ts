import { Kind, TransformKind, type TSchema } from "@sinclair/typebox";

const kinds = new Set([
  "Array",
  "Boolean",
  "Integer",
  "Intersect",
  "Literal",
  "Never",
  "Null",
  "Number",
  "Object",
  "Ref",
  "Record",
  "String",
  "This",
  "Tuple",
  "Union",
]);

/** Keep validators browser-safe and reject schemas whose behavior cannot cross JSON. */
export function serializeSocketSchema(
  schema: TSchema,
  path = "schema",
): unknown {
  const visit = (value: unknown, at: string): unknown => {
    if (Array.isArray(value))
      return value.map((child, i) => visit(child, `${at}[${i}]`));
    if (!value || typeof value !== "object") return value;
    if (TransformKind in value)
      throw new Error("Socket schemas cannot contain transforms");
    const entries = Object.entries(value).map(([key, child]) => [
      key,
      visit(child, `${at}.${key}`),
    ]);
    if (Kind in value) {
      if (typeof value[Kind] !== "string" || !kinds.has(value[Kind]))
        throw new Error(
          `Socket schemas must describe JSON values (got kind "${String(value[Kind])}" at ${at}); use t.Json() for any JSON value`,
        );
      if ("format" in value || "__brick_kind" in value)
        throw new Error(
          "Socket schemas cannot contain formats or reserved __brick_kind annotations",
        );
      entries.push(["__brick_kind", value[Kind]]);
    }
    return Object.fromEntries(entries);
  };
  return visit(schema, path);
}

export function restoreSocketSchema(value: unknown): TSchema {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const kind =
      "__brick_kind" in node &&
      typeof node.__brick_kind === "string" &&
      kinds.has(node.__brick_kind)
        ? node.__brick_kind
        : undefined;
    const result = Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => !kind || key !== "__brick_kind")
        .map(([key, child]) => [key, visit(child)]),
    );
    if (kind) Object.defineProperty(result, Kind, { value: kind });
    return result;
  };
  const schema = visit(value);
  if (!schema || typeof schema !== "object" || !(Kind in schema))
    throw new Error("Invalid socket contract schema");
  // Only generated, checked schema descriptions reach this boundary.
  return schema as TSchema;
}
