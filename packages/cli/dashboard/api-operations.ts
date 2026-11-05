import type { ApiDocument } from "@brickkit/core";
import { withAppServer } from "./format";
import { hashHref } from "../src/dashboard-protocol";

const METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;
export type ApiMethod = (typeof METHODS)[number];

export interface ApiOperation {
  method: ApiMethod;
  /** The path as the document writes it, such as `/users/{id}`. */
  path: string;
  /** What the sidebar shows, and the page titles it with: the summary, else the operation id, else the path. */
  title: string;
  deprecated: boolean;
}

/** Operations under one tag. The group of untagged operations has no name. */
export interface ApiGroup {
  name: string;
  operations: ApiOperation[];
}

/** One OpenAPI document of the app, ready to list and render. */
export interface ApiEntry {
  /** Names the document in the address: #/apis/<slug>/… */
  slug: string;
  title: string;
  document: Record<string, unknown>;
  groups: ApiGroup[];
}

interface OperationObject {
  summary?: unknown;
  operationId?: unknown;
  tags?: unknown;
  deprecated?: unknown;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * `getSession` as "Get Session": how the page titles an operation that has an
 * id and no summary (Fumadocs OpenAPI's own rule, so the two agree). A `.`
 * starts over, and `-` is a space.
 */
function idToTitle(id: string): string {
  let result: string[] = [];
  for (const char of id) {
    if (result.length === 0) result.push(char.toLocaleUpperCase());
    else if (char === ".") result = [];
    else if (/^[A-Z]$/.test(char) && result.at(-1) !== " ")
      result.push(" ", char);
    else if (char === "-") result.push(" ");
    else result.push(char);
  }
  return result.join("");
}

/** The operations of a document grouped by their first tag, in document order. */
export function groupOperations(document: Record<string, unknown>): ApiGroup[] {
  const declared = Array.isArray(document.tags)
    ? (document.tags as { name?: unknown }[])
        .map((tag) => text(tag?.name))
        .filter((name): name is string => name !== undefined)
    : [];
  const groups = new Map<string, ApiOperation[]>(
    declared.map((name) => [name, []]),
  );
  const untagged: ApiOperation[] = [];
  const paths = (document.paths ?? {}) as Record<
    string,
    | (Partial<Record<ApiMethod, OperationObject>> & { summary?: unknown })
    | undefined
  >;
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== "object") continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation || typeof operation !== "object") continue;
      const entry: ApiOperation = {
        method,
        path,
        title:
          text(operation.summary) ??
          text(item.summary) ??
          (text(operation.operationId)
            ? idToTitle(text(operation.operationId)!)
            : path),
        deprecated: operation.deprecated === true,
      };
      const tag = Array.isArray(operation.tags)
        ? text(operation.tags[0])
        : undefined;
      if (!tag) untagged.push(entry);
      else if (groups.has(tag)) groups.get(tag)!.push(entry);
      else groups.set(tag, [entry]);
    }
  }
  const named = [...groups]
    .filter(([, operations]) => operations.length > 0)
    .map(([name, operations]) => ({ name, operations }));
  return untagged.length > 0
    ? [...named, { name: "", operations: untagged }]
    : named;
}

/** A name for each document in the address bar; they must all differ. */
export function documentSlugs(documents: ApiDocument[]): string[] {
  const taken = new Set<string>();
  return documents.map((item, index) => {
    const base =
      item.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || `api-${index + 1}`;
    let slug = base;
    for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
    taken.add(slug);
    return slug;
  });
}

/** The documents to list. Their servers point at the app being shown. */
export function apiEntries(
  documents: ApiDocument[],
  appUrl: string | undefined,
): ApiEntry[] {
  const slugs = documentSlugs(documents);
  return documents.map((item, index) => {
    const document = withAppServer(item.document, appUrl);
    return {
      slug: slugs[index],
      title: item.title,
      document,
      groups: groupOperations(document),
    };
  });
}

/** A path as its non-empty segments: the address cannot tell `/a/` from `/a`. */
const normal = (path: string): string =>
  `/${path.split("/").filter(Boolean).join("/")}`;

/** The address of an operation: #/apis/<document>/<method>/<path segments>. */
export function apiHref(
  document: string,
  method: ApiMethod,
  path: string,
): string {
  return hashHref([
    "apis",
    document,
    method,
    ...path.split("/").filter(Boolean),
  ]);
}

export interface ApiSelection {
  entry: ApiEntry;
  operation: ApiOperation;
}

const first = (entry: ApiEntry): ApiSelection | undefined => {
  const operation = entry.groups[0]?.operations[0];
  return operation && { entry, operation };
};

/**
 * The operation an address names (the route's segments after `apis`). An
 * address that names none, or one that no longer exists, opens the first
 * operation of the named document, or of the first document.
 */
export function selectOperation(
  entries: ApiEntry[],
  segments: string[],
): ApiSelection | undefined {
  const [slug, method, ...rest] = segments;
  const entry = entries.find((item) => item.slug === slug);
  if (entry && method) {
    const path = normal(rest.join("/"));
    for (const group of entry.groups) {
      const operation = group.operations.find(
        (item) => item.method === method && normal(item.path) === path,
      );
      if (operation) return { entry, operation };
    }
  }
  return (
    (entry && first(entry)) ??
    entries.map(first).find((selection) => selection !== undefined)
  );
}

/** Operations whose title, path, method, or tag contain every word asked for. */
export function filterGroups(groups: ApiGroup[], query: string): ApiGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return groups;
  return groups
    .map((group) => ({
      ...group,
      operations: group.operations.filter((operation) => {
        const haystack =
          `${operation.method} ${operation.path} ${operation.title} ${group.name}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      }),
    }))
    .filter((group) => group.operations.length > 0);
}
