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
  /** The unmarked properties and array items, which a mark path that also matches them would remove. */
  publics: { segments: Segment[]; required: boolean }[];
  /** Where a `$ref` would leave a mark half-followed or unseen. */
  ref?: string;
  /** Where a mark sits under a keyword the walk does not follow, such as `$defs` or `not`. */
  hidden?: string;
}

/** What the walk notes besides the paths: the `$id`s around a mark, and where each `$ref` is. */
interface Walk extends Analysis {
  markedIds: Set<string>;
  loops: Map<string, string>;
  external?: string;
}

const analyses = new WeakMap<object, Analysis>();

function analyze(schema: unknown): Analysis {
  if (!schema || typeof schema !== "object") return { paths: [], publics: [] };
  let analysis = analyses.get(schema);
  if (!analysis) {
    const walk: Walk = {
      paths: [],
      publics: [],
      markedIds: new Set(),
      loops: new Map(),
    };
    collect(schema, [], false, [], walk);
    analysis = {
      paths: walk.paths,
      publics: walk.publics,
      hidden: walk.hidden,
    };
    if (walk.paths.length || walk.hidden)
      analysis.ref =
        walk.external ??
        [...walk.markedIds].map((id) => walk.loops.get(id)).find(Boolean);
    analyses.set(schema, analysis);
  }
  return analysis;
}

/** The marked nodes of a schema, worked out once per schema object. Every startup check reads this. */
export function sensitivePaths(schema: unknown): SensitivePath[] {
  return analyze(schema).paths;
}

/** Whether a schema node, or anything under it, is marked. */
const holdsMark = (node: unknown, seen = new Set<unknown>()): boolean => {
  if (!node || typeof node !== "object" || seen.has(node)) return false;
  seen.add(node);
  return (
    isSensitive(node) ||
    Object.values(node).some((child) => holdsMark(child, seen))
  );
};

// shortcut: `$ref` is not followed: `sensitivity` throws for a mark inside a `t.Recursive`,
// a `t.Module` or beside a `t.Ref`. Follow `$ref`/`$id` when an app needs a sensitive field there.
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
  const list = schema.type === "array" && !Array.isArray(schema.items);
  // A mark anywhere the walk does not go is not protected, so it is refused.
  for (const key of Object.keys(schema))
    if (
      !WALKED.has(key) ||
      (key === "items" && !list && !Array.isArray(schema.items))
    )
      if (holdsMark(schema[key])) walk.hidden ??= pointer([...segments, key]);
  // shortcut: union branches are walked by path, so a mark in one branch removes the same path from all;
  // check which branch the value matched when a union needs the same name both secret and public.
  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.allOf ?? []),
    ...(schema.oneOf ?? []),
  ])
    collect(branch, segments, optional, ids, walk);
  const declared = Object.keys(schema.properties ?? {});
  const required = new Set<string>(schema.required ?? []);
  // An object under `minProperties` can lose a property only if what it requires still meets it.
  const removable = !(
    schema.minProperties >
    declared.filter(
      (key) => required.has(key) && !isSensitive(schema.properties[key]),
    ).length
  );
  for (const key of declared) {
    const child = schema.properties[key];
    if (!isSensitive(child))
      walk.publics.push({
        segments: [...segments, key],
        required: required.has(key),
      });
    collect(
      child,
      [...segments, key],
      removable && !required.has(key),
      ids,
      walk,
    );
  }
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
  const before = walk.paths.length;
  const items: [unknown, Segment][] = Array.isArray(schema.items)
    ? schema.items.map((child: unknown, index: number) => [
        child,
        String(index),
      ])
    : list
      ? [[schema.items, null]]
      : [];
  for (const [child, segment] of items) {
    if (!isSensitive(child))
      walk.publics.push({ segments: [...segments, segment], required: true });
    collect(child, [...segments, segment], false, ids, walk);
  }
  // Two items that differ only in a removed field would be equal.
  if (schema.uniqueItems)
    for (const path of walk.paths.slice(before)) path.optional = false;
}

