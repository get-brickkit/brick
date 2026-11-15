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

export const isSensitive = (schema: any): boolean =>
  schema?.[SENSITIVE] === true;

/** Any key of an object (`null`), or any key but its declared properties (`{ except }`). */
type Segment = string | null | { except: string[] };

/** A marked node: the property names that lead to it. */
interface SensitivePath {
  segments: Segment[];
  /** Whether the node can be removed without breaking the schema: an optional property or a record value. */
  optional: boolean;
}

interface Analysis {
  paths: SensitivePath[];
  /** Pointers of the unmarked required properties, to catch a mark that another union branch requires. */
  required: Set<string>;
  /** Where a `$ref` would leave a mark half-followed or unseen. */
  ref?: string;
}

/** What the walk notes besides the paths: the `$id`s around a mark, and where each `$ref` is. */
interface Walk extends Analysis {
  markedIds: Set<string>;
  loops: Map<string, string>;
  external?: string;
}

const analyses = new WeakMap<object, Analysis>();

function analyze(schema: unknown): Analysis {
  if (!schema || typeof schema !== "object")
    return { paths: [], required: new Set() };
  let analysis = analyses.get(schema);
  if (!analysis) {
    const walk: Walk = {
      paths: [],
      required: new Set(),
      markedIds: new Set(),
      loops: new Map(),
    };
    collect(schema, [], false, [], walk);
    analysis = { paths: walk.paths, required: walk.required };
    if (walk.paths.length)
      analysis.ref =
        walk.external ??
        [...walk.markedIds].map((id) => walk.loops.get(id)).find(Boolean);
    analyses.set(schema, analysis);
  }
  return analysis;
}

/** The marked nodes of a schema, worked out once per schema object. */
export function sensitivePaths(schema: unknown): SensitivePath[] {
  return analyze(schema).paths;
}

// shortcut: `$ref` is not followed: `sensitivity` throws for a mark inside a `t.Recursive`
// or beside a `t.Ref`. Follow `$ref`/`$id` when an app needs a sensitive field there.
function collect(
  schema: any,
  segments: Segment[],
  optional: boolean,
  ids: string[],
  walk: Walk,
): void {
  if (!schema || typeof schema !== "object") return;
  if (isSensitive(schema)) {
    walk.paths.push({ segments, optional });
    for (const id of ids) walk.markedIds.add(id);
    return;
  }
  if (typeof schema.$ref === "string") {
    if (!ids.includes(schema.$ref)) walk.external ??= pointer(segments);
    else if (!walk.loops.has(schema.$ref))
      walk.loops.set(schema.$ref, pointer(segments));
  }
  if (typeof schema.$id === "string") ids = [...ids, schema.$id];
  // shortcut: union branches are walked by path, so a mark in one branch removes the same path from all;
  // check which branch the value matched when a union needs the same name both secret and public.
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.allOf ?? []),
    ...(schema.oneOf ?? []),
  ])
    collect(branch, segments, optional, ids, walk);
  const declared = Object.keys(schema.properties ?? {});
  for (const key of declared) {
    const child = schema.properties[key];
    const required = !!schema.required?.includes(key);
    if (required && !isSensitive(child))
      walk.required.add(pointer([...segments, key]));
    collect(child, [...segments, key], !required, ids, walk);
  }
  // A record under `minProperties` cannot lose a value and stay valid.
  const removable = !(schema.minProperties > 0);
  for (const child of Object.values(schema.patternProperties ?? {}))
    collect(child, [...segments, null], removable, ids, walk);
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === "object"
  )
    collect(
      schema.additionalProperties,
      [...segments, declared.length ? { except: declared } : null],
      removable,
      ids,
      walk,
    );
  if (Array.isArray(schema.items))
    schema.items.forEach((child: unknown, index: number) =>
      collect(child, [...segments, String(index)], false, ids, walk),
    );
  else if (schema.type === "array")
    collect(schema.items, [...segments, null], false, ids, walk);
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

const pointer = (segments: Segment[]) =>
  segments.map((key) => `/${typeof key === "string" ? key : "*"}`).join("") ||
  "/";

