import type { ActionContext, Service, Tool, ToolAnnotations } from "./types";

export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  /** The tool's `output` schema; a non-object one is wrapped as `{ result }`. */
  outputSchema?: unknown;
  annotations: ToolAnnotations;
}

export interface McpRegistryOptions {
  services?: readonly Pick<Service<any, any>, "listTools">[];
  tools?: readonly Tool<any, any, any, any>[];
}

export interface McpRegistry {
  listTools(): McpToolDefinition[];
  callTool(
    name: string,
    args?: Record<string, unknown>,
    ctx?: Partial<ActionContext>,
  ): Promise<unknown>;
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`unknown tool: ${name}`);
    this.name = "UnknownToolError";
  }
}

/** Collect only explicitly defined tools, without exposing ordinary actions. */
export function createMcpRegistry(options: McpRegistryOptions): McpRegistry {
  function toolsByName() {
    const tools = new Map<string, Tool<any, any, any, any>>();
    for (const tool of [
      ...(options.tools ?? []),
      ...(options.services ?? []).flatMap((service) => service.listTools()),
    ]) {
      const existing = tools.get(tool.name);
      if (existing && existing !== tool)
        throw new Error(`Duplicate MCP tool: ${tool.name}`);
      tools.set(tool.name, tool);
    }
    return tools;
  }
  toolsByName();
  return {
    listTools: () =>
      Array.from(toolsByName().values(), (tool) => ({
        name: tool.name,
        ...((tool.config.title ?? tool.config.annotations?.title)
          ? { title: tool.config.title ?? tool.config.annotations?.title }
          : {}),
        description: tool.config.description ?? "",
        inputSchema: tool.config.input ?? {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        ...(tool.config.output
          ? { outputSchema: outputSchema(tool.config.output) }
          : {}),
        annotations: tool.config.annotations ?? {},
      })),
    async callTool(name, args = {}, ctx) {
      const tool = toolsByName().get(name);
      if (!tool) throw new UnknownToolError(name);
      return tool({ input: args, ctx });
    },
  };
}

// MCP requires an object outputSchema, so other outputs travel as `{ result }`.
const WRAP_RESULT = "x-brick-wrap-result";
function outputSchema(schema: { type?: unknown }) {
  return schema.type === "object"
    ? schema
    : {
        type: "object",
        properties: { result: schema },
        required: ["result"],
        [WRAP_RESULT]: true,
      };
}

export interface McpHandlerOptions {
  registry: McpRegistry;
  serverInfo: { name: string; version: string; title?: string };
  /** Versions supported by this transport, newest first. */
  protocolVersions?: readonly string[];
}

function result(id: unknown, value: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result: value });
}
function rpcError(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Stateless MCP JSON-RPC POST handler. Wrap with the app's authentication. */
export function createMcpHandler(options: McpHandlerOptions) {
  const versions = options.protocolVersions ?? ["2025-06-18"];
  if (!versions.length)
    throw new Error("At least one MCP protocol version is required");
  return async (
    request: Request,
    ctx?: Partial<ActionContext>,
  ): Promise<Response> => {
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return rpcError(null, -32700, "parse error");
    }
    if (
      !isRecord(body) ||
      body.jsonrpc !== "2.0" ||
      typeof body.method !== "string" ||
      (body.id !== undefined &&
        body.id !== null &&
        typeof body.id !== "string" &&
        typeof body.id !== "number") ||
      (body.params !== undefined && !isRecord(body.params))
    ) {
      return rpcError(null, -32600, "invalid request");
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    const { id, method } = body;
    const params = body.params as Record<string, unknown> | undefined;
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return result(id, {
          capabilities: { tools: {} },
          protocolVersion:
            typeof requested === "string" && versions.includes(requested)
              ? requested
              : versions[0],
          serverInfo: options.serverInfo,
        });
      }
      case "ping":
        return result(id, {});
      case "tools/list":
        try {
          return result(id, { tools: options.registry.listTools() });
        } catch {
          return rpcError(id, -32603, "internal error");
        }
      case "tools/call": {
        if (
          typeof params?.name !== "string" ||
          (params.arguments !== undefined && !isRecord(params.arguments))
        ) {
          return rpcError(id, -32602, "invalid tool parameters");
        }
        try {
          const value = await options.registry.callTool(
            params.name,
            params.arguments as Record<string, unknown> | undefined,
            { ...ctx, request },
          );
          const schema = options.registry
            .listTools()
            .find((tool) => tool.name === params.name)?.outputSchema as
            | Record<string, unknown>
            | undefined;
          return result(id, {
            content: [
              {
                type: "text",
                text:
                  typeof value === "string"
                    ? value
                    : (JSON.stringify(value, null, 2) ?? "null"),
              },
            ],
            ...(schema
              ? {
                  structuredContent: schema[WRAP_RESULT]
                    ? { result: value }
                    : value,
                }
              : {}),
          });
        } catch (error) {
          if (error instanceof UnknownToolError)
            return rpcError(id, -32602, error.message);
          return result(id, {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          });
        }
      }
      default:
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  };
}

export interface McpOptions {
  /** Where the endpoint is served (default `/mcp`). */
  path?: string;
  /**
   * Runs on every MCP request after `auth.resolve`, with the principal it
   * returned as `user` (`null` without one). Return `false` to answer 401, or a
   * `Response` to answer with it (such as an OAuth `WWW-Authenticate`
   * challenge); anything else lets the request through.
   */
  authorize?: (ctx: {
    request: Request;
    user: unknown;
  }) => boolean | Response | void | Promise<boolean | Response | void>;
}

/** The `brick({ mcp })` endpoint: resolve the caller, authorize, then answer. */
export function createMcpRoute(
  options: McpOptions & {
    registry: McpRegistry;
    serverInfo: McpHandlerOptions["serverInfo"];
    resolveUser?: (request: Request) => unknown;
  },
) {
  const handle = createMcpHandler(options);
  return async (request: Request): Promise<Response> => {
    const user = (await options.resolveUser?.(request)) ?? null;
    const verdict = await options.authorize?.({ request, user });
    if (verdict instanceof Response) return verdict;
    if (verdict === false)
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32001, message: "unauthorized" },
        },
        { status: 401 },
      );
    return handle(request, { user });
  };
}
