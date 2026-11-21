/**
 * NOT part of Brick. Brick has no `Domain.Api`-style surface: it serves HTTP
 * from services, and MCP only from tools you define one by one with
 * `defineTool`. These two helpers fill that gap for this example by reading
 * what Brick already knows about each action (name, description, input and
 * output schemas, route) and building the MCP tools and CLI from it.
 */
import { createMcpRegistry, defineTool, t, type Service } from "@brickkit/core";
import { parseArgs } from "node:util";

export interface Surface {
  name: string;
  /** The Brick service that holds the actions. */
  service: string;
  /** Surface name → the Brick action it runs (`resource.action` or `action`). */
  commands: Record<string, string>;
  views: Record<string, string>;
  queries: Record<string, string>;
}

type Kind = "command" | "view" | "query";

export interface Entry {
  name: string;
  kind: Kind;
  action: string;
}

/** Which surface entries a surface offers. Everything, when left out. */
export type Expose = (entry: Entry) => boolean;

const entries = (surface: Surface, expose: Expose = () => true): Entry[] =>
  (
    [
      ["command", surface.commands],
      ["view", surface.views],
      ["query", surface.queries],
    ] as const
  )
    .flatMap(([kind, map]) =>
      Object.entries(map).map(([name, action]) => ({
        name,
        kind: kind as Kind,
        action,
      })),
    )
    .filter(expose);

const unknownAction = (
  surface: Surface,
  name: string,
  action: string,
  known: string[],
) =>
  new Error(
    `${surface.name}.${name} maps to '${action}', which '${surface.service}' does not define. It defines: ${known.join(", ")}`,
  );

const words = (name: string, separator: string) =>
  name.replace(/[A-Z]/g, (c, i) => (i ? separator : "") + c.toLowerCase());

/** `StartThread` → `start_thread`, the MCP tool name. */
export const toolName = (name: string) => words(name, "_");
/** `StartThread` → `start-thread`, the CLI subcommand. */
export const commandName = (name: string) => words(name, "-");

// ── MCP ──────────────────────────────────────────────────────────────────

/**
 * One MCP tool per surface entry. A tool runs the Brick action itself, so
 * validation, `authorize`, transactions and events are the HTTP route's.
 * Views and queries are marked read-only.
 *
 * @returns A registry for `createMcpHandler`.
 */
export function toMcp(
  surface: Surface,
  service: Service<any, any>,
  options: { expose?: Expose } = {},
) {
  return createMcpRegistry({
    tools: entries(surface, options.expose).map(({ name, kind, action }) => {
      const target = service.getAction(action);
      if (!target)
        throw unknownAction(
          surface,
          name,
          action,
          service.listActions().map((a) => a.name),
        );
      return defineTool({
        name: toolName(name),
        description: target.config.description,
        input: target.config.input ?? t.Object({}),
        output: target.config.output,
        annotations: kind === "command" ? {} : { readOnlyHint: true },
        execute: ({ input, ctx }: { input: unknown; ctx: unknown }) =>
          target({ input, ctx: ctx as never }),
      } as never);
    }),
  });
}

// ── CLI ──────────────────────────────────────────────────────────────────

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}
interface Operation {
  name: string;
  kind: Kind;
  method: string;
  path: string;
  description: string;
  input: JsonSchema;
}

export interface CliOptions {
  name: string;
  baseUrl: string;
  headers?: () => Record<string, string>;
  expose?: Expose;
}

/**
 * One CLI subcommand per surface entry: `board claim-task <id> --lease-ms ...`.
 * It reads each action's route and input schema from the server's
 * `/_brick/services`, so the flags follow the model without a copy of it.
 */
