import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attributes } from "@opentelemetry/api";
import { openHistory, type DevHistory } from "../src/dev-history";
import type { TelemetryRecord } from "../src/dev-telemetry";
import { DevTelemetryStore } from "../src/dev-telemetry-store";

function start(
  traceId: string,
  spanId: string,
  name: string,
  startMs: number,
  options: { parentSpanId?: string; attributes?: Attributes } = {},
): TelemetryRecord {
  return {
    phase: "start",
    traceId,
    spanId,
    parentSpanId: options.parentSpanId,
    name,
    startMs,
    attributes: options.attributes ?? {},
  };
}

function end(
  traceId: string,
  spanId: string,
  name: string,
  endMs: number,
  options: {
    status?: "unset" | "ok" | "error";
    statusMessage?: string;
    attributes?: Attributes;
    events?: { name: string; timeMs: number; attributes: Attributes }[];
  } = {},
): TelemetryRecord {
  return {
    phase: "end",
    traceId,
    spanId,
    name,
    endMs,
    status: options.status ?? "ok",
    statusMessage: options.statusMessage,
    attributes: options.attributes ?? {},
    events: options.events ?? [],
  };
}

const rootAttributes = {
  "http.request.method": "POST",
  "http.route": "/api/users/getUser",
  "url.path": "/api/users/getUser",
};

