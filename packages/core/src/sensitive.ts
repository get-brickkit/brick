import { AsyncLocalStorage } from "node:async_hooks";
import { inspect } from "node:util";
import type { TSchema } from "@sinclair/typebox";

const SENSITIVE = Symbol.for("brickkit.sensitive");

/** The schema, unchanged in type and validation, marked sensitive. */
export function Sensitive<T extends TSchema>(schema: T): T {
  return { ...schema, [SENSITIVE]: true };
}

export const isSensitive = (schema: any): boolean =>
  schema?.[SENSITIVE] === true;

type Segment = string | null | { except: string[] };

interface SensitivePath {
  segments: Segment[];
  optional: boolean;
}

interface Analysis {
  paths: SensitivePath[];
  publics: { segments: Segment[]; required: boolean }[];
  ref?: string;
  hidden?: string;
}

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

export function sensitivePaths(schema: unknown): SensitivePath[] {
  return analyze(schema).paths;
}

const holdsMark = (node: unknown, seen = new Set<unknown>()): boolean => {
  if (!node || typeof node !== "object" || seen.has(node)) return false;
  seen.add(node);
  return (
    isSensitive(node) ||
    Object.values(node).some((child) => holdsMark(child, seen))
  );
};

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
  for (const key of Object.keys(schema))
    if (
      !WALKED.has(key) ||
      (key === "items" && !list && !Array.isArray(schema.items))
    )
      if (holdsMark(schema[key])) walk.hidden ??= pointer([...segments, key]);
  const branchesSharingOnePath = [
    ...(schema.anyOf ?? []),
    ...(schema.allOf ?? []),
    ...(schema.oneOf ?? []),
  ];
  for (const branch of branchesSharingOnePath)
    collect(branch, segments, optional, ids, walk);
  const declared = Object.keys(schema.properties ?? {});
  const required = new Set<string>(schema.required ?? []);
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

const admits = (segment: Segment, key: string): boolean =>
  segment === null ||
  (typeof segment === "string"
    ? segment === key
    : !segment.except.includes(key));

const overlap = (a: Segment, b: Segment): boolean =>
  typeof a === "string"
    ? admits(b, a)
    : typeof b === "string"
      ? admits(a, b)
      : true;

export const marksKey = (schema: unknown, key: string): boolean =>
  sensitivePaths(schema).some(
    ({ segments: [first] }) => first === undefined || admits(first, key),
  );

/** Whether any part of a schema is marked sensitive. */
export function hasSensitive(schema: unknown): boolean {
  const { paths, hidden } = analyze(schema);
  return paths.length > 0 || hidden !== undefined;
}

export function writeOnly<T>(schema: T): T {
  if (!hasSensitive(schema)) return schema;
  const visit = (node: any): any => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
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

export interface Sensitivity {
  input(input: unknown): void;
  output(output: unknown, input: unknown, ctx: unknown): Promise<unknown>;
}

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

const MIN_REDACTED_LENGTH = 8;
const MIN_REDACTED_DIGITS = 4;
const MAX_REDACTED_VALUES = 10_000;
const MAX_WALKED_ENTRIES = 100;
const REDACTED = "[REDACTED]";
const WITHHELD = "[REDACTED: too many sensitive values in this call]";

interface Redactions {
  values: Set<string>;
  count: number;
  sorted?: string[];
  full?: boolean;
}

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

export function redacting(): boolean {
  const set = redactions.getStore();
  return !!set && (set.full || set.values.size > 0);
}

export function redactText(text: string): string;
export function redactText(text: unknown): unknown;
export function redactText(text: unknown): unknown {
  const set = redactions.getStore();
  if (!set || typeof text !== "string") return text;
  if (set.full) return WITHHELD;
  set.sorted ??= [...set.values]
    .filter((value) => value.length >= MIN_REDACTED_LENGTH)
    .sort((a, b) => b.length - a.length);
  let redacted: string = text;
  for (const value of set.sorted)
    if (redacted.includes(value))
      redacted = redacted.split(value).join(REDACTED);
  return redacted;
}

function redactLeaf(set: Redactions, value: unknown): unknown {
  if (typeof value === "string")
    return set.values.has(value) ? REDACTED : redactText(value);
  if (typeof value === "number" || typeof value === "bigint")
    return longNumber(value) && set.values.has(String(value))
      ? REDACTED
      : value;
  return value;
}

const LEAF_DEPTH = 5;

function publicFieldsCopy(
  original: object,
  props: [PropertyKey, unknown][],
): object {
  const copy = Object.create(Object.getPrototypeOf(original));
  for (const [key, next] of props)
    Object.defineProperty(copy, key, {
      value: next,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return copy;
}

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
      return changed || Object.keys(value).length !== value.length
        ? next
        : value;
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
    if (value instanceof Error) {
      let text = redactText(
        String(value.stack || `${value.name}: ${value.message}`),
      );
      if (Object.keys(value).length)
        text += ` ${inspect(visit({ ...value }, depth + 1), { depth: 2 })}`;
      if (value.cause !== undefined) {
        const cause = visit(value.cause, depth + 1);
        text += `\n  [cause]: ${typeof cause === "string" ? cause : inspect(cause, { depth: 2 })}`;
      }
      return text;
    }
    const tag = Object.prototype.toString.call(value);
    if (tag !== "[object Object]") return `[${tag.slice(8, -1)}]`;
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
    return changed ? publicFieldsCopy(value, props) : value;
  };
  return visit(value, 0);
}

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
    return REDACTED;
  }
}

export const outsideRedaction = <T>(fn: () => T): T => redactions.exit(fn);

/** Set a property of an error, unless it is read-only (a `DOMException`, a frozen error). */
function assign(target: any, key: string, value: unknown): void {
  try {
    target[key] = value;
  } catch {}
}

const ESCAPED_ERROR_FIELDS = new Set(["message", "stack", "cause", "details"]);
const MAX_CAUSE_DEPTH = 8;

/** `err`, redacted in place along its cause chain, for whoever logs it outside the call. */
function redactEscaped(err: unknown): unknown {
  if (!(err instanceof Error)) return redactValues(err);
  let e: any = err;
  for (let n = 0; n < MAX_CAUSE_DEPTH; n++) {
    assign(e, "message", redactText(e.message));
    if (e.stack) assign(e, "stack", redactText(e.stack));
    if ("details" in e) assign(e, "details", redactDetails(e.details));
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(e),
    ))
      if (
        descriptor.enumerable &&
        "value" in descriptor &&
        !ESCAPED_ERROR_FIELDS.has(key)
      )
        assign(e, key, redactValues(descriptor.value));
    if (!(e.cause instanceof Error)) {
      if (e.cause !== undefined) assign(e, "cause", redactValues(e.cause));
      break;
    }
    e = e.cause;
  }
  return err;
}

export async function withRedaction<T>(fn: () => Promise<T>): Promise<T> {
  if (redactions.getStore()) return fn();
  const set: Redactions = { values: new Set(), count: 0 };
  try {
    return await redactions.run(set, fn);
  } catch (err) {
    throw redactions.run(set, () => redactEscaped(err));
  }
}