/** The JSON pointer of a schema's first sensitive mark, if it has one. */
export function sensitivePointer(schema: unknown): string | undefined {
  const [first] = sensitivePaths(schema);
  return first && pointer(first.segments);
}

const escape = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

const keysAt = (value: object, segment: Segment): string[] =>
  segment === null
    ? Object.keys(value)
    : typeof segment === "object"
      ? Object.keys(value).filter((key) => !segment.except.includes(key))
      : Object.hasOwn(value, segment)
        ? [segment]
        : [];

/** Each value at a path: its parent, its key, and its JSON pointer. */
function* found(
  value: any,
  segments: Segment[],
  index = 0,
  at = "",
): Generator<[parent: any, key: string, field: string]> {
  if (value === null || typeof value !== "object") return;
  for (const key of keysAt(value, segments[index]!)) {
    const field = `${at}/${escape(key)}`;
    if (index === segments.length - 1) yield [value, key, field];
    else yield* found(value[key], segments, index + 1, field);
  }
}

/** `value` without the hidden fields, copying only the objects on the way to one. */
function omit(
  value: any,
  segments: Segment[],
  hidden: Set<string>,
  index = 0,
  at = "",
): unknown {
  if (value === null || typeof value !== "object") return value;
  let copy: any;
  for (const key of keysAt(value, segments[index]!)) {
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

export type Reveal<TInput = unknown, TContext = any> =
  | boolean
  | ((args: {
      field: string;
      input: TInput;
      ctx: TContext;
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
 * @param service - The owning service's name, for the error message, when known.
 * @throws When a mark cannot be kept: an output field removed although its
 * schema requires it (unless `reveal` is `true`), or a mark a `$ref` would
 * leave half-followed.
 */
export function sensitivity(
  config: {
    name: string;
    input?: unknown;
    output?: unknown;
    reveal?: Reveal<any>;
  },
  service?: string,
): Sensitivity | undefined {
  const input = analyze(config.input);
  const output = analyze(config.output);
  const inputs = input.paths;
  const outputs = output.paths;
  if (!inputs.length && !outputs.length) return undefined;
  const owner = service
    ? `Service '${service}' action '${config.name}'`
    : `Action '${config.name}'`;
  for (const [kind, { ref }] of [
    ["input", input],
    ["output", output],
  ] as const)
    if (ref !== undefined)
      throw new Error(
        `${owner}: the ${kind} schema marks a field t.Sensitive and has a $ref at '${ref}' (t.Recursive or t.Ref), which sensitive fields do not follow; move the secret out of the recursive or referenced schema`,
      );
  const { reveal = false } = config;
  if (reveal !== true)
    for (const path of outputs) {
      const at = pointer(path.segments);
      if (!path.optional || output.required.has(at))
        throw new Error(
          `${owner}: sensitive output field '${at}' is removed unless \`reveal\` allows it, so the schema must let it be absent: make it t.Optional in every union or intersect branch, not an array item nor a record value under minProperties (or set \`reveal: true\`)`,
        );
    }
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
          if (
            typeof reveal !== "function" ||
            (await reveal({ field, input, ctx })) !== true
          )
            hidden.add(field);
        if (hidden.size) result = omit(result, segments, hidden);
      }
      return result;
    },
  };
}

/**
 * Below this length a value is not redacted from log text: a short value such
 * as `"42"` or `"true"` would blank out unrelated parts of every line. A log
 * argument equal to it is still redacted.
 */
const MIN_REDACTED_LENGTH = 8;
/**
 * The most values one set holds. A nested call joins the enclosing set, so a
 * timer started inside a sensitive call can keep adding to it; past this, the
 * set withholds whole lines rather than forget a value.
 */
const MAX_REDACTED_VALUES = 1000;
const REDACTED = "[REDACTED]";
const WITHHELD = "[REDACTED: too many sensitive values in this call]";

interface Redactions {
  values: Set<string>;
  /** The values for the text pass, longest first; dropped when a value is added. */
  sorted?: string[];
  /** Set when a value did not fit: every line is then withheld. */
  full?: boolean;
}

// Shared by name, like the marker, so a second copy of core sees the same call's set.
const redactions = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("brickkit.redactions")
] ??= new AsyncLocalStorage<Redactions>()) as AsyncLocalStorage<Redactions>;

