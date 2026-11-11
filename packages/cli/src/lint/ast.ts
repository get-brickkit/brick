import { basename, dirname, relative, resolve, sep } from "node:path";
import { kebabCase } from "@brickkit/core/client";
import { PROJECT_DEFAULTS } from "../config";
import {
  DEFINITION_FILE,
  TEST_FILE,
  type DefinitionKind,
} from "../definitions";

// ESTree nodes as ESLint and oxlint hand them to rules. Kept loose on purpose:
// the rules read a handful of fields and run under both linters.
// oxlint-disable-next-line typescript/no-explicit-any
export type Node = any;

export interface RuleContext {
  filename: string;
  cwd?: string;
  settings?: { brick?: Partial<BrickSettings> };
  options?: unknown[];
  sourceCode: { getText(node?: Node): string };
  report(descriptor: {
    node: Node;
    message: string;
    fix?: (fixer: Fixer) => unknown;
  }): void;
}

export interface Fixer {
  insertTextBefore(node: Node, text: string): unknown;
  insertTextAfter(node: Node, text: string): unknown;
  insertTextBeforeRange(range: [number, number], text: string): unknown;
  replaceText(node: Node, text: string): unknown;
}

export interface Rule {
  meta: {
    type: "problem" | "suggestion" | "layout";
    docs: { description: string };
    fixable?: "code";
    schema: unknown[];
  };
  create(
    context: RuleContext,
  ): Record<string, ((node: Node) => void) | undefined>;
}

export function defineRule(
  type: Rule["meta"]["type"],
  description: string,
  create: Rule["create"],
  options: { fixable?: "code"; schema?: unknown[] } = {},
): Rule {
  return {
    meta: {
      type,
      docs: { description },
      fixable: options.fixable,
      schema: options.schema ?? [],
    },
    create,
  };
}

/** Paths from brick.config.ts, relative to `root`. Linters pass them in `settings.brick`. */
export interface BrickSettings {
  root: string;
  services: string;
  entry: string;
  generated: string;
}

/** Browser code folder, which may import only the client and the contract. */
export const WEB_DIR = "web";

const posix = (path: string) => path.split(sep).join("/");

/** The settings with Brick's default paths, each relative to the root without a trailing slash. */
export function brickSettings(context: RuleContext): BrickSettings {
  const given = context.settings?.brick ?? {};
  const root = given.root ?? context.cwd ?? process.cwd();
  const from = (path: string) => posix(relative(root, resolve(root, path)));
  return {
    root,
    services: from(given.services ?? PROJECT_DEFAULTS.services),
    entry: from(given.entry ?? PROJECT_DEFAULTS.entry),
    generated: from(given.generated ?? PROJECT_DEFAULTS.generated),
  };
}

/** The folders a service may live in: its kebab-case name, or the name itself. */
export const serviceFolders = (name: string) => [kebabCase(name), name];

export interface FileInfo {
  settings: BrickSettings;
  rel: string;
  base: string;
  inServices: boolean;
  /** Service folder name, for files under `<services>/<name>/`. */
  service?: string;
  /** Path segments after the service folder (the last one is the file). */
  rest: string[];
  /** Definition kind from the file suffix, and the name before it. */
  kind?: DefinitionKind;
  stem?: string;
  /** Tests, dependencies and generated files: no rule checks them. */
  ignored: boolean;
  /** Tests, local plugins and generated files are not app definitions. */
  exempt: boolean;
}

export function fileInfo(context: RuleContext): FileInfo {
  const settings = brickSettings(context);
  const rel = posix(relative(settings.root, context.filename));
  const { services: servicesDir, generated } = settings;
  const base = basename(rel);
  const inServices = rel.startsWith(`${servicesDir}/`);
  const parts = inServices ? rel.slice(servicesDir.length + 1).split("/") : [];
  const match = DEFINITION_FILE.exec(base);
  const segments = rel.split("/");
  const ignored =
    TEST_FILE.test(base) ||
    segments.includes("test") ||
    segments.includes("tests") ||
    segments.includes("__tests__") ||
    segments.includes("node_modules") ||
    rel.startsWith(`${generated}/`);
  return {
    settings,
    rel,
    base,
    inServices,
    service: parts.length > 1 ? parts[0] : undefined,
    rest: parts.slice(1),
    kind: match?.[2] as DefinitionKind | undefined,
    stem: match?.[1],
    ignored,
    exempt: ignored || segments.includes("plugins"),
  };
}

/** A string literal's value, or a template literal's text when it has no expressions. */
export function stringValue(node: Node): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

export function propertyName(property: Node): string | undefined {
  if (property?.type !== "Property" || property.computed) return undefined;
  const key = property.key;
  if (key.type === "Identifier") return key.name;
  return typeof key.value === "string" ? key.value : undefined;
}

export function getProperty(object: Node, name: string): Node | undefined {
  if (object?.type !== "ObjectExpression") return undefined;
  return object.properties.find(
    (property: Node) => propertyName(property) === name,
  );
}

export function objectKeys(object: Node): string[] | undefined {
  if (object?.type !== "ObjectExpression") return undefined;
  const keys: string[] = [];
  for (const property of object.properties) {
    const name = propertyName(property);
    if (name === undefined) return undefined; // a spread or computed key: unknown keys
    keys.push(name);
  }
  return keys;
}

