import {
  Kind,
  Type as TypeBox,
  TypeRegistry,
  type SchemaOptions,
  type TArray,
  type TSchema,
  type TUnsafe,
  type Static,
} from "@sinclair/typebox";
import { TypeCompiler, type TypeCheck } from "@sinclair/typebox/compiler";
import type { ValidationErrorItem } from "./types";

/**
 * Any JSON value: null, boolean, number, string, or an array or object of
 * JSON values.
 */
function Json(options?: SchemaOptions) {
  return TypeBox.Recursive(
    (This) =>
      TypeBox.Union([
        TypeBox.Null(),
        TypeBox.Boolean(),
        TypeBox.Number(),
        TypeBox.String(),
        TypeBox.Array(This),
        TypeBox.Record(TypeBox.String(), This),
      ]),
    options,
  );
}

export interface FileOptions {
  /** The largest file accepted, in bytes. Also caps the request body before it is read. */
  maxSize?: number;
  description?: string;
}

TypeRegistry.Set<{ maxSize?: number }>(
  "File",
  (schema, value) =>
    value instanceof Blob && !(value.size > (schema.maxSize ?? Infinity)),
);

/** A file from a `multipart/form-data` body: a `File` (a `Blob`), at most `maxSize` bytes. */
function File(options: FileOptions = {}): TUnsafe<File> {
  return TypeBox.Unsafe<File>({
    [Kind]: "File",
    type: "string",
    format: "binary",
    ...options,
  });
}

/** Several files under one form field. */
function Files(
  options: FileOptions & { minItems?: number; maxItems?: number } = {},
): TArray<TUnsafe<File>> {
  const { minItems, maxItems, ...file } = options;
  return TypeBox.Array(File(file), { minItems, maxItems });
}

/** TypeBox's `Type` plus Brick's `Json`, `File` and `Files`. */
// TypeBox's `Type` is a module namespace at runtime, so its functions copy over.
export const Type = Object.assign({}, TypeBox, { Json, File, Files });
export { Type as t };
export type { TSchema, Static };

/**
 * The file fields of an object schema, each with the most bytes it may carry
 * (`Infinity` when it declares no `maxSize`, or a `t.Files` no `maxItems`).
 */
export function fileFields(schema: unknown): { key: string; bytes: number }[] {
  const fields = [];
  const properties = (schema as { properties?: Record<string, any> })
    ?.properties;
  for (const [key, prop] of Object.entries(properties ?? {})) {
    const file = prop[Kind] === "File" ? prop : prop.items;
    if (file?.[Kind] !== "File") continue;
    const count = file === prop ? 1 : (prop.maxItems ?? Infinity);
    fields.push({ key, bytes: (file.maxSize ?? Infinity) * count });
  }
  return fields;
}

const compilerCache = new WeakMap<TSchema, TypeCheck<TSchema>>();

/**
 * The compiled validator for a TypeBox schema. Compiling is slow and checking
 * is fast, so each schema is compiled once and kept for as long as the schema
 * object lives.
 *
 * @param schema - A TypeBox schema.
 * @returns Its `TypeCheck`, with `Check(value)` and `Errors(value)`.
 */
export function getCompiledCheck<T extends TSchema>(schema: T): TypeCheck<T> {
  let compiled = compilerCache.get(schema) as TypeCheck<T> | undefined;
  if (!compiled) {
    compiled = TypeCompiler.Compile(schema);
    compilerCache.set(schema, compiled);
  }
  return compiled;
}

/**
 * Check a value against a schema, the way actions check their input and output.
 *
 * @param schema - A TypeBox schema, or `undefined` to accept anything.
 * @param value - The value to check.
 * @returns `{ success: true, data }`, or `{ success: false, errors }` with a
 * `path`, `message`, `type`, and the offending `value` for each problem.
 */
export function validateWithSchema<T extends TSchema>(
  schema: T | undefined,
  value: unknown,
):
  | { success: true; data: Static<T> }
  | { success: false; errors: ValidationErrorItem[] } {
  if (!schema) {
    return { success: true, data: value as Static<T> };
  }

  const check = getCompiledCheck(schema);
  if (check.Check(value)) {
    return { success: true, data: value as Static<T> };
  }

  const errors: ValidationErrorItem[] = [];
  for (const error of check.Errors(value)) {
    errors.push({
      path: error.path,
      message: error.message,
      value: error.value,
      type: error.type,
    });
  }

  return { success: false, errors };
}