const WALKED = new Set([
  "anyOf",
  "allOf",
  "oneOf",
  "properties",
  "patternProperties",
  "additionalProperties",
  "items",
]);

/** Whether a segment matches an object key. */
const admits = (segment: Segment, key: string): boolean =>
  segment === null ||
  (typeof segment === "string"
    ? segment === key
    : !segment.except.includes(key));

/** Whether two segments can match the same key. */
const overlap = (a: Segment, b: Segment): boolean =>
  typeof a === "string"
    ? admits(b, a)
    : typeof b === "string"
      ? admits(a, b)
      : true;

/** Whether a value's top-level `key` is, or holds, a sensitive value. */
export const marksKey = (schema: unknown, key: string): boolean =>
  sensitivePaths(schema).some(
    ({ segments: [first] }) => first === undefined || admits(first, key),
  );

/** Whether any part of a schema is marked sensitive. */
export function hasSensitive(schema: unknown): boolean {
  const { paths, hidden } = analyze(schema);
  return paths.length > 0 || hidden !== undefined;
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
  const { paths, hidden } = analyze(schema);
  return paths[0] ? pointer(paths[0].segments) : hidden;
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
  if (!hasSensitive(config.input) && !hasSensitive(config.output))
    return undefined;
  const owner = service
    ? `Service '${service}' action '${config.name}'`
    : `Action '${config.name}'`;
  for (const [kind, { ref, hidden }] of [
    ["input", input],
    ["output", output],
  ] as const) {
    if (ref !== undefined)
      throw new Error(
        `${owner}: the ${kind} schema marks a field t.Sensitive and has a $ref at '${ref}' (t.Recursive, t.Module or t.Ref), which sensitive fields do not follow; move the secret out of the recursive or referenced schema`,
      );
    if (hidden !== undefined)
      throw new Error(
        `${owner}: the ${kind} schema marks a field t.Sensitive under '${hidden}', which sensitive fields do not follow; mark it in properties, items, records or union branches`,
      );
  }
  const { reveal = false } = config;
  if (reveal !== true)
    for (const path of outputs) {
      const at = pointer(path.segments);
      if (!path.optional)
        throw new Error(
          `${owner}: sensitive output field '${at}' is removed unless \`reveal\` allows it, so the schema must let it be absent: make it t.Optional in every union or intersect branch, not an array item, a record value or a property under minProperties, nor inside a uniqueItems array (or set \`reveal: true\`)`,
        );
      // A public field this path also matches would be removed with it.
      const exact = JSON.stringify(path.segments);
      const hit = output.publics.find(
        ({ segments, required }) =>
          segments.length === path.segments.length &&
          segments.every((segment, index) =>
            overlap(segment, path.segments[index]!),
          ) &&
          (required || JSON.stringify(segments) !== exact),
      );
      if (hit)
        throw new Error(
          `${owner}: sensitive output field '${at}' is removed unless \`reveal\` allows it, and that path also matches the unmarked field '${pointer(hit.segments)}', which would be removed with it; give the secret a name of its own (or set \`reveal: true\`)`,
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
      for (const value of values(input, inputs)) redact(value);
    },
    async output(output, input, ctx) {
      for (const value of values(output, outputs)) redact(value);
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
/** A number with fewer digits is not registered: `1` or `42` would blank out counts and pages. */
const MIN_REDACTED_DIGITS = 4;
/**
 * The most values one set holds. A nested call joins the enclosing set, so a
 * timer started inside a sensitive call can keep adding to it; past this, the
 * set withholds whole lines rather than forget a value.
 */
const MAX_REDACTED_VALUES = 10_000;
/** How many entries of an array, `Map` or `Set` a log line's walk looks at; the formatter prints 50. */
const MAX_WALKED_ENTRIES = 100;
const REDACTED = "[REDACTED]";
const WITHHELD = "[REDACTED: too many sensitive values in this call]";

interface Redactions {
  /** Each value, and its JSON-escaped form when that differs. */
  values: Set<string>;
  /** How many values were added, counting a value and its escaped form once. */
  count: number;
  /** The values for the text pass, longest first; dropped when a value is added. */
  sorted?: string[];
  /** Set when a value did not fit: every line is then withheld. */
  full?: boolean;
}

// Shared by name, like the marker, so a second copy of core sees the same call's set.
const redactions = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("brickkit.redactions")
] ??= new AsyncLocalStorage<Redactions>()) as AsyncLocalStorage<Redactions>;

let warned = false;

function add(set: Redactions, value: string): void {
  if (set.values.has(value)) return;
  if (set.count >= MAX_REDACTED_VALUES) {
    if (!warned)
      console.warn(
        `[brick] A call's redaction set reached ${MAX_REDACTED_VALUES} values, so its log lines are now withheld. A timer or task started inside a call with t.Sensitive fields joins that call's set; bound an input's sensitive records and arrays with maxProperties or maxItems.`,
      );
    warned = true;
    set.full = true;
    return;
  }
  set.count++;
  set.values.add(value);
  // As it appears inside a JSON or inspected string, when that differs.
  set.values.add(JSON.stringify(value).slice(1, -1));
  set.sorted = undefined;
}

const longNumber = (value: number | bigint) =>
  String(value).replace(/\D/g, "").length >= MIN_REDACTED_DIGITS;

/**
 * Keep a secret out of what Brick logs and traces for the rest of the running
 * call: the logger, the span recorder and error responses replace it with
 * `[REDACTED]`. Call it as soon as `execute` loads a secret, before it can be
 * logged. It takes each string and number in the value, as a `t.Sensitive`
 * field's value is taken: booleans, and numbers under 4 digits, are left out.
 * Outside a call with `t.Sensitive` fields it does nothing.
 */
export function redact(value: unknown): void {
  const set = redactions.getStore();
  if (set) register(set, value, new Set());
}

function register(set: Redactions, value: unknown, seen: Set<object>): void {
  if (typeof value === "string") {
    if (value) add(set, value);
  } else if (typeof value === "number" || typeof value === "bigint") {
    if (longNumber(value)) add(set, String(value));
  } else if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) register(set, child, seen);
  }
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

