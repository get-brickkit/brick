import type { TSchema } from "@sinclair/typebox";
import { defineAction } from "./action";
import { fileFields } from "./typebox";
import type {
  Tool,
  ToolConfigWithAuthorize,
  ToolConfigWithoutAuthorize,
  ActionErrorDefinition,
  ActionContext,
} from "./types";

/**
 * Define a tool: an action that AI agents can call through MCP. It takes the
 * same configuration as `defineAction` (validation, `authorize`, errors), plus
 * `title`, `annotations` (the MCP hints about what the tool does), and `http`
 * to also serve it over HTTP and in OpenAPI (off by default).
 *
 * @param config - An action configuration and tool options. `input` must be an
 * object schema, since MCP passes arguments by name.
 * @returns The tool, which is also an action. Register it with `service.tool(tool)`.
 * @throws When `input` is not an object schema.
 * @example
 * import { defineTool, t } from "@brickkit/core";
 *
 * export const echoTool = defineTool({
 *   name: "echo",
 *   title: "Echo a message",
 *   description: "Returns the message it is given.",
 *   input: t.Object({ message: t.String() }),
 *   output: t.String(),
 *   execute: ({ input }) => `Echo: ${input.message}`,
 * });
 */
export function defineTool<
  TInputSchema extends TSchema | undefined = undefined,
  TOutputSchema extends TSchema | undefined = undefined,
  TErrors extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  TContext extends ActionContext = ActionContext,
>(
  config: ToolConfigWithAuthorize<
    TInputSchema,
    TOutputSchema,
    TErrors,
    TContext
  >,
): Tool<TInputSchema, TOutputSchema, TErrors, TContext>;

export function defineTool<
  TInputSchema extends TSchema | undefined = undefined,
  TOutputSchema extends TSchema | undefined = undefined,
  TErrors extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  TContext extends ActionContext = ActionContext,
>(
  config: ToolConfigWithoutAuthorize<
    TInputSchema,
    TOutputSchema,
    TErrors,
    TContext
  >,
): Tool<TInputSchema, TOutputSchema, TErrors, TContext>;

export function defineTool(config: any): any {
  if (config.input && config.input.type !== "object") {
    throw new Error(`Tool '${config.name}' input must be an object schema`);
  }
  if (fileFields(config.input).length) {
    throw new Error(
      `Tool '${config.name}' input has file fields; MCP carries JSON only, so take uploads in an action`,
    );
  }
  const tool = defineAction(config);
  Object.defineProperty(tool, "kind", { value: "tool" });
  return tool;
}

/**
 * Whether a value was made with `defineTool`, as opposed to `defineAction`.
 *
 * @param value - Anything.
 * @returns `true` for a tool, narrowing its type.
 */
export function isTool(value: unknown): value is Tool<any, any, any, any> {
  return typeof value === "function" && (value as Tool).kind === "tool";
}
