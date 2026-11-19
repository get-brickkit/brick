import type { ApiDocument } from "@brickkit/core";
import {
  compactJson,
  cut,
  READ_ONLY,
  text,
  type Args,
  type BuiltInTool,
  type McpSources,
} from "./dashboard-mcp-args";
import type { DocsNode } from "./dashboard-protocol";

/*
 * The APIs and Docs views, for a coding agent: the app's OpenAPI documents and
 * its developer documentation. The dashboard serves neither in production.
 */

/** An answer about the OpenAPI document or a docs page is cut to about this many characters. */
export const MAX_DOCS_CHARS = 50_000;
const MAX_OPERATIONS_LISTED = 300;
const MAX_REFERENCED_SCHEMAS = 100;
/** The last resort for an operation too large to show: how much of it to try, each time half as much. */
const PREVIEW_CHARS_MOST_FIRST = [25_000, 10_000, 2_000] as const;
const MAX_NAMED_SCHEMAS = 20;
const MAX_NAME_CHARS = 200;
const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

type Json = Record<string, any>;

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function pickDocument(documents: ApiDocument[], name: string | undefined) {
  const found = name
    ? documents.find((item) => sameName(item.title, name))
    : documents[0];
  if (!found)
    throw new Error(
      `No OpenAPI document called ${name}. The app has: ${documents.map((item) => item.title).join(", ")}.`,
    );
  return found;
}

/** Each operation of a document: its method and path, and the operation object. */
function operationsOf(document: Json) {
  const found: { method: string; path: string; operation: Json }[] = [];
  for (const [path, item] of Object.entries<Json>(document.paths ?? {}))
    for (const method of HTTP_METHODS)
      if (item?.[method]) found.push({ method, path, operation: item[method] });
  return found;
}

/** `GET /api/pages/:id` and `get /api/pages/{id}` are the same operation. */
const normalizePath = (path: string) => path.replace(/:(\w+)/g, "{$1}");

function findOperation(document: Json, wanted: string) {
  const operations = operationsOf(document);
  const spaced = /^(\w+)\s+(\S+)$/.exec(wanted.trim());
  const found = spaced
    ? operations.find(
        (item) =>
          sameName(item.method, spaced[1]!) &&
          item.path === normalizePath(spaced[2]!),
      )
    : operations.find((item) => item.operation.operationId === wanted.trim());
  if (!found)
    throw new Error(
      `No operation ${wanted} in that document. Call get_openapi without operation to list them.`,
    );
  return found;
}

/** The schemas an operation points to with `$ref`, and those they point to in turn. */
function referencedSchemas(document: Json, operation: Json) {
  const schemas: Record<string, unknown> = {};
  const pending: unknown[] = [operation];
  while (
    pending.length &&
    Object.keys(schemas).length < MAX_REFERENCED_SCHEMAS
  ) {
    const value = pending.pop();
    if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === "object")
      for (const [key, entry] of Object.entries(value)) {
        if (key === "$ref" && typeof entry === "string") {
          const target = entry.startsWith("#/")
            ? entry
                .slice(2)
                .split("/")
                .reduce<any>((at, part) => at?.[part], document)
            : undefined;
          if (target !== undefined && !(entry in schemas)) {
            schemas[entry] = target;
            pending.push(target);
          }
        } else pending.push(entry);
      }
  }
  return schemas;
}

function getOpenapi(documents: ApiDocument[], args: Args) {
  const { title, document } = pickDocument(documents, text(args, "document"));
  const wanted = text(args, "operation");
  if (!wanted) {
    const operations = operationsOf(document);
    const listed = operations.slice(0, MAX_OPERATIONS_LISTED);
    return compactJson({
      documents: documents.map((item) => item.title),
      document: title,
      info: document.info,
      servers: document.servers,
      operations: listed.map(({ method, path, operation }) => ({
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
        summary: operation.summary,
        tags: operation.tags,
      })),
      ...(listed.length < operations.length
        ? {
            note: `${operations.length - listed.length} more operations are left out. Ask for one by operation.`,
          }
        : {}),
    });
  }
  const { method, path, operation } = findOperation(document, wanted);
  const schemas = referencedSchemas(document, operation);
  const answer = (
    parts: { schemas: unknown; operation: unknown },
    note?: string,
  ) =>
    compactJson({
      document: cut(title, MAX_NAME_CHARS),
      method: method.toUpperCase(),
      path: cut(path, MAX_NAME_CHARS),
      operation: parts.operation,
      referenced: parts.schemas,
      ...(note ? { note } : {}),
    });
  let result = answer({ operation, schemas });
  if (result.length <= MAX_DOCS_CHARS) return result;
  // Too big: keep the operation, and name the schemas it points to instead of showing them.
  result = answer(
    { operation, schemas: Object.keys(schemas) },
    "Cut to fit about 50 KB: the schemas the operation refers to are named, not shown.",
  );
  if (result.length <= MAX_DOCS_CHARS) return result;
  // Still too big: show only its start, as little as it takes to fit (escaping
  // can double a preview), and in the end none of it.
  const names = Object.keys(schemas)
    .slice(0, MAX_NAMED_SCHEMAS)
    .map((name) => cut(name, MAX_NAME_CHARS));
  const json = JSON.stringify(operation);
  for (const chars of PREVIEW_CHARS_MOST_FIRST) {
    result = answer(
      { operation: { preview: cut(json, chars) }, schemas: names },
      "Cut to fit about 50 KB: the operation itself is too large, so only its start is shown.",
    );
    if (result.length <= MAX_DOCS_CHARS) return result;
  }
  return answer(
    { operation: "left out", schemas: names },
    `The operation is ${json.length} characters long, too large to show even cut down. Read it in the dashboard's APIs view.`,
  );
}