/** A logged leaf: replaced when it equals a value at any length, else through the text pass. */
function redactLeaf(set: Redactions, value: unknown): unknown {
  if (typeof value === "string")
    return set.values.has(value) ? REDACTED : redactText(value);
  if (typeof value === "number" || typeof value === "bigint")
    return longNumber(value) && set.values.has(String(value))
      ? REDACTED
      : value;
  return value;
}

/** Deeper than `util.inspect` prints for a log line (depth 3), so every printed leaf is seen. */
const LEAF_DEPTH = 5;

/**
 * Values as they are about to be formatted, with each string or number that
 * equals a redacted value (at any length) replaced, and each string that
 * contains one passed through `redactText`; keys too. It fails safe: what it
 * does not look inside is replaced by a marker, never passed on as it is. It
 * walks plain objects, class instances, arrays, `Map` and `Set` (their first
 * 100 entries); an `Error` becomes its redacted stack; a getter, a cycle, an
 * object past depth 5 and anything else (a `Buffer`, a `URL`) become markers.
 * It never throws.
 */
export function redactValues<T>(value: T): T {
  const set = redactions.getStore();
  if (!set || (!set.full && !set.values.size)) return value;
  const walking = new Set<object>();
  const done = new Map<object, unknown>();
  const visit = (value: any, depth: number): any => {
    if (typeof value === "function")
      return Object.keys(value).length ? "[Function]" : value;
    if (!value || typeof value !== "object") return redactLeaf(set, value);
    if (value instanceof Date) return value;
    if (walking.has(value)) return "[Circular]";
    if (done.has(value)) return done.get(value);
    if (depth > LEAF_DEPTH) return "[Object]";
    walking.add(value);
    let copy: unknown;
    try {
      copy = inside(value, depth);
    } catch {
      copy = "[Unreadable]";
    }
    walking.delete(value);
    done.set(value, copy);
    return copy;
  };
  const entries = (value: Iterable<unknown>, size: number, depth: number) => {
    const items: unknown[] = [];
    for (const item of value) {
      if (items.length === MAX_WALKED_ENTRIES) break;
      items.push(item);
    }
    // A Map's entries are [key, value] arrays, walked as arrays at the Map's own depth.
    const next = items.map((item) =>
      visit(item, value instanceof Map ? depth : depth + 1),
    );
    const more = size - items.length;
    const changed = more > 0 || next.some((item, i) => item !== items[i]);
    return { next, more, changed };
  };
  const inside = (value: object, depth: number): unknown => {
    if (Array.isArray(value)) {
      const { next, more, changed } = entries(value, value.length, depth);
      if (more) next.push(`... ${more} more items not shown`);
      return changed ? next : value;
    }
    if (value instanceof Map || value instanceof Set) {
      const { next, more, changed } = entries(value, value.size, depth);
      if (!changed) return value;
      if (value instanceof Set) {
        if (more) next.push(`... ${more} more items not shown`);
        return new Set(next);
      }
      const map = new Map(next as [unknown, unknown][]);
      if (more) map.set("...", `${more} more entries not shown`);
      return map;
    }
    if (value instanceof Error)
      return redactText(
        String(value.stack || `${value.name}: ${value.message}`),
      );
    const tag = Object.prototype.toString.call(value);
    if (tag !== "[object Object]") return `[${tag.slice(8, -1)}]`;
    // Plain objects and class instances: own enumerable keys, getters left uncalled.
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let changed = false;
    const props: [PropertyKey, unknown][] = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as any]!;
      if (!descriptor.enumerable) continue;
      const name = typeof key === "string" ? redactLeaf(set, key) : key;
      const next =
        "value" in descriptor ? visit(descriptor.value, depth + 1) : "[Getter]";
      if (name !== key || next !== descriptor.value) changed = true;
      props.push([name as PropertyKey, next]);
    }
    if (!changed) return value;
    // The prototype is kept, so a class instance still prints its name.
    const copy = Object.create(Object.getPrototypeOf(value));
    for (const [key, next] of props)
      Object.defineProperty(copy, key, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return copy;
  };
  return visit(value, 0);
}

