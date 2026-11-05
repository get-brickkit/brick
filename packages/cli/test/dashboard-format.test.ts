import { describe, expect, it } from "bun:test";
import {
  describeTrace,
  formatDuration,
  formatTimestamp,
  isFailure,
  spanDepths,
  spanKind,
  withAppServer,
} from "../dashboard/format";
import { percentile } from "../src/dashboard-query";
import type { TraceSpan, TraceSummary } from "../src/dashboard-protocol";

function trace(
  startMs: number,
  options: Partial<TraceSummary> = {},
): TraceSummary {
  return {
    traceId: `t${startMs}`,
    name: "GET /x",
    generation: 1,
    startMs,
    endMs: startMs + 10,
    durationMs: 10,
    status: "ok",
    truncated: false,
    spans: [],
    ...options,
  };
}

function span(spanId: string, options: Partial<TraceSpan> = {}): TraceSpan {
  return {
    spanId,
    name: "span",
    startMs: 0,
    status: "ok",
    attributes: {},
    events: [],
    ...options,
  };
}

describe("dashboard format helpers", () => {
  it("treats server faults and client errors as failures", () => {
    expect(isFailure(trace(0, { status: "error" }))).toBe(true);
    expect(isFailure(trace(0, { httpStatus: 404 }))).toBe(true);
    expect(isFailure(trace(0, { httpStatus: 200 }))).toBe(false);
  });

  it("formats durations at the scale a reader needs", () => {
    expect(formatDuration(undefined)).toBe("running");
    expect(formatDuration(0.726)).toBe("0.73 ms");
    expect(formatDuration(12.34)).toBe("12.3 ms");
    expect(formatDuration(430)).toBe("430 ms");
    expect(formatDuration(1500)).toBe("1.50 s");
  });

  it("interpolates percentiles and handles an empty list", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
  });

  it("formats a timestamp to the hundredth, with the date when asked", () => {
    const at = new Date(2026, 2, 4, 14, 5, 9, 678).getTime();
    expect(formatTimestamp(at, false)).toMatch(/^\d{1,2}:05:09\.67$/);
    expect(formatTimestamp(at, true)).toMatch(
      /Mar.*4.*05:09\.67|4.*Mar.*05:09\.67/,
    );
  });

  it("classifies spans and nests them by parent", () => {
    const root = span("a", { attributes: { "http.route": "/x" } });
    const action = span("b", { parentSpanId: "a", name: "action svc.act" });
    const sql = span("c", {
      parentSpanId: "b",
      attributes: { "db.statement": "select 1" },
    });
    expect([root, action, sql].map(spanKind)).toEqual([
      "http",
      "action",
      "sql",
    ]);
    expect(spanKind(span("d", { name: "rpc svc.act" }))).toBe("rpc");

    const depths = spanDepths([root, action, sql]);
    expect([depths.get("a"), depths.get("b"), depths.get("c")]).toEqual([
      0, 1, 2,
    ]);
    // A parent that belongs to a remote caller leaves the span at the top.
    expect(spanDepths([span("e", { parentSpanId: "remote" })]).get("e")).toBe(
      0,
    );
  });

  it("picks out what a request did, and where it failed", () => {
    const breakdown = describeTrace(
      trace(0, {
        spans: [
          span("root", { attributes: { "http.route": "/x" } }),
          span("action", {
            parentSpanId: "root",
            name: "action pages.page.list",
            status: "error",
            attributes: { "brick.error.code": "INTERNAL_SERVER_ERROR" },
            events: [
              {
                name: "exception",
                timeMs: 1,
                attributes: {
                  "exception.message": "db down",
                  "exception.stacktrace": "Error: db down\n  at list",
                },
              },
            ],
          }),
          span("rpc", { parentSpanId: "action", name: "rpc users.getUser" }),
          span("q1", {
            parentSpanId: "action",
            startMs: 1,
            endMs: 4,
            attributes: { "db.statement": "select 1" },
          }),
          span("q2", {
            parentSpanId: "action",
            startMs: 5,
            endMs: 15,
            attributes: { "db.statement": "select 2" },
          }),
        ],
      }),
    );
    expect(breakdown.action?.spanId).toBe("action");
    expect(breakdown.calls.map((call) => call.spanId)).toEqual(["rpc"]);
    expect(breakdown.queries).toEqual({ count: 2, totalMs: 13, slowestMs: 10 });
    expect(breakdown.exception).toEqual({
      message: "db down",
      stack: "Error: db down\n  at list",
      code: "INTERNAL_SERVER_ERROR",
      span: "action pages.page.list",
    });
  });

  it("finds no failure in a request that had none", () => {
    const breakdown = describeTrace(trace(0, { spans: [span("root")] }));
    expect(breakdown.exception).toBeUndefined();
    expect(breakdown.queries.count).toBe(0);
    expect(breakdown.action).toBeUndefined();
  });
});

describe("withAppServer", () => {
  const app = "http://localhost:4000";

  it("points a document without servers at the app", () => {
    expect(withAppServer({ openapi: "3.1.0", paths: {} }, app)).toEqual({
      openapi: "3.1.0",
      paths: {},
      servers: [{ url: app, description: "Dev server" }],
    });
  });

  it("resolves relative servers against the app and keeps absolute ones", () => {
    const document = withAppServer(
      {
        servers: [
          { url: "/api/auth", description: "Auth" },
          { url: "v2" },
          { url: "http://localhost:5174/api/auth/" },
          { url: "https://{region}.example.com" },
          { description: "no address" },
        ],
      },
      app,
    );
    expect(document.servers).toEqual([
      { url: "http://localhost:4000/api/auth", description: "Auth" },
      { url: "http://localhost:4000/v2" },
      { url: "http://localhost:5174/api/auth" },
      { url: "https://{region}.example.com" },
    ]);
  });

  it("leaves the document alone when the app's address is not known", () => {
    const document = { servers: [{ url: "/api" }] };
    expect(withAppServer(document, undefined)).toBe(document);
  });
});