interface DocsEntry {
  path: string;
  title: string;
  description?: string;
  section?: string;
}

/** The pages of the docs tree in order, each with the folders it sits in. */
function pagesOf(nodes: DocsNode[], section?: string): DocsEntry[] {
  return nodes.flatMap((node): DocsEntry[] => {
    if (node.type === "page")
      return [
        {
          path: node.url.replace(/^\//, ""),
          title: node.name,
          description: node.description,
          section,
        },
      ];
    if (node.type !== "folder") return [];
    return [
      ...(node.index
        ? [
            {
              path: node.index.url.replace(/^\//, ""),
              title: node.index.name,
              section: node.name,
            },
          ]
        : []),
      ...pagesOf(node.children, node.name),
    ];
  });
}

/** What the APIs view and the Docs view show, while the dashboard serves them. */
export function docsTools(sources: McpSources): BuiltInTool[] {
  const dev = sources.mode === "dev";
  const documents = () => sources.store.apiDocuments();
  const docs = () => (dev ? sources.docs?.() : undefined);
  return [
    {
      definition: {
        name: "get_openapi",
        description:
          'The app\'s OpenAPI documents, as the APIs view renders them. Without operation it lists the operations of one document (method, path, operation id, summary, tags) with its info and servers. With operation ("POST /api/orders/order" or an operation id) it returns that operation in full, with the schemas it refers to. Output is cut to about 50 KB and says what was left out. Only under `brick dev`.',
        inputSchema: {
          type: "object",
          properties: {
            document: {
              type: "string",
              description:
                "The document's title. Default: the first, which is the app's own.",
            },
            operation: {
              type: "string",
              description:
                'One operation: "METHOD /path" (the path as in the document, `{id}` or `:id`), or its operationId.',
            },
          },
          additionalProperties: false,
        },
        annotations: READ_ONLY,
      },
      available: () => dev && documents().length > 0,
      run: (args) => getOpenapi(documents(), args),
    },
    {
      definition: {
        name: "list_docs",
        description:
          "The app's developer documentation, as the Docs view lists it: each page's path, title and description, in order, with the section it sits in. Open one with read_doc. Only under `brick dev`, and only for an app that sets `documentation`.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: READ_ONLY,
      },
      available: () => docs() !== undefined,
      run: () => {
        const { tree } = docs()!.info();
        return compactJson({ title: tree.name, pages: pagesOf(tree.children) });
      },
    },
    {
      definition: {
        name: "read_doc",
        description: `One page of the app's developer documentation, by path: its title, description and source (Markdown or MDX, without the frontmatter), cut to about ${MAX_DOCS_CHARS / 1000} KB with a note when it is longer. Only under \`brick dev\`, and only for an app that sets \`documentation\`.`,
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                'From list_docs, such as "guide/setup". The home page is "" or "/".',
            },
          },
          required: ["path"],
          additionalProperties: false,
        },
        annotations: READ_ONLY,
      },
      available: () => docs() !== undefined,
      run: (args) => {
        const path = args.path;
        if (typeof path !== "string") throw new Error("path is required.");
        const page = docs()!.source(path.split("/").filter(Boolean));
        if (!page)
          throw new Error(
            `No docs page at ${JSON.stringify(path)}. Call list_docs for the paths.`,
          );
        return compactJson({
          title: page.title,
          description: page.description,
          file: page.path,
          content: cut(page.content, MAX_DOCS_CHARS),
          ...(page.content.length > MAX_DOCS_CHARS
            ? {
                note: `The page is ${page.content.length} characters long and was cut to ${MAX_DOCS_CHARS}.`,
              }
            : {}),
        });
      },
    },
  ];
}

export const DOCS_TOOL_NAMES = [
  "get_openapi",
  "list_docs",
  "read_doc",
] as const;