describe("DevTelemetryStore", () => {
  it("groups spans into one trace, finalizes the request, and orders spans by start", () => {
    const store = new DevTelemetryStore();
    store.ingest(
      [
        start("t1", "root", "POST /api/users/getUser", 1000, {
          attributes: rootAttributes,
        }),
        start("t1", "action", "action users.getUser", 1002, {
          parentSpanId: "root",
        }),
        end("t1", "action", "action users.getUser", 1010, {
          attributes: { "brick.action": "getUser" },
        }),
        end("t1", "root", "POST /api/users/getUser", 1012, {
          attributes: { "http.response.status_code": 200 },
        }),
      ],
      1,
    );

    const [trace] = store.snapshot().traces;
    expect(trace.status).toBe("ok");
    expect(trace.method).toBe("POST");
    expect(trace.route).toBe("/api/users/getUser");
    expect(trace.path).toBe("/api/users/getUser");
    expect(trace.httpStatus).toBe(200);
    expect(trace.durationMs).toBe(12);
    expect(trace.spans.map((span) => span.spanId)).toEqual(["root", "action"]);
    expect(store.snapshot().failures).toHaveLength(0);
  });

  it("records one failure from the action span, with its code, message, and stack", () => {
    const store = new DevTelemetryStore();
    store.ingest(
      [
        start("t1", "root", "POST /api/users/explode", 1000, {
          attributes: rootAttributes,
        }),
        start("t1", "action", "action users.explode", 1001, {
          parentSpanId: "root",
        }),
        end("t1", "action", "action users.explode", 1004, {
          status: "error",
          attributes: {
            "brick.error.code": "INTERNAL_SERVER_ERROR",
            "brick.error.status": 500,
            "brick.error.message": "Internal Server Error",
            "brick.action": "explode",
            "brick.service": "users",
          },
          events: [
            {
              name: "exception",
              timeMs: 1003,
              attributes: {
                "exception.message": "db down",
                "exception.stacktrace": "Error: db down\n    at execute",
              },
            },
          ],
        }),
        end("t1", "root", "POST /api/users/explode", 1005, {
          status: "error",
          attributes: { "http.response.status_code": 500 },
        }),
      ],
      1,
    );

    const { failures, traces } = store.snapshot();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      phase: "request",
      code: "INTERNAL_SERVER_ERROR",
      message: "db down",
      status: 500,
      stack: "Error: db down\n    at execute",
      traceId: "t1",
      route: "/api/users/getUser",
      service: "users",
      action: "explode",
    });
    expect(traces[0].status).toBe("error");
  });

  it("falls back to an HTTP failure when no span reported a code", () => {
    const store = new DevTelemetryStore();
    store.ingest(
      [
        start("t2", "root", "GET /boom", 2000, {
          attributes: { "http.route": "/boom" },
        }),
        end("t2", "root", "GET /boom", 2003, {
          status: "error",
          attributes: { "http.response.status_code": 502 },
        }),
      ],
      1,
    );

    expect(store.snapshot().failures[0]).toMatchObject({
      code: "HTTP_502",
      status: 502,
    });
  });

  it("lists a client error from a raw route without marking the trace as failed", () => {
    const store = new DevTelemetryStore();
    store.ingest(
      [
        start("t7", "root", "POST /api/auth/sign-in/email", 6000, {
          attributes: {
            "http.request.method": "POST",
            "http.route": "/api/auth/*",
            "url.path": "/api/auth/sign-in/email",
          },
        }),
        end("t7", "root", "POST /api/auth/sign-in/email", 6010, {
          attributes: { "http.response.status_code": 401 },
        }),
      ],
      1,
    );

    const snapshot = store.snapshot();
    expect(snapshot.failures[0]).toMatchObject({
      code: "HTTP_401",
      message: "POST /api/auth/sign-in/email returned 401",
      status: 401,
      route: "/api/auth/*",
    });
    expect(snapshot.traces[0].status).toBe("ok");
  });

  it("marks requests still running in an exited process as interrupted", () => {
    const store = new DevTelemetryStore();
    store.ingest(
      [
        start("t3", "root", "GET /slow", 3000, {
          attributes: { "http.route": "/slow" },
        }),
        start("t3", "action", "action svc.slow", 3001, {
          parentSpanId: "root",
        }),
      ],
      7,
    );

    store.interruptGeneration(7);

    const [trace] = store.snapshot().traces;
    expect(trace.status).toBe("interrupted");
    expect(trace.endMs).toBeDefined();
    expect(trace.spans.every((span) => span.status === "interrupted")).toBe(
      true,
    );
  });

  it("keeps only the newest traces and failures within their limits", () => {
    const store = new DevTelemetryStore();
    for (let index = 0; index < 205; index++) {
      store.ingest(
        [start(`t${index}`, `s${index}`, `GET /n/${index}`, index)],
        1,
      );
    }
    const snapshot = store.snapshot();
    expect(snapshot.traces).toHaveLength(200);
    expect(snapshot.traces[0].traceId).toBe("t204");
    expect(snapshot.traces.at(-1)?.traceId).toBe("t5");
  });

  it("reports worker startup failures and keeps reloads newest first", () => {
    const store = new DevTelemetryStore();
    store.recordReload({ kind: "started", generation: 1 });
    store.recordWorkerError(
      "startup",
      { name: "Error", message: "missing export" },
      1,
    );
    store.recordReload({ kind: "started", generation: 2 });

    const snapshot = store.snapshot();
    expect(snapshot.failures[0]).toMatchObject({
      phase: "startup",
      code: "STARTUP_FAILED",
      message: "missing export",
    });
    expect(snapshot.reloads.map((reload) => reload.generation)).toEqual([2, 1]);
  });

  it("notifies subscribers until they unsubscribe", () => {
    const store = new DevTelemetryStore();
    const events: string[] = [];
    const unsubscribe = store.subscribe((event) => events.push(event.type));

    store.ingest([start("t4", "root", "GET /a", 4000)], 1);
    store.recordReload({ kind: "restarting", generation: 1 });
    unsubscribe();
    store.ingest([start("t5", "root", "GET /b", 4001)], 1);

    expect(events).toEqual(["trace", "reload"]);
  });

  it("treats a request continuing a remote caller's trace as the root", () => {
    const store = new DevTelemetryStore();
    store.ingest(
      [
        start("t6", "root", "POST /api/orders/checkout", 5000, {
          parentSpanId: "remote-caller-span",
          attributes: { "http.route": "/api/orders/checkout" },
        }),
        start("t6", "action", "action orders.checkout", 5001, {
          parentSpanId: "root",
        }),
        end("t6", "action", "action orders.checkout", 5004),
        end("t6", "root", "POST /api/orders/checkout", 5006, {
          attributes: { "http.response.status_code": 200 },
        }),
      ],
      1,
    );

    const [trace] = store.snapshot().traces;
    expect(trace.status).toBe("ok");
    expect(trace.durationMs).toBe(6);
    expect(trace.route).toBe("/api/orders/checkout");
  });

  it("keeps the latest architecture and announces replacements", () => {
    const store = new DevTelemetryStore();
    const seen: string[] = [];
    store.subscribe((event) => {
      if (event.type === "architecture")
        seen.push(event.architecture.schema.version);
    });
    expect(store.snapshot().architecture).toBeNull();

    store.setArchitecture({ version: "1", services: [] }, 1);
    store.setArchitecture({ version: "2", services: [] }, 2);

    expect(store.snapshot().architecture).toEqual({
      generation: 2,
      schema: { version: "2", services: [] },
    });
    expect(seen).toEqual(["1", "2"]);
  });

  it("keeps the app's API documents, announcing each replacement", () => {
    const store = new DevTelemetryStore();
    const seen: number[] = [];
    store.subscribe((event) => {
      if (event.type === "api") seen.push(event.api.revision);
    });
    expect(store.snapshot().api).toBeNull();
    expect(store.apiDocuments()).toEqual([]);

    const own = { title: "Orders API", document: { openapi: "3.1.0" } };
    store.setApiDocuments([own], "http://localhost:4000");
    store.setApiDocuments(
      [own, { title: "Auth", document: { openapi: "3.1.0", paths: {} } }],
      "http://localhost:4000",
    );

    // The snapshot names the documents; the documents themselves are fetched.
    expect(store.snapshot().api).toEqual({
      revision: 2,
      appUrl: "http://localhost:4000",
      titles: ["Orders API", "Auth"],
    });
    expect(store.apiDocuments()).toHaveLength(2);
    expect(seen).toEqual([1, 2]);

    store.setApiDocuments([]);
    expect(store.snapshot().api).toEqual({ revision: 3, titles: [] });
  });
});

