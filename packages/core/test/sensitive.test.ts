import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  spyOn,
} from "bun:test";
import { format } from "node:util";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
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
  createMcpHandler,
  createMcpRegistry,
  defineAction,
  defineDatabase,
  defineService,
  generateOpenApiSpec,
  GLOBAL_SYMBOL,
  redact,
  resetGlobalRegistry,
  syncSchema,
  t,
  type Service,
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
      "Action 'leaky': sensitive output field '/items/*/token' is removed unless `reveal` allows it, so the schema must let it be absent",
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
      lines.push(format(...args));
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
  expect(lines.join("\n")).toContain("password: '[REDACTED]'");
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

/** What `fn` printed to the console, and what its spans recorded when it ran again under a dashboard capture. */
async function observe(fn: () => Promise<unknown>) {
  const lines: string[] = [];
  const spies = (["log", "warn", "error", "debug"] as const).map((level) =>
    spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(format(...args));
    }),
  );
  const results: unknown[] = [];
  try {
    results.push(await fn());
    (globalThis as Record<symbol, unknown>)[CAPTURE] = true;
    results.push(await fn());
  } finally {
    (globalThis as Record<symbol, unknown>)[CAPTURE] = undefined;
    for (const spy of spies) spy.mockRestore();
  }
  const spans = JSON.stringify(
    exporter.getFinishedSpans().map(({ attributes, events, status }) => ({
      attributes,
      events,
      status,
    })),
  );
  return { console: lines.join("\n"), spans, results };
}

/** An app over one service, traced, without request logs. */
const appOf = (service: Service<any, any, any>) =>
  brick({
    services: [service],
    requestLogging: false,
    docs: false,
    telemetry: true,
  });

it("redacts a secret registered with redact() before execute logs it or throws it", async () => {
  const service = defineService("integrations");
  service.action({
    name: "refresh",
    input: t.Object({ id: t.String(), pin: t.Sensitive(t.String()) }),
    errors: { EXPIRED: { status: 409, message: "Expired" } },
    execute: ({ input, ctx, error }) => {
      const credential = { id: input.id, accessToken: TOKEN };
      redact(credential.accessToken);
      ctx.logger.info("loaded", credential);
      throw error.EXPIRED(`token ${credential.accessToken} expired`);
    },
  });
  const app = appOf(service);
  const seen = await observe(async () => {
    const response = await postJson(app, "/api/integrations/refresh", {
      id: "c1",
      pin: "000000",
    });
    return response.json();
  });
  for (const body of seen.results)
    expect(body).toMatchObject({ message: "token [REDACTED] expired" });
  expect(seen.console).toContain("accessToken: '[REDACTED]'");
  expect(seen.console).not.toContain(TOKEN);
  expect(seen.spans).not.toContain(TOKEN);
  // Outside a call it does nothing.
  expect(() => redact(TOKEN)).not.toThrow();
});