export function toCli(surface: Surface, options: CliOptions) {
  const out = (line: string) => console.log(line);

  async function load(): Promise<Operation[]> {
    const response = await fetch(`${options.baseUrl}/_brick/services`);
    if (!response.ok)
      throw new Error(`${options.baseUrl}/_brick/services: ${response.status}`);
    const { services } = (await response.json()) as {
      services: {
        name: string;
        actions: {
          name: string;
          method?: string;
          path?: string;
          description?: string;
          inputSchema?: JsonSchema;
        }[];
      }[];
    };
    const actions = services.find((s) => s.name === surface.service)?.actions;
    return entries(surface, options.expose).map(({ name, kind, action }) => {
      const found = actions?.find((a) => a.name === action);
      if (!found)
        throw unknownAction(
          surface,
          name,
          action,
          (actions ?? []).map((a) => a.name),
        );
      if (!found.path || !found.method)
        throw new Error(`the server has no route for '${action}'`);
      return {
        name,
        kind,
        method: found.method,
        path: found.path,
        description: found.description ?? "",
        input: found.inputSchema ?? {},
      };
    });
  }

  // `id` is the one positional, whether it is in the path or in the body.
  const hasId = (op: Operation) => op.input.properties?.id !== undefined;
  const flagsOf = (op: Operation) =>
    Object.entries(op.input.properties ?? {}).filter(([key]) => key !== "id");

  function help(ops: Operation[], op?: Operation) {
    if (!op) {
      out(`usage: ${options.name} <command> [id] [--flag value]\n`);
      for (const kind of ["command", "view", "query"] as const)
        for (const o of ops.filter((x) => x.kind === kind))
          out(
            `  ${commandName(o.name).padEnd(22)} ${o.kind.padEnd(8)} ${o.description}`,
          );
      return;
    }
    out(
      `${options.name} ${commandName(op.name)}${hasId(op) ? " <id>" : ""}  ${op.description}\n`,
    );
    for (const [key, schema] of flagsOf(op)) {
      const need = op.input.required?.includes(key) ? " (required)" : "";
      out(
        `  --${words(key, "-")} <${schema.type ?? "value"}>${need}  ${schema.description ?? ""}`,
      );
    }
  }

  // `--labels a=b --labels '{"c":"d"}'` for an object field; numbers as numbers.
  function body(op: Operation, values: Record<string, unknown>) {
    const result: Record<string, unknown> = {};
    for (const [key, schema] of flagsOf(op)) {
      const raw = values[words(key, "-")];
      if (raw === undefined) continue;
      if (schema.type === "object")
        result[key] = Object.assign(
          {},
          ...(raw as string[]).map((item) => {
            if (item.startsWith("{")) return JSON.parse(item);
            const at = item.indexOf("=");
            return { [item.slice(0, at)]: item.slice(at + 1) };
          }),
        );
      else if (schema.type === "integer" || schema.type === "number")
        result[key] = Number(raw);
      else result[key] = raw;
    }
    return result;
  }

  return {
    /** @returns The process exit code. */
    async run(argv: string[]): Promise<number> {
      try {
        const ops = await load();
        const [command, ...rest] = argv;
        const op = ops.find((o) => commandName(o.name) === command);
        if (!command || command === "--help" || command === "-h") {
          help(ops);
          return 0;
        }
        if (!op) {
          console.error(`unknown command '${command}'. Try --help.`);
          return 2;
        }
        const { values, positionals } = parseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            help: { type: "boolean", short: "h" },
            ...Object.fromEntries(
              flagsOf(op).map(([key, schema]) => [
                words(key, "-"),
                schema.type === "object"
                  ? { type: "string" as const, multiple: true }
                  : { type: "string" as const },
              ]),
            ),
          },
        });
        if (values.help) {
          help(ops, op);
          return 0;
        }
        if (hasId(op) && !positionals[0]) {
          console.error(`${commandName(op.name)} needs an <id>`);
          return 2;
        }
        const payload = body(op, values);
        if (hasId(op) && !op.path.includes(":id")) payload.id = positionals[0];
        const missing = (op.input.required ?? []).filter(
          (key) => key !== "id" && payload[key] === undefined,
        );
        if (missing.length) {
          console.error(
            `missing: ${missing.map((k) => `--${words(k, "-")}`).join(" ")}`,
          );
          return 2;
        }
        const response = await fetch(
          options.baseUrl +
            op.path.replace(":id", encodeURIComponent(positionals[0] ?? "")),
          {
            method: op.method,
            headers: {
              "content-type": "application/json",
              ...options.headers?.(),
            },
            body: JSON.stringify(payload),
          },
        );
        const result = await response.json();
        out(JSON.stringify(result, null, 2));
        return response.ok ? 0 : 1;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    },
  };
}