/** `t.Object(...)` or `Type.Object(...)`. */
export function isSchemaCall(node: Node, kind?: string): boolean {
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    (node.callee.object.name === "t" || node.callee.object.name === "Type") &&
    (kind === undefined || node.callee.property.name === kind)
  );
}

export interface Definition {
  kind: DefinitionKind | "plugin" | "crud";
  call: Node;
  /** The service or resource it attaches to (`orders` in `orders.action(...)`). */
  owner?: string;
  config?: Node;
  name?: string;
  nameNode?: Node;
}

export const DEFINE_FUNCTIONS: Record<string, Definition["kind"]> = {
  defineService: "service",
  defineAction: "action",
  defineTool: "tool",
  defineListener: "listener",
  defineSchedule: "schedule",
  definePlugin: "plugin",
  defineResource: "resource",
  crud: "crud",
  sqliteTable: "table",
  pgTable: "table",
};

const ATTACH_METHODS: Record<string, Definition["kind"]> = {
  action: "action",
  tool: "tool",
  socket: "socket",
  resource: "resource",
  command: "command",
};

/** What a call defines, matching the call shapes in the project structure. */
export function definitionOf(call: Node): Definition | undefined {
  if (call?.type !== "CallExpression") return undefined;
  const [first, second] = call.arguments;
  const callee = call.callee;
  if (callee.type === "Identifier" && DEFINE_FUNCTIONS[callee.name]) {
    const kind = DEFINE_FUNCTIONS[callee.name]!;
    // defineResource(service, config) is service.resource(config).
    if (kind === "resource")
      return first?.type === "Identifier"
        ? attached(call, kind, first.name, second)
        : undefined;
    if (kind === "service" || kind === "table") {
      const name = stringValue(first);
      if (name === undefined) return undefined;
      return { kind, call, name, nameNode: first, config: second };
    }
    if (first?.type !== "ObjectExpression") return undefined;
    const nameNode = getProperty(first, "name")?.value;
    return {
      kind,
      call,
      config: first,
      name: stringValue(nameNode),
      nameNode,
    };
  }
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.object.type !== "Identifier"
  )
    return undefined;
  const kind = ATTACH_METHODS[callee.property.name];
  if (!kind) return undefined;
  const owner = callee.object.name;
  if (kind === "command") {
    const name = stringValue(first);
    if (name === undefined || second?.type !== "ObjectExpression")
      return undefined;
    return { kind, call, owner, name, nameNode: first, config: second };
  }
  return attached(call, kind, owner, first);
}

function attached(
  call: Node,
  kind: Definition["kind"],
  owner: string,
  config: Node,
): Definition | undefined {
  if (config?.type !== "ObjectExpression") return undefined;
  const nameNode = getProperty(config, "name")?.value;
  const name = stringValue(nameNode);
  // A resource needs its name and table; anything else called `.resource` is not one.
  if (kind === "resource" && name === undefined) return undefined;
  return { kind, call, owner, config, name, nameNode };
}

/** The nearest enclosing definition of one of `kinds`. */
export function enclosingDefinition(
  node: Node,
  kinds?: Definition["kind"][],
): Definition | undefined {
  for (let current = node.parent; current; current = current.parent) {
    const definition = definitionOf(current);
    if (definition && (!kinds || kinds.includes(definition.kind)))
      return definition;
  }
  return undefined;
}

export function isFunction(node: Node): boolean {
  return (
    node?.type === "FunctionDeclaration" ||
    node?.type === "FunctionExpression" ||
    node?.type === "ArrowFunctionExpression"
  );
}

export function enclosingFunction(node: Node): Node | undefined {
  for (let current = node.parent; current; current = current.parent)
    if (isFunction(current)) return current;
  return undefined;
}

/** Directives at the top of a function body or of the program. */
export function directivesOf(node: Node): string[] {
  const body =
    node?.type === "Program"
      ? node.body
      : node?.body?.type === "BlockStatement"
        ? node.body.body
        : [];
  const directives: string[] = [];
  for (const statement of body) {
    if (
      statement.type !== "ExpressionStatement" ||
      typeof statement.directive !== "string"
    )
      break;
    directives.push(statement.directive);
  }
  return directives;
}

export function programOf(node: Node): Node {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}

/** Local name to import source, for the file's import declarations. */
export function importSources(program: Node): Map<string, string> {
  const sources = new Map<string, string>();
  for (const statement of program.body)
    if (statement.type === "ImportDeclaration")
      for (const specifier of statement.specifiers)
        sources.set(specifier.local.name, statement.source.value);
  return sources;
}

/** An import source resolved to a project-relative path; undefined for packages. */
export function resolveImport(
  info: FileInfo,
  context: RuleContext,
  source: string,
): string | undefined {
  if (!source.startsWith(".")) return undefined;
  return posix(
    relative(info.settings.root, resolve(dirname(context.filename), source)),
  );
}

/** `name.method(...)` with a non-computed property, or a bare `fn(...)` (no `object`). */
export function memberCall(
  node: Node,
): { object?: string; property: string } | undefined {
  if (node?.type !== "CallExpression") return undefined;
  const callee = node.callee;
  if (callee.type === "Identifier") return { property: callee.name };
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  return {
    object:
      callee.object.type === "Identifier" ? callee.object.name : undefined,
    property: callee.property.name,
  };
}
