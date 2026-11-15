import { AsyncLocalStorage } from "node:async_hooks";
import type { TSchema } from "@sinclair/typebox";

/*
 * Sensitive fields: `t.Sensitive(schema)` marks part of an input or output
 * schema. The pipeline removes marked output fields unless `reveal` allows
 * them, and the values at marked paths join the call's redaction set, which
 * the logger and the span recorder apply before anything is printed or kept.
 */

// Shared by name, so a second copy of core recognizes the marker.
const SENSITIVE = Symbol.for("brickkit.sensitive");

/** The schema, unchanged in type and validation, marked sensitive. */
export function Sensitive<T extends TSchema>(schema: T): T {
  return { ...schema, [SENSITIVE]: true };
}

const isSensitive = (schema: any): boolean => schema?.[SENSITIVE] === true;

/** A marked node: the property names that lead to it (`null` for any array index or record key). */
interface SensitivePath {
  segments: (string | null)[];
  /** Whether the node can be absent: an optional property or a record value. */
  optional: boolean;
}

const pathCache = new WeakMap<object, SensitivePath[]>();

/** The marked nodes of a schema, worked out once per schema object. */
export function sensitivePaths(schema: unknown): SensitivePath[] {
  if (!schema || typeof schema !== "object") return [];
  let paths = pathCache.get(schema);
  if (!paths) {
    paths = [];
    collect(schema, [], false, paths);
    pathCache.set(schema, paths);
  }
  return paths;
}

// shortcut: `t.Recursive` and `$ref` schemas are not followed, so a mark inside one
// is ignored; follow `$ref`/`$id` when an app needs a sensitive field in a recursive schema.
function collect(
  schema: any,
  segments: (string | null)[],
  optional: boolean,
  out: SensitivePath[],
): void {
  if (!schema || typeof schema !== "object") return;
  if (isSensitive(schema)) {
    out.push({ segments, optional });
    return;
  }
  // shortcut: union branches are walked by path, so a mark in one branch removes the same path from all;
  // check which branch the value matched when a union needs the same name both secret and public.
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.allOf ?? []),
    ...(schema.oneOf ?? []),
  ])
    collect(branch, segments, optional, out);
  for (const [key, child] of Object.entries(schema.properties ?? {}))
    collect(child, [...segments, key], !schema.required?.includes(key), out);
  for (const child of Object.values(schema.patternProperties ?? {}))
    collect(child, [...segments, null], true, out);
  if (Array.isArray(schema.items))
    schema.items.forEach((child: unknown, index: number) =>
      collect(child, [...segments, String(index)], false, out),
    );
  else if (schema.type === "array")
    collect(schema.items, [...segments, null], false, out);
}

/** Whether any part of a schema is marked sensitive. */
export function hasSensitive(schema: unknown): boolean {
  return sensitivePaths(schema).length > 0;
}

/** A copy of an input schema with `writeOnly` on its sensitive parts, for OpenAPI. */
export function writeOnly<T>(schema: T): T {
  if (!hasSensitive(schema)) return schema;
  const visit = (node: any): any => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    // A spread keeps TypeBox's symbol keys, which `fileFields` reads.
    const copy = { ...node };
    for (const key of Object.keys(copy)) copy[key] = visit(copy[key]);
    if (isSensitive(node)) copy.writeOnly = true;
    return copy;
  };
  return visit(schema);
}

const pointer = (segments: (string | null)[]) =>
  segments.map((key) => `/${key ?? "*"}`).join("") || "/";

const escape = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/** Each value at a path: its parent, its key, and its JSON pointer. */
function* found(
  value: any,
  segments: (string | null)[],
  index = 0,
  at = "",
): Generator<[parent: any, key: string, field: string]> {
  if (value === null || typeof value !== "object") return;
  const segment = segments[index];
  const keys =
    segment === null
      ? Object.keys(value)
      : Object.hasOwn(value, segment!)
        ? [segment!]
        : [];
  for (const key of keys) {
    const field = `${at}/${escape(key)}`;
    if (index === segments.length - 1) yield [value, key, field];
    else yield* found(value[key], segments, index + 1, field);
  }
}

/** `value` without the hidden fields, copying only the objects on the way to one. */
function omit(
  value: any,
  segments: (string | null)[],
  hidden: Set<string>,
  index = 0,
  at = "",
): unknown {
  if (value === null || typeof value !== "object") return value;
  const segment = segments[index];
  let copy: any;
  for (const key of segment === null ? Object.keys(value) : [segment!]) {
    if (!Object.hasOwn(value, key)) continue;
    const field = `${at}/${escape(key)}`;
    if (index === segments.length - 1) {
      if (!hidden.has(field)) continue;
      copy ??= Array.isArray(value) ? [...value] : { ...value };
      delete copy[key];
    } else {
      const next = omit(value[key], segments, hidden, index + 1, field);
      if (next === value[key]) continue;
      copy ??= Array.isArray(value) ? [...value] : { ...value };
      copy[key] = next;
    }
  }
  return copy ?? value;
}

