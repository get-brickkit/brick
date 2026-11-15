import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  spyOn,
} from "bun:test";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  brick,
  compileBrickApplication,
  createMcpRegistry,
  defineAction,
  defineService,
  generateOpenApiSpec,
  GLOBAL_SYMBOL,
  resetGlobalRegistry,
  t,
} from "@brickkit/core";
import { postJson } from "./helpers";

const TOKEN = "tok_live_4f9a8b7c6d5e";
const exporter = new InMemorySpanExporter();
const CAPTURE = Symbol.for(GLOBAL_SYMBOL.logsCapture);

beforeAll(() => {
  trace.setGlobalTracerProvider(
    new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    }),
  );
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
});
afterAll(() => {
  trace.disable();
  context.disable();
});
beforeEach(resetGlobalRegistry);
afterEach(() => {
  (globalThis as Record<symbol, unknown>)[CAPTURE] = undefined;
  exporter.reset();
});

const Credential = t.Object({
  id: t.String(),
  accessToken: t.Optional(t.Sensitive(t.String())),
});

function credentials(reveal?: Parameters<typeof defineAction>[0]["reveal"]) {
  const service = defineService("integrations");
  const action = service.action({
    name: "getCredential",
    input: t.Object({ id: t.String() }),
    output: Credential,
    reveal,
    execute: ({ input }) => ({ id: input.id, accessToken: TOKEN }),
  });
  const app = brick({
    services: [service],
    requestLogging: false,
    docs: false,
  });
  return { action, app };
}

it("strips a sensitive output field by default, over HTTP and in-process", async () => {
  const { action, app } = credentials();
  const response = await postJson(app, "/api/integrations/get-credential", {
    id: "c1",
  });
  expect(await response.json()).toEqual({ id: "c1" });
  expect(await action.run({ id: "c1" })).toEqual({ id: "c1" });
});

it("strips it from an MCP tool call too", async () => {
  const service = defineService("integrations");
  service.tool({
    name: "getCredential",
    input: t.Object({ id: t.String() }),
    output: Credential,
    execute: ({ input }) => ({ id: input.id, accessToken: TOKEN }),
  });
  const registry = createMcpRegistry({ services: [service] });
  expect(await registry.callTool("getCredential", { id: "c1" })).toEqual({
    id: "c1",
  });
});

it("keeps a required sensitive field when reveal is true", async () => {
  const service = defineService("keys");
  const action = service.action({
    name: "createApiKey",
    output: t.Object({ id: t.String(), secret: t.Sensitive(t.String()) }),
    reveal: true,
    execute: () => ({ id: "k1", secret: TOKEN }),
  });
  const app = brick({
    services: [service],
    requestLogging: false,
    docs: false,
  });
  const response = await postJson(app, "/api/keys/create-api-key");
  expect(await response.json()).toEqual({ id: "k1", secret: TOKEN });
  expect(await action.run()).toEqual({ id: "k1", secret: TOKEN });
});

it("asks reveal per field and call: one caller gets the field, another does not", async () => {
  const { action } = credentials(
    async ({ field, ctx }) =>
      field === "/accessToken" && ctx.caller === "mailer",
  );
  expect(await action.run({ id: "c1" }, { caller: "mailer" })).toEqual({
    id: "c1",
    accessToken: TOKEN,
  });
  expect(await action.run({ id: "c1" }, { caller: "billing" })).toEqual({
    id: "c1",
  });
});

