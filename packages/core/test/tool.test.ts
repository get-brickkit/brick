import { describe, expect, it } from "bun:test";
import {
  createMcpHandler,
  createMcpRegistry,
  defineService,
  defineTool,
  generateOpenApiSpec,
  t,
} from "../src";
import { defineElsewhere } from "./fixtures/define-elsewhere";

let serviceCount = 0;
function setup() {
  const service = defineService(`tool_tests_${++serviceCount}`, {
    context: ({ user: claim }) => ({
      user:
        typeof claim === "object" &&
        claim !== null &&
        "id" in claim &&
        claim.id === "alice"
          ? { id: claim.id }
          : null,
    }),
  });
  const echo = service.tool({
    name: "echo",
    title: "Echo Message",
    annotations: { readOnlyHint: true, openWorldHint: false },
    description: "Echo for the current user",
    input: t.Object({ message: t.String() }, { additionalProperties: false }),
    output: t.String(),
    authorize: ({ user }) => !!user,
    execute: ({ input, ctx }) => `${input.message}:${ctx.user.id}`,
  });
  const registry = createMcpRegistry({ services: [service] });
  const handler = createMcpHandler({
    registry,
    serverInfo: { name: "test", version: "1" },
  });
  return { service, echo, registry, handler };
}

function rpc(method: string, params?: unknown, id: unknown = 1) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

describe("tools", () => {
  it("lists metadata and schema without registering HTTP actions or OpenAPI", () => {
    const { service, echo, registry } = setup();
    expect(service.listActions()).toEqual([]);
    expect(service.getTool("echo")).toBe(echo);
    expect(registry.listTools()).toEqual([
      {
        name: "echo",
        title: "Echo Message",
        description: "Echo for the current user",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: echo.config.input,
        // MCP needs an object outputSchema, so the string is wrapped.
        outputSchema: {
          type: "object",
          properties: { result: echo.config.output },
          required: ["result"],
          "x-brick-wrap-result": true,
        },
      },
    ]);
    expect(generateOpenApiSpec({ services: [service] }).paths).toEqual({});
  });

  it("reuses validation, authorization and resolved service context", async () => {
    const { registry } = setup();
    await expect(
      registry.callTool(
        "echo",
        { message: "hello" },
        { user: { id: "alice" } },
      ),
    ).resolves.toBe("hello:alice");
    await expect(registry.callTool("echo", { message: 1 })).rejects.toThrow(
      "Validation failed",
    );
    await expect(
      registry.callTool("echo", { message: "hello" }),
    ).rejects.toThrow();
    await expect(registry.callTool("missing")).rejects.toThrow(
      "unknown tool: missing",
    );
  });

  it("registers HTTP only when explicitly requested", () => {
    const { service, echo } = setup();
    service.action(echo);
    expect(service.listActions()).toContain(echo);
    expect(
      generateOpenApiSpec({ services: [service] }).paths[
        `/api/${service.name}/echo`
      ],
    ).toBeDefined();
    const publicTool = service.tool({
      name: "public",
      http: true,
      execute: () => "ok",
    });
    expect(service.listActions()).toContain(publicTool);
    expect(service.listTools()).toContain(publicTool);
  });

  it("supports standalone tools, late definitions and detects duplicate names", () => {
    const { service, registry } = setup();
    const standalone = defineTool({ name: "later", execute: () => "ok" });
    expect(service.tool(standalone)).toBe(service);
    expect(registry.listTools().map((tool) => tool.name)).toEqual([
      "echo",
      "later",
    ]);
    expect(registry.listTools()[1]?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(() =>
      defineElsewhere(service, "tool", {
        name: "echo",
        execute: () => "other",
      }),
    ).toThrow(`duplicate tool "echo"`);
    expect(() =>
      createMcpRegistry({
        services: [service],
        tools: [defineTool({ name: "echo", execute: () => "other" })],
      }),
    ).toThrow("Duplicate MCP tool");
    expect(() =>
      defineTool({
        name: "primitive",
        input: t.String(),
        execute: () => "other",
      }),
    ).toThrow("object schema");
  });

  it("initializes, lists tools, acknowledges notifications and handles ping", async () => {
    const { handler } = setup();
    const initialized = await (
      await handler(rpc("initialize", { protocolVersion: "unsupported" }))
    ).json();
    expect(initialized.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "test", version: "1" },
    });
    expect(
      (await (await handler(rpc("tools/list"))).json()).result.tools[0].name,
    ).toBe("echo");
    const notification = new Request("http://localhost/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    });
    expect((await handler(notification)).status).toBe(202);
    expect((await (await handler(rpc("ping"))).json()).result).toEqual({});
  });

  it("separates tool failures from JSON-RPC errors", async () => {
    const { handler } = setup();
    const success = await (
      await handler(
        rpc("tools/call", { name: "echo", arguments: { message: "hi" } }),
        { user: { id: "alice" } },
      )
    ).json();
    expect(success.result.content).toEqual([
      { type: "text", text: "hi:alice" },
    ]);
    // A string output travels wrapped, matching its outputSchema.
    expect(success.result.structuredContent).toEqual({ result: "hi:alice" });
    const denied = await (
      await handler(
        rpc("tools/call", { name: "echo", arguments: { message: "hi" } }),
      )
    ).json();
    expect(denied.result.isError).toBe(true);
    const invalid = await (
      await handler(
        rpc("tools/call", { name: "echo", arguments: { message: 1 } }),
      )
    ).json();
    expect(invalid.result.isError).toBe(true);
    for (const params of [
      { name: "missing" },
      { arguments: {} },
      { name: "echo", arguments: [] },
    ]) {
      expect(
        (await (await handler(rpc("tools/call", params))).json()).error.code,
      ).toBe(-32602);
    }
    expect((await (await handler(rpc("missing"))).json()).error.code).toBe(
      -32601,
    );
    for (const body of [
      "null",
      "[]",
      "{}",
      '{"method":"ping","id":1}',
      '{"jsonrpc":"2.0","method":"ping","id":[]}',
    ]) {
      expect(
        (
          await (
            await handler(
              new Request("http://localhost/mcp", { method: "POST", body }),
            )
          ).json()
        ).error.code,
      ).toBe(-32600);
    }
    const badJson = await (
      await handler(
        new Request("http://localhost/mcp", { method: "POST", body: "{" }),
      )
    ).json();
    expect(badJson.error.code).toBe(-32700);
    expect((await handler(new Request("http://localhost/mcp"))).status).toBe(
      405,
    );
  });
});

function _typeAssertions() {
  const { echo, service } = setup();
  const input: Parameters<typeof echo.run>[0] = { message: "hello" };
  const output: Promise<string> = echo.run(input, { user: { id: "alice" } });
  // @ts-expect-error Tool inputs must retain their schema type.
  echo.run({ message: 123 });
  // @ts-expect-error Tool outputs must retain their schema type.
  const wrongOutput: Promise<number> = echo.run(input);
  service.tool({
    name: "typed_context",
    input: t.Object({ enabled: t.Boolean() }),
    output: t.String(),
    authorize: ({ user }) => !!user,
    annotations: {
      title: "Typed",
      idempotentHint: true,
      destructiveHint: false,
    },
    execute: ({ input, ctx }) => {
      const enabled: boolean = input.enabled;
      const userId: string = ctx.user.id;
      // @ts-expect-error The context still has a typed user.
      void ctx.user.missing;
      return enabled ? userId : "disabled";
    },
  });
  return { output, wrongOutput };
}
