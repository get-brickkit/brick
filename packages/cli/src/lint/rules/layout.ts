import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { kebabCase } from "@brickkit/core/client";
import { DEFINITION_FILE } from "../../definitions";
import {
  defineRule,
  definitionOf,
  fileInfo,
  importSources,
  resolveImport,
  serviceFolders,
  type Definition,
  type Node,
  type Rule,
} from "../ast";

const rule = (description: string, create: Rule["create"], fixable?: "code") =>
  defineRule("suggestion", description, create, { fixable });

/** Collect every definition in the file, then check them once the file is read. */
function onDefinitions(
  check: (definitions: Definition[], program: Node) => void,
) {
  const definitions: Definition[] = [];
  return {
    CallExpression(node: Node) {
      const definition = definitionOf(node);
      if (definition) definitions.push(definition);
    },
    "Program:exit"(program: Node) {
      check(definitions, program);
    },
  };
}

const SERVICE_FOLDERS: Partial<Record<string, string>> = {
  action: "actions",
  tool: "tools",
  socket: "sockets",
  listener: "listeners",
  schedule: "schedules",
  workflow: "workflows",
  step: "workflows",
  table: "tables",
};

export const layoutRules: Record<string, Rule> = {
  "one-action-per-file": rule(
    "A *.action.ts file defines exactly one action, and actions are defined nowhere else.",
    (context) => {
      const info = fileInfo(context);
      if (info.exempt) return {};
      return onDefinitions((definitions, program) => {
        const actions = definitions.filter((d) => d.kind === "action");
        if (info.kind !== "action") {
          for (const action of actions)
            context.report({
              node: action.call,
              message: `Define this action in its own *.action.ts file.`,
            });
          return;
        }
        if (actions.length === 0)
          context.report({
            node: program,
            message: `${info.base} defines no action; a *.action.ts file defines exactly one.`,
          });
        for (const extra of actions.slice(1))
          context.report({
            node: extra.call,
            message: `${info.base} already defines an action; move this one to its own *.action.ts file.`,
          });
      });
    },
  ),

  "file-suffixes": rule(
    "Each kind of definition goes in a file with its suffix: .service, .action, .command, .tool, .socket, .listener, .schedule, .workflow, .step, .resource, .table, .events.",
    (context) => {
      const info = fileInfo(context);
      if (info.exempt) return {};
      return onDefinitions((definitions) => {
        for (const definition of definitions) {
          const kind = definition.kind;
          // Actions are one-action-per-file's; plugins and crud() have no file of their own.
          if (kind === "action" || kind === "plugin" || kind === "crud")
            continue;
          // A resource file holds its resource's child tables too.
          if (kind === "table" && info.kind === "resource") continue;
          if (info.kind !== kind)
            context.report({
              node: definition.call,
              message: `Define this ${kind} in a *.${kind}.ts file.`,
            });
        }
      });
    },
  ),

  "kind-folders": rule(
    "Files sit in their kind's folder, as in the project structure.",
    (context) => {
      const info = fileInfo(context);
      if (info.exempt || !info.kind) return {};
      return {
        Program(program: Node) {
          const report = (where: string) =>
            context.report({
              node: program,
              message: `Move ${info.base} to ${where}.`,
            });
          const kind = info.kind!;
          if (!info.inServices || !info.service)
            return report(
              `${info.settings.services}/<service>/, where it is registered`,
            );
          const service = `${info.settings.services}/${info.service}`;
          const rest = info.rest;
          if (kind === "service" || kind === "events") {
            if (rest.length !== 1) report(`${service}/`);
            return;
          }
          if (rest[0] === "resources") {
            const resource = `${service}/resources/${rest[1]}`;
            if ((kind === "resource" || kind === "table") && rest.length === 3)
              return;
            if (kind === "action" && rest.length === 4 && rest[2] === "actions")
              return;
            if (
              kind === "command" &&
              rest.length === 4 &&
              rest[2] === "commands"
            )
              return;
            if (kind === "resource" || kind === "table")
              return report(`${resource}/`);
            if (kind === "action" || kind === "command")
              return report(`${resource}/${kind}s/`);
            return report(`${service}/${SERVICE_FOLDERS[kind]}/`);
          }
          if (kind === "command" || kind === "resource")
            return report(`${service}/resources/<resource>/`);
          const folder = SERVICE_FOLDERS[kind];
          if (rest.length !== 2 || rest[0] !== folder)
            report(`${service}/${folder}/`);
        },
      };
    },
  ),

  "resource-folder": rule(
    "Each .resource.ts is alone in resources/<name>/, and resource actions and commands attach to their own folder's resource.",
    (context) => {
      const info = fileInfo(context);
      if (info.exempt || !info.inServices) return {};
      const inResource = info.rest[0] === "resources" && info.rest.length >= 3;
      const folder = inResource ? info.rest[1] : undefined;
      return onDefinitions((definitions, program) => {
        const imports = importSources(program);
        for (const definition of definitions) {
          if (definition.kind === "resource" && info.kind === "resource") {
            if (!folder || info.rest.length !== 3) continue; // kind-folders reports it
            if (definition.name && kebabCase(definition.name) !== folder)
              context.report({
                node: definition.nameNode,
                message: `Resource "${definition.name}" lives in resources/${kebabCase(definition.name)}/, not resources/${folder}/.`,
              });
            const siblings = readdirSync(dirname(context.filename)).filter(
              (file) => DEFINITION_FILE.exec(file)?.[2] === "resource",
            );
            if (siblings.length > 1)
              context.report({
                node: definition.call,
                message: `resources/${folder}/ holds ${siblings.length} resources; give each its own folder.`,
              });
          }
          if (
            definition.kind === "command" &&
            !(folder && info.rest[2] === "commands")
          )
            context.report({
              node: definition.call,
              message:
                "Commands exist only inside a resource folder: resources/<name>/commands/.",
            });
          if (
            folder &&
            (definition.kind === "action" || definition.kind === "command") &&
            definition.owner
          ) {
            const source = imports.get(definition.owner);
            const owner = source
              ?.split("/")
              .pop()
              ?.replace(/\.[cm]?[jt]sx?$/, "");
            if (source && owner !== `${folder}.resource`)
              context.report({
                node: definition.call.callee,
                message: `Files in resources/${folder}/ attach to the ${folder} resource (import it from "../${folder}.resource").`,
              });
          }
        }
      });
    },
  ),

  "file-name-matches": rule(
    "The file name is the kebab-case of the definition's name, without its owner.",
    (context) => {
      const info = fileInfo(context);
      if (info.exempt || !info.kind) return {};
      return onDefinitions((definitions) => {
        for (const definition of definitions) {
          if (definition.kind !== info.kind || !definition.name) continue;
          const expected = kebabCase(definition.name.split(".").pop()!);
          if (expected !== info.stem)
            context.report({
              node: definition.nameNode,
              message: `"${definition.name}" belongs in ${expected}.${info.kind}.ts, not ${info.base}.`,
            });
        }
      });
    },
  ),

  "service-folder": rule(
    "One defineService per *.service.ts, inside services/<name>/, where the folder name is the service name.",
    (context) => {
      const info = fileInfo(context);
      if (info.exempt || info.kind !== "service") return {};
      return onDefinitions((definitions, program) => {
        const services = definitions.filter((d) => d.kind === "service");
        if (services.length === 0)
          context.report({
            node: program,
            message: `${info.base} has no defineService(); a *.service.ts file defines exactly one.`,
          });
        for (const extra of services.slice(1))
          context.report({
            node: extra.call,
            message: `${info.base} already defines a service; give this one its own folder.`,
          });
        const service = services[0];
        if (!service?.name || !info.inServices) return;
        const folder = info.rest.length === 1 ? info.service : undefined;
        if (!serviceFolders(service.name).includes(folder!))
          context.report({
            node: service.nameNode,
            message: `Service "${service.name}" lives in ${info.settings.services}/${kebabCase(service.name)}/${kebabCase(service.name)}.service.ts.`,
          });
      });
    },
  ),

  "colocate-in-service": rule(
    "Everything under services/<name>/ attaches to that service, or to one of its resources.",
    (context) => {
      const info = fileInfo(context);
      if (info.exempt || !info.service) return {};
      return onDefinitions((definitions, program) => {
        const imports = importSources(program);
        for (const definition of definitions) {
          if (!definition.owner) continue;
          const source = imports.get(definition.owner);
          const path = source && resolveImport(info, context, source);
          if (!path?.startsWith(`${info.settings.services}/`)) continue;
          const owner = path
            .slice(info.settings.services.length + 1)
            .split("/")[0];
          if (owner !== info.service)
            context.report({
              node: definition.call.callee,
              message: `This file is in ${info.service}/ but attaches to ${owner}; move it to ${info.settings.services}/${owner}/.`,
            });
        }
      });
    },
  ),

  "workflow-directive": rule(
    'Workflow files use "use workflow", step files "use step", and the directives appear nowhere else.',
    (context) => {
      const info = fileInfo(context);
      if (info.exempt) return {};
      const found: Node[] = [];
      return {
        ExpressionStatement(node: Node) {
          if (
            node.directive === "use workflow" ||
            node.directive === "use step"
          )
            found.push(node);
        },
        "Program:exit"(program: Node) {
          const own =
            info.kind === "workflow"
              ? "use workflow"
              : info.kind === "step"
                ? "use step"
                : undefined;
          for (const node of found)
            if (node.directive !== own)
              context.report({
                node,
                message: `"${node.directive}" belongs in a *.${node.directive === "use step" ? "step" : "workflow"}.ts file.`,
              });
          if (own && !found.some((node) => node.directive === own))
            context.report({
              node: program,
              message: `${info.base} must start with "${own}".`,
              fix: (fixer) =>
                fixer.insertTextBeforeRange([0, 0], `"${own}";\n\n`),
            });
        },
      };
    },
    "code",
  ),
};
