import {
  definitionOf,
  directivesOf,
  enclosingDefinition,
  enclosingFunction,
  fileInfo,
  getProperty,
  isFunction,
  isSchemaCall,
  memberCall,
  objectKeys,
  programOf,
  propertyName,
  resolveImport,
  stringValue,
  type Definition,
  type Node,
  type Rule,
  type RuleContext,
} from "../ast";
import { STANDARD_ERRORS } from "@brickkit/core/client";
import { MANIFEST_FILE } from "../../definitions";
import { version } from "../../../package.json";

const MANIFEST_STEM = MANIFEST_FILE.replace(/\.ts$/, "");
/** This release's range, for the `brick` field example: `^0.12.0`. */
const BRICK_RANGE = `^${version.split(".").slice(0, 2).join(".")}.0`;

function rule(
  description: string,
  create: Rule["create"],
  options: { fixable?: "code"; schema?: unknown[] } = {},
): Rule {
  return {
    meta: {
      type: "problem",
      docs: { description },
      fixable: options.fixable,
      schema: options.schema ?? [],
    },
    create,
  };
}

/** Skip tests and generated files; local plugins are checked like app code. */
function skip(context: RuleContext) {
  const info = fileInfo(context);
  return info.exempt && !info.rel.split("/").includes("plugins");
}

const HANDLERS: Definition["kind"][] = ["action", "command", "tool"];
const BUILT_IN_ERRORS = new Set(Object.keys(STANDARD_ERRORS));

/** `error.NAME(...)`, the error helper handlers receive. */
function errorHelper(node: Node): string | undefined {
  const call = memberCall(node);
  return call?.object === "error" ? call.property : undefined;
}

function isEmit(node: Node): "emitEvent" | "emit" | undefined {
  const call = memberCall(node);
  if (!call) return undefined;
  if (call.property === "emitEvent" && call.object === undefined)
    return "emitEvent";
  if (call.property === "emit" && call.object && node.arguments.length >= 3)
    return "emit";
  return undefined;
}

const WRITE_METHODS = new Set(["insert", "update", "delete"]);

// Verbs an action name may start with (getUser, archive, importCsv).
const VERBS = new Set(
  `get list find search query count read load fetch check validate verify preview render export download
create add insert import upload register invite book place submit send post publish issue open start schedule
update set edit change rename move copy clone merge assign attach link mark toggle enable disable approve reject
accept confirm complete cancel close finish stop end archive restore refund pay charge ship track sync refresh
reset delete remove detach unlink clear purge run process handle compute calculate generate build apply sign
login logout subscribe unsubscribe notify ping upsert transfer resend retry lock unlock save write report`.split(
    /\s+/,
  ),
);
const IRREGULAR_PAST = new Set(
  `sent paid built made sold bought won lost begun done held kept left met read run set shut spent taken given
written chosen frozen broken spoken stolen hidden driven fallen forgotten known shown thrown drawn grown seen
put cut hit quit split spread cast cost let upset rebuilt resent undone withdrawn`.split(
    /\s+/,
  ),
);
/** definePlugin's parts that run while the plugin installs. */
const SETUP_PARTS = ["app", "service", "resource", "tables"];
const CONNECTION_CLASS = /(Client|Pool|Redis|Connection|Socket)$/;
const CONNECTION_CALL = /^(connect|createClient|createPool|createConnection)$/;
const isPastTense = (word: string) =>
  word.endsWith("ed") || IRREGULAR_PAST.has(word);
const lastWord = (name: string) =>
  (name.match(/[A-Z]?[a-z0-9]+$/)?.[0] ?? name).toLowerCase();
const firstWord = (name: string) => name.match(/^[a-z0-9]+/)?.[0] ?? "";
const ROOM = /^[a-z][a-zA-Z0-9_-]*:./;