function add(set: Redactions, value: string): void {
  if (set.values.has(value)) return;
  if (set.values.size >= MAX_REDACTED_VALUES) {
    if (!set.full)
      console.warn(
        `[brick] A call's redaction set reached ${MAX_REDACTED_VALUES} values, so its log lines are now withheld. A timer or task started inside a call with t.Sensitive fields joins that call's set.`,
      );
    set.full = true;
    return;
  }
  set.values.add(value);
  set.sorted = undefined;
}

/**
 * Keep a secret out of what Brick logs and traces for the rest of the running
 * call: the logger, the span recorder and error responses replace it with
 * `[REDACTED]`. Call it as soon as `execute` loads a secret, before it can be
 * logged. Outside a call with `t.Sensitive` fields it does nothing.
 */
export function redact(value: string): void {
  const set = redactions.getStore();
  if (!set || !value) return;
  add(set, value);
  // As it appears inside a JSON or inspected string, when that differs.
  const quoted = JSON.stringify(value).slice(1, -1);
  if (quoted !== value) add(set, quoted);
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
  const set = redactions.getStore();
  return !!set && (set.full || set.values.size > 0);
}

/** `text` with the running call's redacted values replaced. */
export function redactText(text: string): string {
  const set = redactions.getStore();
  if (!set) return text;
  if (set.full) return WITHHELD;
  // Longest first, so a value that contains another is replaced whole.
  set.sorted ??= [...set.values]
    .filter((value) => value.length >= MIN_REDACTED_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const value of set.sorted)
    if (text.includes(value)) text = text.split(value).join(REDACTED);
  return text;
}

/** Deeper than `util.inspect` prints for a log line (depth 3), so every printed leaf is seen. */
const LEAF_DEPTH = 5;

/**
 * Values as they are about to be formatted, with each string or number that
 * equals a redacted value (at any length) replaced, and each string that
 * contains one passed through `redactText`. Walks plain objects, arrays, `Map`
 * and `Set`, copying only what changes; other objects are left to the text pass.
 */
export function redactValues<T>(value: T): T {
  const set = redactions.getStore();
  if (!set || (!set.full && !set.values.size)) return value;
  const seen = new Map<object, unknown>();
  const visit = (value: any, depth: number): any => {
    if (typeof value === "string")
      return set.values.has(value) ? REDACTED : redactText(value);
    if (typeof value === "number" || typeof value === "bigint")
      return set.values.has(String(value)) ? REDACTED : value;
    if (!value || typeof value !== "object" || depth > LEAF_DEPTH) return value;
    if (seen.has(value)) return seen.get(value);
    seen.set(value, value);
    let copy: any = value;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const next = visit(item, depth + 1);
        if (next === item) return;
        if (copy === value) copy = [...value];
        copy[index] = next;
      });
    } else if (value instanceof Map || value instanceof Set) {
      // A Map's entries are [key, value] arrays, walked as arrays.
      const items = [...value];
      const next = items.map((item) => visit(item, depth + 1));
      if (next.some((item, index) => item !== items[index]))
        copy = value instanceof Map ? new Map(next) : new Set(next);
    } else {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value;
      for (const key of Object.keys(value)) {
        const next = visit(value[key], depth + 1);
        if (next === value[key]) continue;
        if (copy === value) copy = Object.assign(Object.create(proto), value);
        copy[key] = next;
      }
    }
    seen.set(value, copy);
    return copy;
  };
  return visit(value, 0);
}

/**
 * Run a call with a redaction set: its own, or the enclosing call's so that
 * values stay redacted for as long as the outermost call runs. An error that
 * leaves the set has its messages and stacks redacted, since whoever logs it
 * next is outside the call.
 */
export async function withRedaction<T>(fn: () => Promise<T>): Promise<T> {
  if (redactions.getStore()) return fn();
  const set: Redactions = { values: new Set() };
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
        if ("details" in e) e.details = redactValues(e.details);
      }
    });
    throw err;
  }
}
