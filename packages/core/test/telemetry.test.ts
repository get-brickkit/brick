import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
} from "bun:test";
import {
  propagation,
  SpanKind,
  SpanStatusCode,
  context,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  TracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  brick,
  defineDatabase,
  defineService,
  resetGlobalRegistry,
  t,
  traceRoute,
  useService,
} from "../src";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  trace.setGlobalTracerProvider(
    new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    }),
  );
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

afterAll(() => {
  trace.disable();
  context.disable();
  propagation.disable();
});

beforeEach(() => {
  exporter.reset();
  resetGlobalRegistry();
});

function buildApp(telemetry?: boolean) {
  const users = defineService("users");
  users.action({
    name: "getUser",
    input: t.Object({ id: t.String() }),
    execute: ({ input, error }) => {
      if (input.id !== "usr_42") error.NOT_FOUND("User not found");
      return { id: input.id };
    },
  });
  users.action({
    name: "explode",
    execute: () => {
      throw new Error("db down");
    },
  });

  const orders = defineService("orders");
  orders.action({
    name: "checkout",
    input: t.Object({ id: t.String() }),
    execute: async ({ input }) => {
      const remote = useService(users);
      return remote.getUser({ id: input.id });
    },
  });

  return brick({
    services: [users, orders],
    requestLogging: false,
    telemetry,
    endpoints: [
      {
        method: "GET",
        path: "/boom",
        handler: () => {
          throw new Error("boom");
        },
      },
    ],
  });
}

function post(app: ReturnType<typeof buildApp>, path: string, body: object) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function spanNamed(name: string) {
  const span = exporter.getFinishedSpans().find((item) => item.name === name);
  if (!span) throw new Error(`No finished span named ${name}`);
  return span;
}