describe("DevTelemetryStore request summary", () => {
  it("names the service and action that handled a request, and why it failed", () => {
    const store = new DevTelemetryStore();
    store.ingest(
      [
        start("t1", "root", "POST /api/users/getUser", 1000, {
          attributes: rootAttributes,
        }),
        start("t1", "action", "action users.getUser", 1002, {
          parentSpanId: "root",
        }),
        end("t1", "action", "action users.getUser", 1010, {
          status: "error",
          attributes: {
            "brick.service": "users",
            "brick.action": "getUser",
            "brick.error.code": "NOT_FOUND",
            "brick.error.message": "User not found",
          },
        }),
        end("t1", "root", "POST /api/users/getUser", 1012, {
          status: "error",
          attributes: { "http.response.status_code": 404 },
        }),
      ],
      1,
    );
    const [trace] = store.snapshot().traces;
    expect(trace).toMatchObject({
      service: "users",
      action: "getUser",
      message: "User not found",
    });
  });

  it("leaves them out of a request that ran no action and did not fail", () => {
    const store = new DevTelemetryStore();
    store.ingest(
      [
        start("t2", "root", "GET /health", 1000, {
          attributes: rootAttributes,
        }),
        end("t2", "root", "GET /health", 1002, {
          attributes: { "http.response.status_code": 200 },
        }),
      ],
      1,
    );
    const [trace] = store.snapshot().traces;
    expect(trace.service).toBeUndefined();
    expect(trace.action).toBeUndefined();
    expect(trace.message).toBeUndefined();
  });
});

describe("DevTelemetryStore history", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function withHistory(): Promise<DevHistory> {
    const directory = mkdtempSync(join(tmpdir(), "brick-store-history-"));
    const history = (await openHistory({ directory, days: 90 }))!;
    cleanups.push(() => {
      history.close();
      rmSync(directory, { recursive: true, force: true });
    });
    return history;
  }

  const now = Date.now();

  it("keeps finished requests and why they failed, but not running or interrupted ones", async () => {
    const history = await withHistory();
    const store = new DevTelemetryStore({ history });

    store.ingest(
      [
        start("running", "root", "POST /api/users/getUser", now, {
          attributes: rootAttributes,
        }),
        start("done", "root", "POST /api/users/getUser", now + 1, {
          attributes: rootAttributes,
        }),
        end("done", "root", "POST /api/users/getUser", now + 6, {
          attributes: { "http.response.status_code": 200 },
        }),
        start("failed", "root", "POST /api/users/getUser", now + 2, {
          attributes: rootAttributes,
        }),
        end("failed", "root", "POST /api/users/getUser", now + 4, {
          status: "error",
          attributes: {
            "http.response.status_code": 500,
            "brick.error.code": "INTERNAL_SERVER_ERROR",
          },
        }),
        start("cut-off", "root", "POST /api/users/getUser", now + 3, {
          attributes: rootAttributes,
        }),
      ],
      1,
    );
    store.interruptGeneration(1);

    const range = { from: now - 1_000, to: now + 1_000 };
    expect(
      history
        .traces(range)
        .traces.map((trace) => trace.traceId)
        .sort(),
    ).toEqual(["done", "failed"]);
    expect(history.trace("done")).toMatchObject({
      route: "/api/users/getUser",
      durationMs: 5,
    });
    expect(history.trace("failed")?.message).toBe("INTERNAL_SERVER_ERROR");
  });

  it("saves a request again when a late span changes it", async () => {
    const history = await withHistory();
    const store = new DevTelemetryStore({ history });
    store.ingest(
      [
        start("t", "root", "POST /api/users/getUser", now, {
          attributes: rootAttributes,
        }),
        end("t", "root", "POST /api/users/getUser", now + 5, {
          attributes: { "http.response.status_code": 200 },
        }),
      ],
      1,
    );
    store.ingest(
      [
        start("t", "late", "background", now + 6, { parentSpanId: "root" }),
        end("t", "late", "background", now + 9),
      ],
      1,
    );
    expect(history.trace("t")?.spans.map((span) => span.spanId)).toEqual([
      "root",
      "late",
    ]);
    expect(history.info().count).toBe(1);
  });
});
