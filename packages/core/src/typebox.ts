import {
  Type as TypeBox,
  type SchemaOptions,
  type TSchema,
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

/** TypeBox's `Type` plus Brick helpers such as `Json()`. */
// TypeBox's `Type` is a module namespace at runtime, so its functions copy over.
export const Type = Object.assign({}, TypeBox, { Json });
export { Type as t };
export type { TSchema, Static };

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