it("redacts a logged object's secret that has a newline, quotes and backslashes, or is very long", async () => {
  const pem = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----`;
  const json = `{"private_key":"line\\\\one","client_email":"svc@example.com"}`;
  const long = `L0ng${"x".repeat(12_000)}`;
  const service = defineService("keys");
  service.action({
    name: "store",
    input: t.Object({
      pem: t.Sensitive(t.String()),
      json: t.Sensitive(t.String()),
      long: t.Sensitive(t.String()),
    }),
    execute: ({ input, ctx }) => {
      ctx.logger.info(input);
      ctx.logger.info({
        nested: { list: [new Map([["k", new Set([input.pem])]])] },
      });
      return true;
    },
  });
  const app = appOf(service);
  const seen = await observe(() =>
    postJson(app, "/api/keys/store", { pem, json, long }),
  );
  for (const text of [seen.console, seen.spans]) {
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC");
    expect(text).not.toContain("svc@example.com");
    expect(text).not.toContain("L0ngxxxx");
  }
});

it("redacts a short logged value equal to a sensitive one, but not short text inside a line", async () => {
  const service = defineService("otp");
  service.action({
    name: "verify",
    input: t.Object({ user: t.String(), otp: t.Sensitive(t.String()) }),
    execute: ({ input, ctx }) => {
      ctx.logger.info(input);
      ctx.logger.info(`otp=${input.otp}`);
      return true;
    },
  });
  const app = appOf(service);
  const seen = await observe(() =>
    postJson(app, "/api/otp/verify", { user: "ada", otp: "493817" }),
  );
  for (const text of [seen.console, seen.spans]) {
    expect(text).toContain("otp: '[REDACTED]'");
    // Text shorter than 8 characters is not matched inside a line.
    expect(text).toContain("otp=493817");
  }
});

it("redacts a long value interpolated into a line", async () => {
  const service = defineService("otp");
  service.action({
    name: "verify",
    input: t.Object({ otp: t.Sensitive(t.String()) }),
    execute: ({ input, ctx }) => {
      ctx.logger.info(`otp=${input.otp}`);
      return true;
    },
  });
  const seen = await observe(() =>
    postJson(appOf(service), "/api/otp/verify", { otp: "49381712" }),
  );
  for (const text of [seen.console, seen.spans]) {
    expect(text).toContain("otp=[REDACTED]");
    expect(text).not.toContain("49381712");
  }
});

it("keeps a sensitive call's dashboard log line at depth 3", async () => {
  const service = defineService("deep");
  service.action({
    name: "log",
    input: t.Object({ secret: t.Sensitive(t.String()) }),
    execute: ({ ctx }) => {
      ctx.logger.info({ a: { b: { c: { d: "deepest" } } } });
      return true;
    },
  });
  const seen = await observe(() =>
    postJson(appOf(service), "/api/deep/log", { secret: TOKEN }),
  );
  expect(seen.spans).toContain("deepest");
});

it("redacts an HTTP error's message and details, as in-process", async () => {
  const service = defineService("auth");
  const login = service.action({
    name: "login",
    input: t.Object({ p: t.Sensitive(t.String()) }),
    execute: ({ input, error }) => {
      throw error.BAD_REQUEST(`bad password ${input.p}`, {
        tried: input.p,
        nested: { hint: `was ${input.p}` },
      });
    },
  });
  const body = await (
    await postJson(appOf(service), "/api/auth/login", { p: TOKEN })
  ).json();
  expect(body.message).toBe("bad password [REDACTED]");
  expect(body.details).toEqual({
    tried: "[REDACTED]",
    nested: { hint: "was [REDACTED]" },
  });
  // An error that leaves an in-process call.
  const thrown: any = await login.run({ p: TOKEN }).catch((err) => err);
  expect(thrown.message).toBe("bad password [REDACTED]");
  expect(JSON.stringify(thrown.details)).not.toContain(TOKEN);
  expect(thrown.stack).not.toContain(TOKEN);
});

it("redacts an inner call's revealed output in the outer call's logs", async () => {
  const service = defineService("integrations");
  const inner = service.action({
    name: "getCredential",
    input: t.Object({ id: t.String() }),
    output: Credential,
    reveal: true,
    execute: ({ input }) => ({ id: input.id, accessToken: TOKEN }),
  });
  service.action({
    name: "sync",
    input: t.Object({ password: t.Sensitive(t.String()) }),
    execute: async ({ ctx }) => {
      const credential = await inner.run({ id: "c1" });
      ctx.logger.info("using", credential);
      ctx.logger.info(`using ${credential.accessToken}`);
      return true;
    },
  });
  const seen = await observe(() =>
    postJson(appOf(service), "/api/integrations/sync", {
      password: "pw-123456789",
    }),
  );
  expect(seen.console).toContain("accessToken: '[REDACTED]'");
  for (const text of [seen.console, seen.spans])
    expect(text).not.toContain(TOKEN);
});

it("keeps two concurrent requests' sets apart", async () => {
  let arrived = 0;
  let release!: () => void;
  const both = new Promise<void>((resolve) => (release = resolve));
  const service = defineService("auth");
  service.action({
    name: "connect",
    input: t.Object({ password: t.Sensitive(t.String()), note: t.String() }),
    execute: async ({ input, ctx }) => {
      if (++arrived === 2) release();
      await both;
      ctx.logger.info(`note ${input.note}`);
      return true;
    },
  });
  const app = appOf(service);
  const first = "alpha-secret-111";
  const second = "bravo-secret-222";
  const seen = await observe(async () => {
    arrived = 0;
    await Promise.all([
      postJson(app, "/api/auth/connect", { password: first, note: second }),
      postJson(app, "/api/auth/connect", { password: second, note: first }),
    ]);
  });
  expect(seen.console).toContain(`note ${first}`);
  expect(seen.console).toContain(`note ${second}`);
});

it("asks a reveal function over HTTP, and removes the field when it answers anything but true or throws", async () => {
  const reveals: Record<string, unknown> = {
    byInput: ({ input }: any) => input.id === "c2",
    truthy: () => ({ allowed: false }),
    throws: () => {
      throw new Error("no");
    },
  };
  const service = defineService("integrations");
  for (const [name, reveal] of Object.entries(reveals))
    service.action({
      name,
      input: t.Object({ id: t.String() }),
      output: Credential,
      reveal: reveal as any,
      execute: ({ input }) => ({ id: input.id, accessToken: TOKEN }),
    });
  const app = brick({
    services: [service],
    requestLogging: false,
    docs: false,
  });
  const call = async (action: string, id: string) => {
    const response = await postJson(app, `/api/integrations/${action}`, { id });
    return { status: response.status, body: await response.text() };
  };
  expect(JSON.parse((await call("by-input", "c1")).body)).toEqual({ id: "c1" });
  expect(JSON.parse((await call("by-input", "c2")).body)).toEqual({
    id: "c2",
    accessToken: TOKEN,
  });
  expect(JSON.parse((await call("truthy", "c1")).body)).toEqual({ id: "c1" });
  const thrown = await call("throws", "c1");
  expect(thrown.status).toBe(500);
  expect(thrown.body).not.toContain(TOKEN);
});

it("removes sensitive record values, additionalProperties and union branch fields", async () => {
  const action = defineAction({
    name: "shapes",
    output: t.Object({
      byName: t.Record(t.String(), t.Sensitive(t.String())),
      extra: t.Object(
        { id: t.String() },
        { additionalProperties: t.Sensitive(t.String()) },
      ),
      pick: t.Union([
        t.Object({
          kind: t.Literal("a"),
          token: t.Optional(t.Sensitive(t.String())),
        }),
        t.Object({ kind: t.Literal("b") }),
      ]),
    }),
    execute: () => ({
      byName: { a: "secret-a-123456", b: "secret-b-123456" },
      extra: { id: "e1", key: "secret-c-123456" },
      pick: { kind: "a" as const, token: TOKEN },
    }),
  });
  expect(await action.run()).toEqual({
    byName: {},
    extra: { id: "e1" },
    pick: { kind: "a" },
  });
});

it("refuses at startup a mark another branch requires or a record cannot lose", () => {
  const plain = t.Object({ token: t.String() });
  const marked = t.Object({ token: t.Optional(t.Sensitive(t.String())) });
  for (const output of [
    t.Union([marked, plain]),
    t.Intersect([marked, plain]),
    t.Record(t.String(), t.Sensitive(t.String()), { minProperties: 1 }),
  ]) {
    const service = defineService(
      `shapes_${Math.random().toString(36).slice(2)}`,
    );
    expect(() =>
      service.action({ name: "leaky", output, execute: () => ({}) as any }),
    ).toThrow(
      /^Service 'shapes_\w+' action 'leaky': sensitive output field '\/(token|\*)' is removed/,
    );
  }
});

it("refuses at startup a mark inside a recursive schema, but not beside t.Json()", () => {
  const service = defineService("tree");
  expect(() =>
    service.action({
      name: "tree",
      output: t.Recursive((This) =>
        t.Object({
          token: t.Optional(t.Sensitive(t.String())),
          children: t.Array(This),
        }),
      ),
      execute: () => ({ children: [] }) as any,
    }),
  ).toThrow(
    "Service 'tree' action 'tree': the output schema marks a field t.Sensitive and has a $ref at '/children/*'",
  );
  expect(() =>
    service.action({
      name: "json",
      output: t.Object({
        data: t.Json(),
        token: t.Optional(t.Sensitive(t.String())),
      }),
      execute: () => ({ data: null }),
    }),
  ).not.toThrow();
});

it("refuses at startup a sensitive path parameter, socket field or event payload field", () => {
  const reset = defineService("reset");
  reset.action({
    name: "reset",
    path: "/reset/:token",
    input: t.Object({ token: t.Sensitive(t.String()) }),
    execute: () => true,
  });
  expect(() =>
    brick({ services: [reset], requestLogging: false, docs: false }),
  ).toThrow(
    "Service 'reset' action 'reset': sensitive input field '/token' is a path parameter of 'POST /api/reset/reset/:token'",
  );
  const chat = defineService("chat");
  expect(() =>
    chat.socket({
      name: "live",
      input: { say: t.Object({ key: t.Sensitive(t.String()) }) },
      output: {},
      handlers: { say: () => {} },
    }),
  ).toThrow(
    "Service 'chat' socket 'live': input.say marks '/key' t.Sensitive, which sockets do not support yet",
  );
  expect(() =>
    defineService("hooks", {
      events: { rotated: t.Object({ key: t.Sensitive(t.String()) }) },
    }),
  ).toThrow(
    `Event "hooks.rotated" payload marks '/key' t.Sensitive, which event payloads do not support yet`,
  );
});

const things = sqliteTable("things", {
  id: text("id").primaryKey(),
  apiKey: text("api_key").notNull(),
});

function thingFixture() {
  const database = defineDatabase({ tables: { things } });
  const db: any = database.getDb();
  syncSchema([things], db);
  db.insert(things).values({ id: "t1", apiKey: TOKEN }).run();
  const service = defineService("things", { database });
  const thing = service.resource({ name: "thing", table: things });
  return { service, thing };
}

it("keeps a record action's mark on its whole input, and passes a command's reveal", async () => {
  const { service, thing } = thingFixture();
  thing.command("rotate", {
    access: "public",
    output: t.Object({ id: t.String(), apiKey: t.Sensitive(t.String()) }),
    reveal: true,
    decide: () => ({ set: { apiKey: TOKEN } }),
  });
  const app = brick({
    services: [service],
    requestLogging: false,
    docs: false,
  });
  const response = await postJson(app, "/api/things/thing/t1/rotate");
  expect(await response.json()).toEqual({ id: "t1", apiKey: TOKEN });

  // A mark on the input itself covers the `id` from the path, which is logged.
  const other = thingFixture();
  other.thing.action({
    name: "note",
    record: true,
    access: "public",
    input: t.Sensitive(t.Object({ text: t.String() })),
    execute: () => true,
  });
  expect(() =>
    brick({ services: [other.service], requestLogging: false, docs: false }),
  ).toThrow("sensitive input field '/id' is a path parameter");
});

it("strips a sensitive field from an MCP call through the HTTP handler", async () => {
  const service = defineService("integrations");
  service.tool({
    name: "getCredential",
    input: t.Object({ id: t.String() }),
    output: Credential,
    execute: ({ input }) => ({ id: input.id, accessToken: TOKEN }),
  });
  const handler = createMcpHandler({
    registry: createMcpRegistry({ services: [service] }),
    serverInfo: { name: "test", version: "1" },
  });
  const response = await handler(
    new Request("http://localhost/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "getCredential", arguments: { id: "c1" } },
      }),
    }),
  );
  const text = await response.text();
  expect(JSON.parse(text).result.structuredContent).toEqual({ id: "c1" });
  expect(text).not.toContain(TOKEN);
});

it("withholds whole lines once a set is full, and redacts a value added after a line", async () => {
  const service = defineService("bulk");
  service.action({
    name: "load",
    input: t.Object({ secret: t.Sensitive(t.String()) }),
    execute: ({ ctx }) => {
      ctx.logger.info("first line");
      redact("later-secret-1");
      ctx.logger.info("saw later-secret-1");
      for (let index = 0; index < 1100; index++) redact(`bulk-secret-${index}`);
      ctx.logger.info("saw bulk-secret-1099 and bulk-secret-5");
      return true;
    },
  });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  let seen: Awaited<ReturnType<typeof observe>>;
  try {
    seen = await observe(() =>
      postJson(appOf(service), "/api/bulk/load", { secret: TOKEN }),
    );
  } finally {
    warn.mockRestore();
  }
  for (const text of [seen.console, seen.spans]) {
    expect(text).toContain("saw [REDACTED]");
    expect(text).not.toContain("later-secret-1");
    expect(text).toContain(
      "[REDACTED: too many sensitive values in this call]",
    );
    expect(text).not.toContain("bulk-secret-1099");
    expect(text).not.toContain("bulk-secret-5");
  }
});

it("keeps the redaction store on globalThis, shared with another copy of core", async () => {
  const store = (globalThis as Record<symbol, any>)[
    Symbol.for("brickkit.redactions")
  ];
  let values: Set<string> | undefined;
  const action = defineAction({
    name: "peek",
    input: t.Object({ secret: t.Sensitive(t.String()) }),
    execute: () => {
      values = store.getStore()?.values;
      return true;
    },
  });
  await action.run({ secret: TOKEN });
  expect(values?.has(TOKEN)).toBe(true);
});