describe("telemetry spans", () => {
  it("records an HTTP span with the action span as its child", async () => {
    const app = buildApp(true);
    const response = await post(app, "/api/users/get-user", { id: "usr_42" });

    expect(response.status).toBe(200);
    const root = spanNamed("POST /api/users/get-user");
    const action = spanNamed("action users.getUser");
    expect(action.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    expect(action.attributes["brick.action"]).toBe("getUser");
    expect(root.attributes["http.response.status_code"]).toBe(200);
    expect(root.status.code).toBe(SpanStatusCode.UNSET);
  });

  it("marks server faults on the action and request spans with the code and exception", async () => {
    const app = buildApp(true);
    const response = await post(app, "/api/users/explode", {});

    expect(response.status).toBe(500);
    const action = spanNamed("action users.explode");
    expect(action.status.code).toBe(SpanStatusCode.ERROR);
    expect(action.attributes["brick.error.code"]).toBe("INTERNAL_SERVER_ERROR");
    const exception = action.events.find((event) => event.name === "exception");
    expect(exception?.attributes?.["exception.message"]).toBe("db down");
    expect(spanNamed("POST /api/users/explode").status.code).toBe(
      SpanStatusCode.ERROR,
    );
  });

  it("keeps client errors as attributes rather than span errors", async () => {
    const app = buildApp(true);
    const response = await post(app, "/api/users/get-user", { id: "nope" });

    expect(response.status).toBe(404);
    const action = spanNamed("action users.getUser");
    expect(action.attributes["brick.error.code"]).toBe("NOT_FOUND");
    expect(action.attributes["brick.error.status"]).toBe(404);
    expect(action.status.code).toBe(SpanStatusCode.UNSET);
    expect(spanNamed("POST /api/users/get-user").status.code).toBe(
      SpanStatusCode.UNSET,
    );
  });

  it("records remote service calls as children of the calling action", async () => {
    const app = buildApp(true);
    const response = await post(app, "/api/orders/checkout", { id: "usr_42" });

    expect(response.status).toBe(200);
    const caller = spanNamed("action orders.checkout");
    const rpc = spanNamed("rpc users.getUser");
    expect(rpc.parentSpanContext?.spanId).toBe(caller.spanContext().spanId);
    expect(rpc.attributes["brick.service"]).toBe("users");
  });

  it("records endpoint failures on the request span", async () => {
    const app = buildApp(true);
    const response = await app.handle(new Request("http://localhost/boom"));

    expect(response.status).toBe(500);
    const root = spanNamed("GET /boom");
    expect(root.status.code).toBe(SpanStatusCode.ERROR);
    expect(root.attributes["brick.error.code"]).toBe("INTERNAL_SERVER_ERROR");
  });

  it("records nothing unless the app opts in with telemetry: true", async () => {
    const omitted = buildApp();
    const disabled = buildApp(false);

    expect(
      (await post(omitted, "/api/users/get-user", { id: "usr_42" })).status,
    ).toBe(200);
    expect(
      (await post(disabled, "/api/users/get-user", { id: "usr_42" })).status,
    ).toBe(200);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("does not record RPC spans for calls made outside a traced request", async () => {
    buildApp(true);
    const remote = useService({ name: "users" });

    expect(await remote.getUser({ id: "usr_42" })).toEqual({ id: "usr_42" });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("auth.handler", () => {
  it("traces and logs the requests auth.handler answers, and only those", async () => {
    const lines: string[] = [];
    const app = brick({
      services: [],
      telemetry: true,
      requestLogging: { logger: (line) => lines.push(line) },
      auth: {
        resolve: () => null,
        handler: (request) =>
          new URL(request.url).pathname.startsWith("/auth/")
            ? Response.json({ ok: false }, { status: 401 })
            : undefined,
      },
    });
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const response = await app.handle(
      new Request("http://localhost/auth/sign-in", {
        method: "POST",
        headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
      }),
    );
    expect(response.status).toBe(401);
    const span = spanNamed("POST /auth/sign-in");
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.attributes["http.response.status_code"]).toBe(401);
    expect(lines).toEqual([
      expect.stringMatching(/^POST \/auth\/sign-in → 401 /),
    ]);

    // A request auth.handler lets through gets no auth span.
    exporter.reset();
    await app.handle(new Request("http://localhost/_health"));
    expect(exporter.getFinishedSpans().map((span) => span.name)).not.toContain(
      "GET /_health",
    );
  });
});

describe("trace context and database spans", () => {
  it("continues the caller's W3C trace and returns its ids", async () => {
    const app = buildApp(true);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentId = "00f067aa0ba902b7";
    const response = await app.handle(
      new Request("http://localhost/api/users/get-user", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          traceparent: `00-${traceId}-${parentId}-01`,
        },
        body: JSON.stringify({ id: "usr_42" }),
      }),
    );

    expect(response.status).toBe(200);
    const root = spanNamed("POST /api/users/get-user");
    expect(root.spanContext().traceId).toBe(traceId);
    expect(root.parentSpanContext?.spanId).toBe(parentId);
    expect(response.headers.get("x-trace-id")).toBe(traceId);
    expect(response.headers.get("traceparent")).toMatch(
      new RegExp(`^00-${traceId}-`),
    );
  });

  it("returns the request's trace id as x-trace-id when the caller sends none", async () => {
    const app = buildApp(true);
    const response = await post(app, "/api/users/get-user", { id: "usr_42" });

    const root = spanNamed("POST /api/users/get-user");
    expect(response.headers.get("x-trace-id")).toBe(root.spanContext().traceId);
  });

  it("keeps a client-supplied x-trace-id and records it on the span", async () => {
    const app = buildApp(true);
    const response = await app.handle(
      new Request("http://localhost/api/users/get-user", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-trace-id": "client-42",
        },
        body: JSON.stringify({ id: "usr_42" }),
      }),
    );

    expect(response.headers.get("x-trace-id")).toBe("client-42");
    expect(
      spanNamed("POST /api/users/get-user").attributes["brick.trace_id"],
    ).toBe("client-42");
  });

  it("records sqlite statements as children of the action that ran them", async () => {
    const notes = defineService("notes", { database: defineDatabase() });
    notes.action({
      name: "count",
      execute: async ({ ctx }) => ctx.db.all(sql`select 1 as value`),
    });
    const app = brick({
      services: [notes],
      requestLogging: false,
      telemetry: true,
    });

    expect((await post(app, "/api/notes/count", {})).status).toBe(200);
    const action = spanNamed("action notes.count");
    const statement = exporter
      .getFinishedSpans()
      .find((span) => span.name === "SQL SELECT");
    expect(statement?.parentSpanContext?.spanId).toBe(
      action.spanContext().spanId,
    );
    expect(statement?.kind).toBe(SpanKind.CLIENT);
    expect(statement?.attributes["db.system"]).toBe("sqlite");
    expect(statement?.attributes["db.statement"]).toBe("select 1 as value");
  });

  it("does not record statements run outside a traced request", async () => {
    const loose = defineService("loose", { database: defineDatabase() });
    brick({ services: [loose], requestLogging: false, telemetry: true });

    loose.getDb()!.all(sql`select 1 as value`);

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("traces raw routes wrapped with traceRoute and leaves their body readable", async () => {
    const app = brick({ services: [], requestLogging: false });
    app.post(
      "/raw/:id",
      traceRoute("/raw/:id", async ({ params, request }) => {
        return new Response(`raw ${params.id} ${await request.text()}`);
      }),
    );

    const response = await app.handle(
      new Request("http://localhost/raw/7", {
        method: "POST",
        body: "payload",
      }),
    );

    expect(await response.text()).toBe("raw 7 payload");
    const root = spanNamed("POST /raw/:id");
    expect(root.attributes["http.route"]).toBe("/raw/:id");
    expect(root.attributes["http.response.status_code"]).toBe(200);
  });

  it("records the status of a Response returned by a raw route", async () => {
    const app = brick({ services: [], requestLogging: false });
    app.post(
      "/denied",
      traceRoute("/denied", () => new Response("no", { status: 401 })),
    );

    const response = await app.handle(
      new Request("http://localhost/denied", { method: "POST" }),
    );

    expect(response.status).toBe(401);
    const root = spanNamed("POST /denied");
    expect(root.attributes["http.response.status_code"]).toBe(401);
    expect(root.status.code).toBe(SpanStatusCode.UNSET);
  });

  test.skipIf(!process.env.TEST_DATABASE_URL)(
    "records postgres statements as children of the action that ran them",
    async () => {
      const client = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
      try {
        const pg = defineService("pgnotes", {
          database: defineDatabase({ engine: "postgres", client }),
        });
        pg.action({
          name: "ping",
          execute: async ({ ctx }) => ctx.db.execute(sql`select 1 as value`),
        });
        const app = brick({
          services: [pg],
          requestLogging: false,
          telemetry: true,
        });

        expect((await post(app, "/api/pgnotes/ping", {})).status).toBe(200);
        const action = spanNamed("action pgnotes.ping");
        const statement = exporter
          .getFinishedSpans()
          .find((span) => span.name === "SQL SELECT");
        expect(statement?.parentSpanContext?.spanId).toBe(
          action.spanContext().spanId,
        );
        expect(statement?.attributes["db.system"]).toBe("postgresql");
        expect(statement?.status.code).toBe(SpanStatusCode.UNSET);
      } finally {
        await client.end();
      }
    },
  );
});

it("accepts the OpenTelemetry API of hosts on SDK 2.x", async () => {
  // A second, newer API copy would see the host's provider as incompatible and
  // turn every Brick span into a no-op. Core uses nothing newer than 1.9.
  const manifest = await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json();
  expect(
    Bun.semver.satisfies("1.9.0", manifest.dependencies["@opentelemetry/api"]),
  ).toBe(true);
});