export const checkRules: Record<string, Rule> = {
  "no-server-in-client": rule(
    "Browser code imports only @brickkit/core/client and the generated contract.",
    (context) => {
      const info = fileInfo(context);
      const web = info.settings.web.replace(/\/$/, "");
      if (!info.rel.startsWith(`${web}/`)) return {};
      const generated = info.settings.generated.replace(/\/$/, "");
      const check = (node: Node, source: unknown) => {
        if (typeof source !== "string") return;
        let allowed: boolean;
        if (source.startsWith(".")) {
          const path = resolveImport(info, context, source)!;
          allowed =
            path.startsWith(`${web}/`) ||
            (path.startsWith(`${generated}/`) &&
              !path.endsWith(MANIFEST_STEM) &&
              !path.endsWith(MANIFEST_FILE));
        } else
          allowed =
            !/^(@brickkit\/|bun:|node:)/.test(source) ||
            source === "@brickkit/core/client" ||
            source === "@brickkit/core/tanstack-query";
        if (!allowed)
          context.report({
            node,
            message: `Browser code imports only @brickkit/core/client and the generated contract, not "${source}".`,
          });
      };
      return {
        ImportDeclaration: (node) => {
          if (node.importKind !== "type") check(node.source, node.source.value);
        },
        ExportNamedDeclaration: (node) =>
          node.source && check(node.source, node.source.value),
        ExportAllDeclaration: (node) => check(node.source, node.source.value),
        ImportExpression: (node) =>
          check(node.source, stringValue(node.source)),
      };
    },
  ),

  "no-global-context": rule(
    "No module-level mutable singletons for dependencies (the setOrdersContext pattern); use deps.",
    (context) => {
      if (skip(context)) return {};
      const mutable = new Set<string>();
      const reported = new Set<string>();
      return {
        Program(program: Node) {
          for (let statement of program.body) {
            if (statement.type === "ExportNamedDeclaration")
              statement = statement.declaration;
            if (
              statement?.type === "VariableDeclaration" &&
              statement.kind !== "const"
            )
              for (const declarator of statement.declarations)
                if (declarator.id.type === "Identifier")
                  mutable.add(declarator.id.name);
          }
        },
        AssignmentExpression(node: Node) {
          const name =
            node.left.type === "Identifier" ? node.left.name : undefined;
          if (!name || !mutable.has(name) || reported.has(name)) return;
          if (!enclosingFunction(node)) return;
          reported.add(name);
          context.report({
            node,
            message: `Module-level "${name}" is set from a function, a global context. Declare it in the service's deps (port<T>()) and read ctx.deps, or useDeps() in listeners and workflow steps.`,
          });
        },
      };
    },
  ),

  "no-env-outside-secrets": rule(
    "process.env and Bun.env are read only through defineSecret or config files.",
    (context) => {
      const info = fileInfo(context);
      if (
        info.exempt ||
        /(^|\.)secrets\.[cm]?[jt]s$/.test(info.base) ||
        /\.config\.[cm]?[jt]s$/.test(info.base)
      )
        return {};
      return {
        MemberExpression(node: Node) {
          const object = node.object;
          const property = node.computed ? undefined : node.property.name;
          const env =
            (object.type === "Identifier" &&
              (object.name === "process" || object.name === "Bun") &&
              property === "env") ||
            (object.type === "MetaProperty" && property === "env");
          if (env)
            context.report({
              node,
              message:
                "Read configuration through defineSecret() in secrets.ts, not from the environment directly.",
            });
        },
      };
    },
  ),

  "action-schemas": rule(
    "Every action, command and tool declares input and output.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          const definition = definitionOf(node);
          if (!definition || !HANDLERS.includes(definition.kind)) return;
          const missing = ["input", "output"].filter(
            (key) => !getProperty(definition.config, key),
          );
          if (missing.length)
            context.report({
              node: definition.nameNode ?? node,
              message: `${definition.kind} ${definition.name ? `"${definition.name}" ` : ""}declares no ${missing.join(" or ")}.`,
            });
        },
      };
    },
  ),

  "declared-errors": rule(
    "Every error.X() names an entry in that action's errors or a built-in error.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          const name = errorHelper(node);
          if (!name) return;
          const definition = enclosingDefinition(node, HANDLERS);
          if (!definition) return;
          const errors = getProperty(definition.config, "errors")?.value;
          const declared = errors ? objectKeys(errors) : [];
          if (declared === undefined) return; // errors built elsewhere: unknown
          if (!BUILT_IN_ERRORS.has(name) && !declared.includes(name))
            context.report({
              node: node.callee.property,
              message: `error.${name} is not in this ${definition.kind}'s errors or the built-in errors.`,
            });
        },
      };
    },
  ),

  "return-error": rule(
    "Error helpers are returned (return error.NOT_FOUND()), so TypeScript narrows the value after them.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          const name = errorHelper(node);
          if (!name || node.parent?.type !== "ExpressionStatement") return;
          if (!enclosingDefinition(node, [...HANDLERS, "crud", "socket"]))
            return;
          context.report({
            node,
            message: `Return the error: return error.${name}(...).`,
            fix: (fixer) => fixer.insertTextBefore(node, "return "),
          });
        },
      };
    },
    { fixable: "code" },
  ),

  "path-params-in-input": rule(
    "Each :param in path is a field of input.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          const definition = definitionOf(node);
          if (!definition || !HANDLERS.includes(definition.kind)) return;
          const pathNode = getProperty(definition.config, "path")?.value;
          const path = stringValue(pathNode);
          if (!path) return;
          const input = getProperty(definition.config, "input")?.value;
          const fields = isSchemaCall(input, "Object")
            ? objectKeys(input.arguments[0])
            : input
              ? undefined // a schema built elsewhere: fields unknown
              : [];
          if (!fields) return;
          const record = getProperty(definition.config, "record")?.value?.value;
          for (const [, param] of path.matchAll(/:([A-Za-z_$][\w$]*)/g))
            if (
              !fields.includes(param!) &&
              !(record === true && param === "id")
            )
              context.report({
                node: pathNode,
                message: `Path parameter :${param} is not a field of input.`,
              });
        },
      };
    },
  ),

  "get-is-read-only": rule(
    "GET actions don't insert, update, delete or emit.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          const call = memberCall(node);
          if (!call) return;
          // A write on the database or a transaction, not Map.delete and the like.
          const write =
            node.callee.type === "MemberExpression" &&
            WRITE_METHODS.has(call.property) &&
            /\b(db|tx)\b/.test(context.sourceCode.getText(node.callee.object));
          if (!write && !isEmit(node)) return;
          const definition = enclosingDefinition(node, HANDLERS);
          const method = stringValue(
            getProperty(definition?.config, "method")?.value,
          );
          if (method === "GET")
            context.report({
              node,
              message: `A GET ${definition!.kind} only reads; ${call.property}() writes. Use POST.`,
            });
        },
      };
    },
  ),

  "emit-in-transaction": rule(
    "emitEvent or live.emit inside a transaction callback passes { tx } or { after: tx }.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          const kind = isEmit(node);
          if (!kind) return;
          let tx: string | undefined;
          let inside = false;
          for (
            let fn = enclosingFunction(node);
            fn;
            fn = enclosingFunction(fn)
          ) {
            const parent = fn.parent;
            if (
              parent?.type === "CallExpression" &&
              parent.arguments[0] === fn &&
              memberCall(parent)?.property === "transaction"
            ) {
              inside = true;
              if (fn.params[0]?.type === "Identifier") tx = fn.params[0].name;
              break;
            }
          }
          if (!inside) return;
          const options = node.arguments[3];
          const keys = objectKeys(options);
          if (
            options &&
            (!keys || keys.includes("tx") || keys.includes("after"))
          )
            return;
          const option = kind === "emitEvent" ? "tx" : "after";
          context.report({
            node,
            message: `Inside a transaction, pass { ${option}: ${tx ?? "tx"} } so the ${kind === "emitEvent" ? "event is recorded in it" : "message is sent on commit"}.`,
            fix:
              tx && !options && node.arguments.length === 3
                ? (fixer) =>
                    fixer.insertTextAfter(
                      node.arguments[2],
                      `, { ${option}: ${tx} }`,
                    )
                : undefined,
          });
        },
      };
    },
    { fixable: "code" },
  ),

  "deterministic-workflow": rule(
    "No Date.now, Math.random, fetch or database access in a workflow function outside its steps.",
    (context) => {
      if (skip(context)) return {};
      const inWorkflow = (node: Node) => {
        for (let fn = enclosingFunction(node); fn; fn = enclosingFunction(fn)) {
          const directives = directivesOf(fn);
          if (directives.includes("use step")) return false;
          if (directives.includes("use workflow")) return true;
        }
        return directivesOf(programOf(node)).includes("use workflow");
      };
      const report = (node: Node, what: string) => {
        if (inWorkflow(node))
          context.report({
            node,
            message: `${what} in a workflow function is not replayed the same way; move it into a step.`,
          });
      };
      return {
        CallExpression(node: Node) {
          const call = memberCall(node);
          if (!call) return;
          if (call.object === "Date" && call.property === "now")
            report(node, "Date.now()");
          else if (call.object === "Math" && call.property === "random")
            report(node, "Math.random()");
          else if (call.object === undefined && call.property === "fetch")
            report(node, "fetch()");
        },
        NewExpression(node: Node) {
          if (node.callee.name === "Date" && node.arguments.length === 0)
            report(node, "new Date()");
        },
        MemberExpression(node: Node) {
          if (!node.computed && node.property.name === "db")
            report(node, "Database access");
        },
      };
    },
  ),

  "idempotent-listener": rule(
    "Listener writes are keyed by deliveryId or use onConflictDoNothing, because delivery is at least once.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          const definition = definitionOf(node);
          if (definition?.kind !== "listener") return;
          const text = context.sourceCode.getText(definition.config);
          if (
            /\.(insert|update|delete)\s*\(/.test(text) &&
            !/deliveryId|onConflictDo(Nothing|Update)/.test(text)
          )
            context.report({
              node: definition.nameNode ?? node,
              message:
                "This listener writes without deliveryId or onConflictDoNothing; a redelivered event would write twice.",
            });
        },
      };
    },
  ),

  "socket-schemas": rule(
    "Socket schemas have no format or transforms, and event names don't start with $.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          const definition = definitionOf(node);
          if (definition?.kind !== "socket") return;
          for (const key of ["input", "output"]) {
            const schemas = getProperty(definition.config, key)?.value;
            if (schemas?.type !== "ObjectExpression") continue;
            for (const property of schemas.properties) {
              const name = propertyName(property);
              if (name?.startsWith("$"))
                context.report({
                  node: property.key,
                  message: `Socket ${key} event "${name}" starts with $, which is reserved for control messages.`,
                });
              // shortcut: a text search; a schema imported from another file is not checked.
              const text = context.sourceCode.getText(property.value);
              if (/\bformat\s*:|\b(Transform|Decode|Encode)\s*\(/.test(text))
                context.report({
                  node: property.value,
                  message: `Socket ${key} "${name}" uses a format or transform, which sockets cannot check.`,
                });
            }
          }
        },
      };
    },
  ),

  "no-unregistered-format": rule(
    "A TypeBox format is used only when it is registered with FormatRegistry.",
    (context) => {
      if (skip(context)) return {};
      const options = (context.options?.[0] ?? {}) as { formats?: string[] };
      const registered = new Set(options.formats ?? []);
      const used: Node[] = [];
      return {
        CallExpression(node: Node) {
          const call = memberCall(node);
          if (call?.object === "FormatRegistry" && call.property === "Set") {
            const name = stringValue(node.arguments[0]);
            if (name) registered.add(name);
          }
          if (!isSchemaCall(node)) return;
          for (const argument of node.arguments) {
            const format = getProperty(argument, "format");
            if (stringValue(format?.value)) used.push(format.value);
          }
        },
        "Program:exit"() {
          for (const node of used)
            if (!registered.has(node.value))
              context.report({
                node,
                message: `Format "${node.value}" is not registered; call FormatRegistry.Set("${node.value}", ...) or list it in this rule's formats option.`,
              });
        },
      };
    },
    {
      schema: [
        {
          type: "object",
          properties: { formats: { type: "array", items: { type: "string" } } },
          additionalProperties: false,
        },
      ],
    },
  ),

  "no-floating-calls": rule(
    "Promises from service calls and emitEvent are awaited.",
    (context) => {
      if (skip(context)) return {};
      const proxies = new Set<string>();
      const candidates: Node[] = [];
      return {
        VariableDeclarator(node: Node) {
          const call = memberCall(node.init);
          if (node.id.type === "Identifier" && call?.property === "useService")
            proxies.add(node.id.name);
        },
        ExpressionStatement(node: Node) {
          if (node.expression.type === "CallExpression")
            candidates.push(node.expression);
        },
        "Program:exit"() {
          for (const call of candidates) {
            const target = memberCall(call);
            const floating =
              (target?.property === "emitEvent" && !target.object) ||
              (target?.object !== undefined && proxies.has(target.object));
            if (!floating) continue;
            const async = enclosingFunction(call)?.async === true;
            context.report({
              node: call,
              message: `Await this call (or mark it with void): an unawaited promise loses its errors.`,
              fix: async
                ? (fixer) => fixer.insertTextBefore(call, "await ")
                : undefined,
            });
          }
        },
      };
    },
    { fixable: "code" },
  ),

  "explicit-access": rule(
    "Every action and CRUD resource sets access, and record actions and commands set `access`; nothing is public by omission.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          const definition = definitionOf(node);
          if (!definition) return;
          // Record actions and commands load a row, so they always need access.
          const record =
            definition.kind === "command" ||
            (definition.kind === "action" &&
              getProperty(definition.config, "record")?.value?.value === true);
          if (record && !getProperty(definition.config, "access"))
            context.report({
              node: definition.nameNode ?? node,
              message: `Set access on this ${definition.kind === "command" ? "command" : "record action"}: access: { scope } or "public"; it decides which rows it can load.`,
            });
          else if (
            definition.kind === "action" &&
            !getProperty(definition.config, "authorize") &&
            !getProperty(definition.config, "access")
          )
            context.report({
              node: definition.nameNode ?? node,
              message: `Set access on this action: authorize, or access: "public" when anyone may call it.`,
            });
          if (
            definition.kind === "crud" &&
            !getProperty(definition.config, "access")
          )
            context.report({
              node,
              message:
                'Set access on this CRUD resource ({ authorize, scope } or "public").',
            });
        },
      };
    },
  ),

  "socket-authorize": rule("Sockets declare authorize and join.", (context) => {
    if (skip(context)) return {};
    return {
      CallExpression(node: Node) {
        const definition = definitionOf(node);
        if (definition?.kind !== "socket") return;
        const missing = ["authorize", "join"].filter(
          (key) => !getProperty(definition.config, key),
        );
        if (missing.length)
          context.report({
            node: definition.nameNode ?? node,
            message: `Socket declares no ${missing.join(" or ")}; add ${missing.length > 1 ? "them" : "it"}.`,
          });
      },
    };
  }),

  "no-wildcard-origins": rule(
    'No "*" in allowedOrigins or trustedOrigins.',
    (context) => {
      if (skip(context)) return {};
      return {
        Property(node: Node) {
          const name = propertyName(node);
          if (name !== "allowedOrigins" && name !== "trustedOrigins") return;
          const values =
            node.value.type === "ArrayExpression"
              ? node.value.elements
              : [node.value];
          for (const value of values)
            if (stringValue(value) === "*")
              context.report({
                node: value,
                message: `"*" in ${name} lets any site in; list the origins.`,
              });
        },
      };
    },
  ),

  "strict-input": rule(
    "Input objects set additionalProperties: false.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          const definition = definitionOf(node);
          if (!definition || !HANDLERS.includes(definition.kind)) return;
          const input = getProperty(definition.config, "input")?.value;
          if (!isSchemaCall(input, "Object")) return;
          const [fields, options] = input.arguments;
          const strict = getProperty(options, "additionalProperties")?.value;
          if (strict?.type === "Literal" && strict.value === false) return;
          if (options && options.type !== "ObjectExpression") return;
          context.report({
            node: input,
            message: "Set additionalProperties: false on this input object.",
            fix: strict
              ? undefined
              : !options
                ? (fixer) =>
                    fixer.insertTextAfter(
                      fields,
                      ", { additionalProperties: false }",
                    )
                : options.properties.length === 0
                  ? (fixer) =>
                      fixer.replaceText(
                        options,
                        "{ additionalProperties: false }",
                      )
                  : (fixer) =>
                      fixer.insertTextAfter(
                        options.properties.at(-1),
                        ", additionalProperties: false",
                      ),
          });
        },
      };
    },
    { fixable: "code" },
  ),

  "description-required": rule(
    "Actions, commands, tools, sockets and events have a description, which feeds OpenAPI, MCP and the dashboard.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          const definition = definitionOf(node);
          if (!definition) return;
          if (
            ["action", "command", "tool", "socket"].includes(definition.kind) &&
            !getProperty(definition.config, "description")
          )
            context.report({
              node: definition.nameNode ?? node,
              message: `Describe this ${definition.kind}: the description feeds OpenAPI, MCP and the dashboard.`,
            });
          const events =
            definition.kind === "service" || definition.kind === "plugin"
              ? getProperty(definition.config, "events")?.value
              : undefined;
          for (const event of events?.properties ?? []) {
            const schema = event.value;
            if (!isSchemaCall(schema)) continue;
            const described = schema.arguments.some((argument: Node) =>
              getProperty(argument, "description"),
            );
            if (!described)
              context.report({
                node: event.key,
                message: `Describe event "${propertyName(event)}" with { description } on its schema.`,
              });
          }
        },
      };
    },
  ),

  naming: rule(
    "Actions are camelCase verbs (getUser), events are service.pastTense (orders.shipped), and rooms are prefix:value.",
    (context) => {
      if (skip(context)) return {};
      const checkRoom = (node: Node) => {
        const text =
          node?.type === "TemplateLiteral"
            ? node.quasis[0].value.cooked + (node.expressions.length ? "x" : "")
            : stringValue(node);
        if (text !== undefined && !ROOM.test(text))
          context.report({
            node,
            message: `Room "${text}" should be prefix:value, such as doc:42 or user:7.`,
          });
      };
      return {
        CallExpression(node: Node) {
          const definition = definitionOf(node);
          if (
            (definition?.kind === "action" || definition?.kind === "command") &&
            definition.name
          ) {
            const name = definition.name;
            if (
              !/^[a-z][a-zA-Z0-9]*$/.test(name) ||
              !VERBS.has(firstWord(name))
            )
              context.report({
                node: definition.nameNode,
                message: `${definition.kind} "${name}" should be a camelCase verb, such as getUser or archive.`,
              });
          }
          if (definition?.kind === "service") {
            const events = getProperty(definition.config, "events")?.value;
            for (const name of objectKeys(events) ?? [])
              if (
                !/^[a-z][a-zA-Z0-9]*$/.test(name) ||
                !isPastTense(lastWord(name))
              )
                context.report({
                  node: getProperty(events, name).key,
                  message: `Event "${name}" should be camelCase past tense, such as shipped or itemAdded.`,
                });
          }
          if (definition?.kind === "socket") {
            const rooms = getProperty(definition.config, "rooms")?.value;
            const list = isFunction(rooms) ? rooms.body : rooms;
            if (list?.type === "ArrayExpression")
              for (const element of list.elements) checkRoom(element);
          }
          const kind = isEmit(node);
          if (kind === "emitEvent") {
            const name = stringValue(node.arguments[1]);
            if (
              name !== undefined &&
              (!/^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/.test(name) ||
                !isPastTense(lastWord(name)))
            )
              context.report({
                node: node.arguments[1],
                message: `Event "${name}" should be service.pastTense, such as orders.shipped.`,
              });
          }
          if (kind === "emit") {
            const room = node.arguments[0];
            if (room.type === "ArrayExpression")
              room.elements.forEach(checkRoom);
            else checkRoom(room);
          }
        },
      };
    },
  ),

  "no-console": rule(
    "Handlers log through the request logger, so lines carry the request and trace ids.",
    (context) => {
      if (skip(context)) return {};
      return {
        CallExpression(node: Node) {
          if (memberCall(node)?.object !== "console") return;
          if (
            !enclosingDefinition(node, [
              ...HANDLERS,
              "socket",
              "listener",
              "crud",
            ])
          )
            return;
          context.report({
            node,
            message:
              "Log through ctx.logger, so the line carries the request and trace ids.",
          });
        },
      };
    },
  ),

  "plugin-manifest": rule(
    'definePlugin has a scoped name, a brick range and declared options with descriptions; its setup functions are synchronous and open no connections outside on("start").',
    (context) => {
      if (skip(context)) return {};
      const connection = (node: Node) => {
        const opens =
          node.type === "NewExpression"
            ? node.callee.type === "Identifier" &&
              CONNECTION_CLASS.test(node.callee.name)
            : CONNECTION_CALL.test(memberCall(node)?.property ?? "");
        if (!opens) return;
        // Inside on("start", ...) is the place; inside a setup part is not.
        for (let current = node.parent; current; current = current.parent) {
          const call = memberCall(current);
          if (
            call?.property === "on" &&
            stringValue(current.arguments[0]) === "start"
          )
            return;
          if (
            current.type === "Property" &&
            SETUP_PARTS.includes(propertyName(current) ?? "") &&
            definitionOf(current.parent?.parent)?.kind === "plugin"
          )
            return context.report({
              node,
              message:
                'Open connections in on("start") (and close them in on("stop")), not while the plugin installs.',
            });
        }
      };
      return {
        NewExpression: connection,
        CallExpression(node: Node) {
          connection(node);
          const definition = definitionOf(node);
          if (definition?.kind !== "plugin") return;
          const config = definition.config;
          if (!definition.name || !/^@[^/\s]+\/[^/\s]+$/.test(definition.name))
            context.report({
              node: definition.nameNode ?? node,
              message:
                'Give the plugin a scoped package name, such as "@acme/brick-comments".',
            });
          if (!stringValue(getProperty(config, "brick")?.value))
            context.report({
              node: node.callee,
              message: `Declare the Brick versions this plugin supports: brick: "${BRICK_RANGE}".`,
            });
          const options = getProperty(config, "options")?.value;
          if (!options)
            context.report({
              node: node.callee,
              message:
                "Declare the plugin's options as a TypeBox schema (options: t.Object({ ... })).",
            });
          else if (
            isSchemaCall(options, "Object") &&
            options.arguments[0]?.type === "ObjectExpression"
          )
            for (const option of options.arguments[0].properties) {
              const schema = option.value;
              const settings = isSchemaCall(schema)
                ? schema.arguments.at(-1)
                : undefined;
              if (!getProperty(settings, "description"))
                context.report({
                  node: option,
                  message: `Describe option "${propertyName(option) ?? "?"}": add { description: "..." } to its schema.`,
                });
            }
          for (const key of ["setup", ...SETUP_PARTS]) {
            const setup = getProperty(config, key)?.value;
            if (isFunction(setup) && setup.async)
              context.report({
                node: setup,
                message: `${key} must be synchronous; open connections in on("start").`,
              });
          }
        },
      };
    },
  ),
};