export type Reveal =
  | boolean
  | ((args: {
      field: string;
      input: unknown;
      ctx: any;
    }) => boolean | Promise<boolean>);

/** What a call of an action with sensitive fields does besides its stages. */
export interface Sensitivity {
  /** Adds the validated input's sensitive values to the call's redaction set. */
  input(input: unknown): void;
  /** Redacts the output's sensitive values and removes those `reveal` refuses. */
  output(output: unknown, input: unknown, ctx: unknown): Promise<unknown>;
}

/**
 * The sensitive-field handling of an action, or `undefined` when its schemas
 * mark nothing, so such an action keeps its fast path.
 *
 * @throws When an output field is sensitive but required, unless `reveal` is
 * `true`: removing it would break the published contract.
 */
export function sensitivity(config: {
  name: string;
  input?: unknown;
  output?: unknown;
  reveal?: Reveal;
}): Sensitivity | undefined {
  const inputs = sensitivePaths(config.input);
  const outputs = sensitivePaths(config.output);
  if (!inputs.length && !outputs.length) return undefined;
  const { reveal = false } = config;
  if (reveal !== true)
    for (const path of outputs)
      if (!path.optional)
        throw new Error(
          `Action '${config.name}': sensitive output field '${pointer(path.segments)}' is removed unless \`reveal\` allows it, so it must be t.Optional (or set \`reveal: true\`)`,
        );
  const values = (value: unknown, paths: SensitivePath[]) => {
    const all: unknown[] = [];
    for (const { segments } of paths)
      if (!segments.length) all.push(value);
      else
        for (const [parent, key] of found(value, segments))
          all.push(parent[key]);
    return all;
  };
  return {
    input(input) {
      for (const value of values(input, inputs)) redactAll(value);
    },
    async output(output, input, ctx) {
      for (const value of values(output, outputs)) redactAll(value);
      if (reveal === true) return output;
      let result = output;
      for (const { segments } of outputs) {
        const hidden = new Set<string>();
        for (const [, , field] of found(output, segments))
          if (!reveal || !(await reveal({ field, input, ctx })))
            hidden.add(field);
        if (hidden.size) result = omit(result, segments, hidden);
      }
      return result;
    },
  };
}

/**
 * Below this length a value is not redacted from log text: a short value such
 * as `"42"` or `"true"` would blank out unrelated parts of every line.
 */
export const MIN_REDACTED_LENGTH = 8;
const REDACTED = "[REDACTED]";

const redactions = new AsyncLocalStorage<Set<string>>();

/**
 * Add a value to the running call's redaction set: until the call ends, the
 * logger and the span recorder replace it with `[REDACTED]`. Does nothing
 * outside a call that opened a set, or for a value shorter than
 * `MIN_REDACTED_LENGTH`.
 */
export function redact(value: string): void {
  const set = redactions.getStore();
  if (!set || value.length < MIN_REDACTED_LENGTH) return;
  set.add(value);
  // As it appears inside a JSON or inspected string, when that differs.
  const quoted = JSON.stringify(value).slice(1, -1);
  if (quoted !== value) set.add(quoted);
}

/** Every string and number in a value. */
function redactAll(value: unknown): void {
  if (typeof value === "string") redact(value);
  else if (typeof value === "number" || typeof value === "bigint")
    redact(String(value));
  else if (value && typeof value === "object")
    for (const child of Object.values(value)) redactAll(child);
}

/** Whether the running call has values to redact. */
export function redacting(): boolean {
  return !!redactions.getStore()?.size;
}

/** `text` with the running call's redacted values replaced. */
export function redactText(text: string): string {
  const set = redactions.getStore();
  if (!set?.size) return text;
  // Longest first, so a value that contains another is replaced whole.
  for (const value of [...set].sort((a, b) => b.length - a.length))
    text = text.split(value).join(REDACTED);
  return text;
}

/**
 * Run a call with a redaction set: its own, or the enclosing call's so that
 * values stay redacted for as long as the outermost call runs. An error that
 * leaves the set has its messages and stacks redacted, since whoever logs it
 * next is outside the call.
 */
export async function withRedaction<T>(fn: () => Promise<T>): Promise<T> {
  if (redactions.getStore()) return fn();
  const set = new Set<string>();
  try {
    return await redactions.run(set, fn);
  } catch (err) {
    redactions.run(set, () => {
      // A few levels of `cause`, which can form a cycle.
      for (
        let e: any = err, n = 0;
        e instanceof Error && n < 8;
        e = e.cause, n++
      ) {
        e.message = redactText(e.message);
        if (e.stack) e.stack = redactText(e.stack);
      }
    });
    throw err;
  }
}
