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
  INVALID_SPAN_CONTEXT,
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
  defineSchedule,
  defineService,
  resetGlobalRegistry,
  scheduleTable,
  syncSchema,
  t,
  traceRoute,
  useService,
} from "../src";
import { postJson, requireService, track } from "./helpers";

const pgUrl = requireService(
  "TEST_DATABASE_URL",
  "telemetry: postgres statement spans",
);

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

function spanNamed(name: string) {
  const span = exporter.getFinishedSpans().find((item) => item.name === name);
  if (!span) throw new Error(`No finished span named ${name}`);
  return span;
}

describe("telemetry spans", () => {
  it("records an HTTP span with the action span as its child", async () => {
    const app = buildApp(true);
    const response = await postJson(app, "/api/users/get-user", {
      id: "usr_42",
    });

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
    const response = await postJson(app, "/api/users/explode", {});

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
    const response = await postJson(app, "/api/users/get-user", { id: "nope" });

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
    const response = await postJson(app, "/api/orders/checkout", {
      id: "usr_42",
    });

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
      (await postJson(omitted, "/api/users/get-user", { id: "usr_42" })).status,
    ).toBe(200);
    expect(
      (await postJson(disabled, "/api/users/get-user", { id: "usr_42" }))
        .status,
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
    const response = await postJson(app, "/api/users/get-user", {
      id: "usr_42",
    });

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

    expect((await postJson(app, "/api/notes/count", {})).status).toBe(200);
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

  test.skipIf(!pgUrl)(
    "records postgres statements as children of the action that ran them",
    async () => {
      const client = postgres(pgUrl!, { max: 1 });
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

        expect((await postJson(app, "/api/pgnotes/ping", {})).status).toBe(200);
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

describe("outbound fetch spans", () => {
  const upstream = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/slow") await Bun.sleep(200);
      return new Response(`seen ${request.method} ${path}`, {
        status: path === "/missing" ? 404 : 200,
      });
    },
  });
  afterAll(() => upstream.stop(true));
  const base = `http://127.0.0.1:${upstream.port}`;

  function appCalling(call: () => Promise<unknown>) {
    const crm = defineService("crm");
    crm.action({ name: "search", execute: call });
    return brick({ services: [crm], requestLogging: false, telemetry: true });
  }

  it("records method, host, path and status under the action, without query or credentials", async () => {
    const authed = base.replace("http://", "http://user:hunter2@");
    const app = appCalling(async () => {
      const response = await fetch(`${authed}/v1/search?api_key=secret`, {
        method: "post",
        headers: { authorization: "Bearer secret" },
        body: "{}",
      });
      return { text: await response.text() };
    });

    const response = await postJson(app, "/api/crm/search", {});
    expect(await response.json()).toEqual({ text: "seen POST /v1/search" });
    const action = spanNamed("action crm.search");
    const call = spanNamed(`POST 127.0.0.1:${upstream.port}/v1/search`);
    expect(call.kind).toBe(SpanKind.CLIENT);
    expect(call.parentSpanContext?.spanId).toBe(action.spanContext().spanId);
    expect(call.attributes).toEqual({
      "http.request.method": "POST",
      "url.full": `${base}/v1/search`,
      "server.address": "127.0.0.1",
      "http.response.status_code": 200,
    });
    const recorded = JSON.stringify(
      exporter
        .getFinishedSpans()
        .map(({ name, attributes, events }) => ({ name, attributes, events })),
    );
    expect(recorded).not.toContain("secret");
    expect(recorded).not.toContain("hunter2");
  });

  it("masks a sensitive value that appears in the URL path", async () => {
    const crm = defineService("crm");
    crm.action({
      name: "notify",
      input: t.Object({ token: t.Sensitive(t.String()) }),
      execute: async ({ input }) => {
        await fetch(`${base}/bot${input.token}/send`);
        return { ok: true };
      },
    });
    const app = brick({
      services: [crm],
      requestLogging: false,
      telemetry: true,
    });

    await postJson(app, "/api/crm/notify", { token: "tok_live_123456" });
    const call = exporter
      .getFinishedSpans()
      .find((span) => span.attributes["url.full"] !== undefined);
    expect(call?.name).toBe(
      `GET 127.0.0.1:${upstream.port}/bot[REDACTED]/send`,
    );
    expect(call?.attributes["url.full"]).toBe(`${base}/bot[REDACTED]/send`);
  });

  it("accepts a Request as input and marks 4xx responses as errors", async () => {
    const app = appCalling(async () => {
      const response = await fetch(
        new Request(`${base}/missing`, { method: "DELETE" }),
      );
      return { status: response.status };
    });

    await postJson(app, "/api/crm/search", {});
    const call = spanNamed(`DELETE 127.0.0.1:${upstream.port}/missing`);
    expect(call.attributes["http.response.status_code"]).toBe(404);
    expect(call.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("records an aborted or failed fetch as an error and rethrows it", async () => {
    const app = appCalling(async () => {
      const aborted = await fetch(`${base}/slow`, {
        signal: AbortSignal.timeout(20),
      }).catch((error: Error) => error.name);
      const refused = await fetch("http://127.0.0.1:1/down").catch(
        () => "refused",
      );
      return { aborted, refused };
    });

    const response = await postJson(app, "/api/crm/search", {});
    expect(await response.json()).toEqual({
      aborted: "TimeoutError",
      refused: "refused",
    });
    for (const name of [
      `GET 127.0.0.1:${upstream.port}/slow`,
      "GET 127.0.0.1:1/down",
    ]) {
      const call = spanNamed(name);
      expect(call.status.code).toBe(SpanStatusCode.ERROR);
      expect(call.events.some((event) => event.name === "exception")).toBe(
        true,
      );
      expect(call.attributes["http.response.status_code"]).toBeUndefined();
    }
  });

  function scheduledApp(run: () => Promise<void>, telemetry = true) {
    const table = scheduleTable("sqlite");
    const database = defineDatabase({ tables: { schedules: table } });
    syncSchema([table], database.getDb() as any);
    const jobs = defineService("jobs", { database });
    const app = track(
      brick({
        services: [jobs],
        events: {
          schedules: [defineSchedule({ name: "reconcile", every: "10m", run })],
          dispatch: { timer: false },
        },
        requestLogging: false,
        docs: false,
        telemetry,
      }),
    );
    return { app, db: jobs.getDb()! as any };
  }

  it("records a schedule run as one trace with its SQL and fetch calls under it", async () => {
    let db: any;
    const { app, db: jobsDb } = scheduledApp(async () => {
      db.all(sql`select 1 as value`);
      await fetch(`${base}/v1/domains`, { method: "POST" });
    });
    db = jobsDb;

    expect(await app.events!.schedules!.drain()).toBe(1);
    const run = spanNamed("schedule reconcile");
    expect(run.parentSpanContext).toBeUndefined();
    expect(run.attributes).toMatchObject({
      "brick.schedule": "reconcile",
      "brick.schedule.trigger": "schedule",
      "brick.schedule.attempt": 1,
      "brick.schedule.outcome": "succeeded",
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name).sort()).toEqual([
      `POST 127.0.0.1:${upstream.port}/v1/domains`,
      "SQL SELECT",
      "schedule reconcile",
    ]);
    for (const span of spans.filter((span) => span !== run)) {
      expect(span.spanContext().traceId).toBe(run.spanContext().traceId);
      expect(span.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
    }
  });

  it("records a failed or manual run on its own root span", async () => {
    const { app } = scheduledApp(async () => {
      throw new Error("inboxkit down");
    });
    const schedules = app.events!.schedules!;
    await schedules.drain();
    const failed = spanNamed("schedule reconcile");
    expect(failed.status.code).toBe(SpanStatusCode.ERROR);
    expect(failed.attributes["brick.schedule.outcome"]).toBe("failed");
    exporter.reset();

    // Triggered from inside a request's trace, the run still starts its own.
    const request = trace.getTracer("test").startSpan("GET /dashboard");
    await context.with(trace.setSpan(context.active(), request), () =>
      schedules.trigger("reconcile"),
    );
    request.end();
    await schedules.drain();
    const manual = spanNamed("schedule reconcile");
    expect(manual.attributes["brick.schedule.trigger"]).toBe("manual");
    expect(manual.parentSpanContext).toBeUndefined();
    expect(manual.spanContext().traceId).not.toBe(
      request.spanContext().traceId,
    );
  });

  it("records no schedule span unless the app opts in with telemetry: true", async () => {
    const { app } = scheduledApp(async () => {}, false);
    expect(await app.events!.schedules!.drain()).toBe(1);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("records no SQL or fetch spans under a span that is not recording", async () => {
    const { db } = scheduledApp(async () => {});
    const noop = trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
    await context.with(trace.setSpan(context.active(), noop), async () => {
      db.all(sql`select 1 as value`);
      await fetch(`${base}/v1/domains`);
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("records nothing outside a traced request and patches fetch once", async () => {
    brick({ services: [], requestLogging: false, telemetry: true });
    const patched = globalThis.fetch;
    brick({ services: [], requestLogging: false, telemetry: true });
    expect(globalThis.fetch).toBe(patched);

    const thrown = new Error("bad init");
    const throwing = () => {
      throw thrown;
    };
    globalThis.fetch = throwing as unknown as typeof fetch;
    try {
      brick({ services: [], requestLogging: false, telemetry: true });
      expect(globalThis.fetch).not.toBe(throwing);
      const wrappedThrowing = globalThis.fetch;
      globalThis.fetch = throwing as unknown as typeof fetch;
      brick({ services: [], requestLogging: false, telemetry: true });
      expect(globalThis.fetch).not.toBe(throwing);
      expect(globalThis.fetch).not.toBe(wrappedThrowing);
      const app = appCalling(async () => ({
        error: await Promise.resolve()
          .then(() => fetch(`${base}/sync`))
          .catch((error: Error) => error.message),
      }));
      expect(await (await postJson(app, "/api/crm/search", {})).json()).toEqual(
        { error: "bad init" },
      );
      expect(spanNamed(`GET 127.0.0.1:${upstream.port}/sync`).status.code).toBe(
        SpanStatusCode.ERROR,
      );
      exporter.reset();
    } finally {
      globalThis.fetch = patched;
    }

    expect(await (await fetch(`${base}/plain`)).text()).toBe("seen GET /plain");
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