it("follows nested objects and arrays, naming each field by its JSON pointer", async () => {
  const fields: string[] = [];
  const rows = [
    { id: "a", token: "token-a-123456" },
    { id: "b", token: "token-b-123456" },
  ];
  const result = { items: rows, owner: { name: "o", key: "owner-key-123456" } };
  const action = defineAction({
    name: "listTokens",
    output: t.Object({
      items: t.Array(
        t.Object({
          id: t.String(),
          token: t.Optional(t.Sensitive(t.String())),
        }),
      ),
      owner: t.Object({
        name: t.String(),
        key: t.Optional(t.Sensitive(t.String())),
      }),
    }),
    reveal: ({ field }) => {
      fields.push(field);
      return field === "/items/1/token";
    },
    execute: () => result,
  });
  expect(await action.run()).toEqual({
    items: [{ id: "a" }, { id: "b", token: "token-b-123456" }],
    owner: { name: "o" },
  });
  expect(fields.sort()).toEqual([
    "/items/0/token",
    "/items/1/token",
    "/owner/key",
  ]);
  // The value `execute` returned is not changed.
  expect(rows[0]!.token).toBe("token-a-123456");
});

it("refuses at startup a required sensitive output field without reveal: true", () => {
  for (const reveal of [undefined, false, () => true])
    expect(() =>
      defineAction({
        name: "leaky",
        output: t.Object({
          items: t.Array(t.Object({ token: t.Sensitive(t.String()) })),
        }),
        reveal,
        execute: () => ({ items: [] }),
      }),
    ).toThrow(
      "Action 'leaky': sensitive output field '/items/*/token' is removed unless `reveal` allows it, so it must be t.Optional",
    );
});

it("keeps a sensitive input value out of logs, error logs and spans", async () => {
  (globalThis as Record<symbol, unknown>)[CAPTURE] = undefined;
  const service = defineService("auth");
  service.action({
    name: "connect",
    input: t.Object({ user: t.String(), password: t.Sensitive(t.String()) }),
    execute: ({ input, ctx }) => {
      ctx.logger.info(input);
      ctx.logger.warn(`connecting with ${input.password}`);
      throw new Error(`login failed for ${input.password}`);
    },
  });
  const app = brick({
    services: [service],
    requestLogging: false,
    docs: false,
    telemetry: true,
  });
  const lines: string[] = [];
  const spies = (["log", "warn", "error"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }),
  );
  try {
    // Printed to the console.
    let response = await postJson(app, "/api/auth/connect", {
      user: "ada",
      password: TOKEN,
    });
    expect(response.status).toBe(500);
    // Recorded on the span, as with a dashboard.
    (globalThis as Record<symbol, unknown>)[CAPTURE] = true;
    response = await postJson(app, "/api/auth/connect", {
      user: "ada",
      password: TOKEN,
    });
    expect(response.status).toBe(500);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  const spans = JSON.stringify(
    exporter.getFinishedSpans().map(({ attributes, events, status }) => ({
      attributes,
      events,
      status,
    })),
  );
  expect(lines.join("\n")).toContain("[REDACTED]");
  expect(lines.join("\n")).toContain("ada");
  expect(lines.join("\n")).not.toContain(TOKEN);
  expect(spans).toContain("[REDACTED]");
  expect(spans).not.toContain(TOKEN);
});

it("keeps the synchronous fast path for an action without sensitive fields", () => {
  const service = defineService("fast");
  service.action({
    name: "plain",
    output: Credential.properties.id,
    execute: () => "x",
  });
  service.action({
    name: "secret",
    output: Credential,
    execute: () => ({ id: "x" }),
  });
  const { routes } = compileBrickApplication({ services: [service] });
  const call = (action: string) =>
    routes
      .find((route) => route.ir.action === action)!
      .handler({
        request: new Request(`http://localhost/api/fast/${action}`, {
          method: "POST",
        }),
        headers: {},
        set: { headers: {} },
      });
  expect(call("plain")).toBe("x");
  expect(call("secret")).toBeInstanceOf(Promise);
});

it("marks a sensitive input write-only in OpenAPI", () => {
  const service = defineService("auth");
  service.action({
    name: "login",
    input: t.Object({ password: t.Sensitive(t.String()) }),
    execute: () => true,
  });
  const spec = generateOpenApiSpec({ services: [service] });
  const body =
    spec.paths["/api/auth/login"].post.requestBody.content["application/json"]
      .schema;
  expect(body.properties.password).toEqual({ type: "string", writeOnly: true });
});