/**
 * An error's `details` with the running call's values redacted at full depth,
 * keys included, as they will be serialized; the whole of it once the set is
 * full. The original when nothing changes.
 */
export function redactDetails(details: unknown): unknown {
  const set = redactions.getStore();
  if (!set || details === undefined || (!set.full && !set.values.size))
    return details;
  if (set.full) return WITHHELD;
  try {
    const text = JSON.stringify(details);
    if (text === undefined) return details;
    const copy = JSON.parse(text, (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              redactLeaf(set, key),
              child,
            ]),
          )
        : redactLeaf(set, value),
    );
    return JSON.stringify(copy) === text ? details : copy;
  } catch {
    // A cycle or a BigInt: it could not be checked.
    return REDACTED;
  }
}

/** Run `fn` outside any call's redaction set, so the timers it starts do not join one. */
export const outsideRedaction = <T>(fn: () => T): T => redactions.exit(fn);

/** Set a property of an error, unless it is read-only (a `DOMException`, a frozen error). */
function assign(target: any, key: string, value: unknown): void {
  try {
    target[key] = value;
  } catch {}
}

/**
 * Run a call with a redaction set: its own, or the enclosing call's so that
 * values stay redacted for as long as the outermost call runs. An error that
 * leaves the set has its messages and stacks redacted, since whoever logs it
 * next is outside the call.
 */
export async function withRedaction<T>(fn: () => Promise<T>): Promise<T> {
  if (redactions.getStore()) return fn();
  const set: Redactions = { values: new Set(), count: 0 };
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
        assign(e, "message", redactText(e.message));
        if (e.stack) assign(e, "stack", redactText(e.stack));
        if ("details" in e) assign(e, "details", redactDetails(e.details));
      }
    });
    throw err;
  }
}
