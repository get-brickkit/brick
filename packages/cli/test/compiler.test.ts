import { beforeEach, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  defineService,
  resetGlobalRegistry,
  t,
  compileBrickApplication,
  brick,
  loadCompiledBrickApp,
} from "@brickkit/core";
import { emitCompiledApplication } from "../src/compiler";

beforeEach(resetGlobalRegistry);

it("runs published core handlers when Node disables string code generation", async () => {
  const core = new URL("../../core/dist/index.js", import.meta.url).href;
  const child = Bun.spawn(
    [
      "node",
      "--disallow-code-generation-from-strings",
      "--input-type=module",
      "-e",
      `import { defineService, compileBrickApplication } from ${JSON.stringify(core)};
     const service = defineService("safe");
     service.action({ name: "ready", execute: () => ({ ok: true }) });
     const app = compileBrickApplication({ services: [service] });
     const result = app.routes[0].handler({ set: { headers: {} } });
     if (result instanceof Promise) throw new Error("Expected a synchronous handler");
     console.log(JSON.stringify(result));`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ ok: true });
});

const request = (
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      "x-trace-id": "trace-test",
      "x-request-id": "request-test",
      ...headers,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

it("emits a frozen IR and a synchronous handler with no input/context/auth stages", () => {
  const service = defineService("simple");
  service.action({
    name: "getReady",
    method: "GET",
    execute: ({ ctx }) => ({ ok: true, request: ctx.requestId }),
  });
  const compilation = compileBrickApplication({ services: [service] });
  expect(Object.isFrozen(compilation)).toBe(true);
  expect(Object.isFrozen(compilation.ir.routes[0]!.inputPrecedence)).toBe(true);
  const route = compilation.routes.find((r) => r.ir.method === "GET")!;
  const source = route.handler.toString();
  expect(source).not.toContain("params");
  expect(source).not.toContain("contextHook(");
  expect(source).not.toContain("authorize(");
  const value = route.handler({
    request: request("/api/simple/get-ready"),
    headers: { "x-request-id": "custom" },
    set: { headers: {} },
  });
  expect(value).not.toBeInstanceOf(Promise);
  expect(value).toEqual({ ok: true, request: "custom" });
});

it("matches generic route behavior for input precedence, coercion, schema errors and async authorization", async () => {
  const order: string[] = [];
  const service = defineService("secure", {
    context: async (ctx) => {
      order.push("context");
      return {
        user: ctx.request.headers.get("x-user") ? { id: "alice" } : null,
      };
    },
  });
  const getValue = service.action({
    name: "getValue",
    method: "GET",
    path: "/custom/:id",
    input: t.Object({
      id: t.String(),
      count: t.Number(),
      enabled: t.Boolean(),
    }),
    output: t.Object({
      id: t.String(),
      count: t.Number(),
      enabled: t.Boolean(),
    }),
    authorize: async ({ user }) => {
      order.push("authorize");
      return Boolean(user);
    },
    execute: async ({ input }) => {
      order.push("execute");
      return input;
    },
  });
  service.action({
    ...getValue.config,
    name: "getValuePost",
    method: "POST",
    path: "/custom-post/:id",
  });
  service.action({
    name: "badOutput",
    output: t.Number(),
    execute: async () => "bad" as any,
  });
  service.action({
    name: "knownError",
    execute: ({ error }) => error.NOT_FOUND("missing"),
  });
  service.action({
    name: "broken",
    execute: () => {
      throw new Error("broken");
    },
  });
  const compiled = brick({ services: [service], requestLogging: false });
  const generic = brick({
    services: [service],
    requestLogging: false,
    compiler: false,
  });
  const cases: [string, string, unknown?, Record<string, string>?][] = [
    [
      "/api/secure/custom/path?count=2&enabled=1&id=query",
      "GET",
      undefined,
      { "x-user": "alice" },
    ],
    [
      "/api/secure/custom/path?count=0x10&enabled=false",
      "GET",
      undefined,
      { "x-user": "alice" },
    ],
    [
      "/api/secure/custom-post/path?count=4&enabled=1&id=query",
      "POST",
      { id: "body", count: 3, enabled: false },
      { "x-user": "alice" },
    ],
    [
      "/api/secure/custom/path?count=bad&enabled=1",
      "GET",
      undefined,
      { "x-user": "alice" },
    ],
    ["/api/secure/custom/path?count=2&enabled=1", "GET"],
    ["/api/secure/custom-post/path", "POST", {}, { "x-user": "alice" }],
    ["/api/secure/bad-output", "POST"],
    ["/api/secure/known-error", "POST"],
    ["/api/secure/broken", "POST"],
  ];
  for (const [path, method, body, headers] of cases) {
    order.length = 0;
    const a = await compiled.handle(request(path, method, body, headers));
    const compiledOrder = [...order];
    order.length = 0;
    const b = await generic.handle(request(path, method, body, headers));
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
    expect(order).toEqual(compiledOrder);
    expect(a.headers.get("x-trace-id")).toBe("trace-test");
  }
});

it("isolates request contexts and maps Promise/thenable rejections", async () => {
  const service = defineService("async", {
    context: (ctx) => ({ userId: ctx.request.headers.get("x-user") }),
  });
  service.action({
    name: "getUser",
    method: "GET",
    execute: async ({ ctx }) => {
      await Bun.sleep(1);
      return { user: ctx.userId };
    },
  });
  const plain = defineService("plain");
  plain.action({
    name: "getThenable",
    method: "GET",
    output: t.Object({ ok: t.Boolean() }),
    execute: () =>
      ({
        // oxlint-disable-next-line unicorn/no-thenable -- Tests promise assimilation for custom thenables.
        then: (resolve: Function) => resolve({ ok: true }),
      }) as any,
  });
  plain.action({
    name: "getRejected",
    method: "GET",
    execute: () => Promise.reject(new Error("rejected")),
  });
  const app = brick({ services: [service, plain], requestLogging: false });
  const users = await Promise.all(
    Array.from({ length: 16 }, async (_, i) => {
      const response = await app.handle(
        request("/api/async/get-user", "GET", undefined, {
          "x-user": String(i),
        }),
      );
      return response.json();
    }),
  );
  expect(users.map((u) => u.user)).toEqual(
    Array.from({ length: 16 }, (_, i) => String(i)),
  );
  expect(
    await (await app.handle(request("/api/plain/get-thenable"))).json(),
  ).toEqual({ ok: true });
  const failure = await app.handle(request("/api/plain/get-rejected"));
  expect(failure.status).toBe(500);
  expect(await failure.json()).toMatchObject({
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal Server Error",
    status: 500,
  });
});

it("loads emitted handler functions and rejects stale schemas rather than using old validation", async () => {
  const service = defineService("emitted");
  const action = service.action({
    name: "getItem",
    method: "GET",
    input: t.Object({ id: t.String() }),
    execute: ({ input }) => input,
  });
  const compilation = compileBrickApplication({
    services: [service],
    prefix: "/v1",
  });
  const dir = await mkdtemp(join(tmpdir(), "brick-compiler-"));
  try {
    const path = join(dir, "routes.mjs");
    // The temp dir can't resolve the package name, so point at the resolved module.
    await Bun.write(
      path,
      emitCompiledApplication(
        compilation.ir,
        import.meta.resolve("@brickkit/core"),
      ),
    );
    const emitted = await import(path);
    const rebound = emitted.bind([service]);
    const app = brick({
      services: [service],
      compilation: rebound,
      requestLogging: false,
    });
    expect(
      await (await app.handle(request("/v1/emitted/get-item?id=abc"))).json(),
    ).toEqual({
      id: "abc",
    });
    action.config.input = t.Object({ id: t.Number() }) as any;
    expect(() => emitted.bind([service])).toThrow(
      "differ from the compiled IR",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports route collisions and safely quotes names/keys in generated code", async () => {
  const service = defineService("quoted");
  service.action({
    name: "get'Quote",
    method: "GET",
    path: "/shared",
    input: t.Object({ "odd'key": t.Number() }),
    execute: ({ input }) => input,
  });
  service.action({
    name: "getOther",
    path: "/shared",
    method: "GET",
    execute: () => "other",
  });
  const compilation = compileBrickApplication({ services: [service] });
  expect(compilation.ir.diagnostics.length).toBe(1);
  const route = compilation.routes.find(
    (route) =>
      route.ir.path === "/api/quoted/shared" && route.ir.method === "GET",
  )!;
  const value = await route.handler({
    query: { "odd'key": "2" },
    params: {},
    headers: {},
    request: request("/shared?odd%27key=2"),
    set: { headers: {} },
  });
  expect(value).toEqual({ "odd'key": 2 });
});

it("runs generic preparation contributions only for specialized compilation and snapshots metadata", async () => {
  const service = defineService("prepared_action");
  let preparations = 0;
  const metadata = { revision: 1 };
  service.contributePreparation({
    name: "example/prepared-query",
    describe: () => metadata,
    prepare: () => {
      preparations++;
    },
  });
  service.action({ name: "ready", execute: () => ({ ready: true }) });
  const generic = compileBrickApplication({
    services: [service],
    mode: "generic",
  });
  expect(preparations).toBe(0);
  expect(generic.ir.preparations).toEqual([
    {
      service: "prepared_action",
      name: "example/prepared-query",
      metadata: { revision: 1 },
    },
  ]);
  const compiled = compileBrickApplication({ services: [service] });
  expect(preparations).toBe(1);
  expect(Object.isFrozen(compiled.ir.preparations[0]!.metadata)).toBe(true);
  metadata.revision = 2;
  expect(compiled.ir.preparations[0]!.metadata).toEqual({ revision: 1 });
});

it("rejects over-nested input with the generic handler's 400 in both modes", async () => {
  const service = defineService("nested");
  service.action({
    name: "tree",
    method: "POST",
    input: t.Recursive((Node) => t.Object({ child: t.Optional(Node) })),
    execute: () => ({ ok: true }),
  });
  let input: Record<string, unknown> = {};
  for (let i = 0; i < 20_000; i++) input = { child: input };
  for (const compiler of [true, false]) {
    resetGlobalRegistry();
    const app = brick({ services: [service], compiler, requestLogging: false });
    const response = await app.handle(
      request("/api/nested/tree", "POST", input),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.errors).toEqual([
      { path: "", message: "Input exceeds maximum nesting depth" },
    ]);
  }
});

it("loads a built app without a binder, and refuses one whose definitions changed since the build", async () => {
  const service = defineService("built");
  service.action({ name: "ready", execute: () => ({ ok: true }) });
  const app = brick({
    services: [service],
    requestLogging: false,
    docs: false,
  });
  const { ir } = compileBrickApplication({ services: [service] });
  const load = async () => ({ default: app });
  expect(await loadCompiledBrickApp(load, ir)).toBe(app);
  await expect(
    loadCompiledBrickApp(load, { ...ir, routes: [] }),
  ).rejects.toThrow("rebuild the application");
});
