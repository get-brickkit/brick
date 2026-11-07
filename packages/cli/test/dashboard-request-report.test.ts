import { describe, expect, it } from "bun:test";
import { toRow } from "../src/dashboard-query";
import { requestReport } from "../dashboard/request-report";
import type { TraceSummary } from "../src/dashboard-protocol";

const start = Date.UTC(2026, 9, 17, 4, 37, 52, 853);

const trace: TraceSummary = {
  traceId: "68dbe0dedd4da3751225c94fcdcc7e05",
  name: "POST /api/auth/*",
  method: "POST",
  route: "/api/auth/*",
  path: "/api/auth/reset-password",
  httpStatus: 400,
  generation: 1,
  startMs: start,
  endMs: start + 2.3,
  durationMs: 2.3,
  status: "error",
  truncated: false,
  service: "auth",
  action: "resetPassword",
  message: "Invalid token",
  spans: [
    {
      spanId: "root",
      name: "POST /api/auth/*",
      startMs: start,
      endMs: start + 2.3,
      status: "error",
      attributes: {
        "http.route": "/api/auth/*",
        "http.response.status_code": 400,
      },
      events: [],
    },
    {
      spanId: "handler",
      parentSpanId: "root",
      name: "handler /reset-password",
      startMs: start + 1.2,
      endMs: start + 2.3,
      status: "error",
      statusMessage: "Invalid token",
      attributes: { "brick.error.code": "INVALID_TOKEN" },
      events: [
        {
          name: "log",
          timeMs: start + 1.3,
          attributes: {
            "log.level": "warn",
            "log.message": "token expired\nfor user 7",
          },
        },
        {
          name: "exception",
          timeMs: start + 2.2,
          attributes: {
            "exception.message": "Invalid token",
            "exception.stacktrace":
              "Error: Invalid token\n    at verify (auth.ts:10:3)",
          },
        },
      ],
    },
    {
      spanId: "sql",
      parentSpanId: "handler",
      name: "db findOne verification",
      startMs: start + 1.4,
      status: "unset",
      attributes: {
        "db.statement": "SELECT *\nFROM verification\nWHERE id = $1",
        "db.rows": 0,
      },
      events: [],
    },
  ],
};

describe("requestReport", () => {
  const report = requestReport(trace, trace);

  it("opens with the request and how it went", () => {
    expect(report.startsWith("# POST /api/auth/reset-password\n")).toBe(true);
    expect(report).toContain("Trace ID:   68dbe0dedd4da3751225c94fcdcc7e05");
    expect(report).toContain("Started:    2026-10-17T04:37:52.853Z");
    expect(report).toContain("Status:     HTTP 400, error");
    expect(report).toContain("Duration:   2.3 ms");
    expect(report).toContain("Route:      /api/auth/*");
    expect(report).toContain("Path:       /api/auth/reset-password");
    expect(report).toContain("Handled by: auth.resetPassword");
  });

  it("gives the error with its code, where it came from, and its stack trace", () => {
    expect(report).toContain("## Error");
    expect(report).toContain("Code: INVALID_TOKEN");
    expect(report).toContain("Message: Invalid token");
    expect(report).toContain("Raised in: handler /reset-password");
    expect(report).toContain(
      "Stack trace:\nError: Invalid token\n    at verify (auth.ts:10:3)",
    );
  });

  it("lists the lines logged, in order, with the span each came from", () => {
    expect(report).toContain("## Logs (1)");
    expect(report).toMatch(
      /\+1\.3 ms WARN \[handler \/reset-password\] token expired\n {2}for user 7/,
    );
  });

  it("lists every span, nested, with all its attributes, events, and statements", () => {
    expect(report).toContain("## Spans (3)");
    expect(report).toContain(
      "- POST /api/auth/* [http] +0.00 ms, 2.3 ms, error",
    );
    expect(report).toContain("    http.response.status_code: 400");
    expect(report).toContain(
      "  - handler /reset-password [other] +1.2 ms, 1.1 ms, error: Invalid token",
    );
    // A statement is kept whole, as a block under its name.
    expect(report).toContain(
      "        db.statement:\n          SELECT *\n          FROM verification\n          WHERE id = $1\n",
    );
    expect(report).toContain("db.rows: 0");
    // A span still running says so.
    expect(report).toContain(
      "db findOne verification [sql] +1.4 ms, running, unset",
    );
    // The exception is an event of its span; the log line is not repeated there.
    expect(report).toContain("event exception at +2.2 ms");
    expect(report).toContain(
      "exception.stacktrace:\n          Error: Invalid token\n              at verify (auth.ts:10:3)",
    );
    expect(report.match(/token expired/g)).toHaveLength(1);
  });

  it("indents spans by their depth", () => {
    const lines = report.split("\n");
    const depth = (name: string) =>
      lines.find((line) => line.includes(name))!.search(/\S/);
    expect(depth("- POST /api/auth/*")).toBe(0);
    expect(depth("- handler /reset-password")).toBe(2);
    expect(depth("- db findOne verification")).toBe(4);
  });

  it("leaves out an outcome of ok next to an HTTP status, which says as much", () => {
    const finished = requestReport({ ...trace, status: "ok" }, undefined);
    expect(finished).toContain("Status:     HTTP 400\n");
    const running = requestReport(
      { ...trace, status: "running", httpStatus: undefined },
      undefined,
    );
    expect(running).toContain("Status:     no HTTP status, running\n");
  });

  it("ends with a newline", () => {
    expect(report.endsWith("\n")).toBe(true);
  });
});

describe("requestReport without the spans", () => {
  const row = toRow(trace);

  it("reports what the list knows, and says why the spans are missing", () => {
    const missing = requestReport(row, undefined);
    expect(missing).toContain("# POST /api/auth/reset-password");
    expect(missing).toContain("Status:     HTTP 400, error");
    expect(missing).toContain("Message: Invalid token");
    expect(missing).toContain("no longer kept");
    expect(missing).not.toContain("## Spans");
    expect(requestReport(row, undefined, { loading: true })).toContain(
      "still loading",
    );
  });

  it("copes with a request that has no method, path, or status yet", () => {
    const report = requestReport(
      {
        traceId: "t",
        name: "rpc call",
        generation: 1,
        startMs: start,
        status: "running",
        truncated: false,
        spans: [],
      },
      undefined,
    );
    expect(report.startsWith("# rpc call\n")).toBe(true);
    expect(report).toContain("Status:     no HTTP status, running");
    expect(report).toContain("Duration:   running");
  });
});
