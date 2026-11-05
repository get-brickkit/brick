import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { context, propagation, trace } from "@opentelemetry/api";
import { createLogger } from "../../core/src/logger";
import {
  collectLogs,
  countLevels,
  highlight,
  highlightTerms,
  logsOfTrace,
  parseLogQuery,
  queryLogs,
} from "../dashboard/logs";
import {
  captureConsole,
  installTracing,
  type TelemetryRecord,
} from "../src/dev-telemetry";
import type { TraceSummary } from "../src/dashboard-protocol";
import { DevTelemetryStore } from "../src/dev-telemetry-store";

function traceWith(
  id: string,
  startMs: number,
  logs: [number, string, string][],
  attributes: Record<string, string | number> = {},
): TraceSummary {
  return {
    traceId: id,
    name: "POST /api/users/create",
    method: "POST",
    route: "/api/users/create",
    generation: 1,
    startMs,
    status: "ok",
    truncated: false,
    spans: [
      {
        spanId: `${id}-action`,
        name: "action users.create",
        startMs,
        status: "ok",
        attributes,
        events: [
          ...logs.map(([timeMs, level, message]) => ({
            name: "log",
            timeMs,
            attributes: { "log.level": level, "log.message": message },
          })),
          { name: "exception", timeMs: startMs, attributes: {} },
        ],
      },
    ],
  };
}

describe("logsOfTrace", () => {
  it("lists the log events of a request in the order they happened", () => {
    const { entries, dropped } = logsOfTrace(
      traceWith("t1", 1000, [
        [1010, "warn", "second"],
        [1005, "info", "first"],
      ]),
    );
    expect(entries.map((entry) => entry.message)).toEqual(["first", "second"]);
    expect(entries[0]).toMatchObject({
      level: "info",
      traceId: "t1",
      span: "action users.create",
      route: "/api/users/create",
      method: "POST",
    });
    expect(dropped).toBe(0);
  });

  it("ignores other events, and reads an unknown level as info", () => {
    const { entries } = logsOfTrace(
      traceWith("t1", 1000, [[1001, "verbose", "odd"]]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("info");
  });

  it("shows no terminal color codes, even in lines stored with them", () => {
    const { entries } = logsOfTrace(
      traceWith("t1", 1000, [
        [
          1001,
          "error",
          "\u001b[2m2026-10-17T04:37:49Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[1m[Better Auth]:\u001b[0m State not found",
        ],
      ]),
    );
    expect(entries[0]!.message).toBe(
      "2026-10-17T04:37:49Z ERROR [Better Auth]: State not found",
    );
  });

  it("reports how many lines a span left out", () => {
    const { dropped } = logsOfTrace(
      traceWith("t1", 1000, [], { "brick.logs.dropped": 30 }),
    );
    expect(dropped).toBe(30);
  });
});

describe("collectLogs and filterLogs", () => {
  const traces = [
    traceWith("a", 1000, [
      [1001, "info", "created user 7"],
      [1002, "error", "mail failed: timeout"],
    ]),
    traceWith("b", 2000, [[2001, "debug", "cache miss"]]),
  ];

  it("puts the newest line first, across requests", () => {
    expect(collectLogs(traces).map((entry) => entry.message)).toEqual([
      "cache miss",
      "mail failed: timeout",
      "created user 7",
    ]);
    expect(collectLogs(traces, 2)).toHaveLength(2);
  });
});

describe("parseLogQuery and queryLogs", () => {
  const entries = collectLogs([
    traceWith("2ef0d119aaaa", 1000, [
      [1001, "info", "created user 7"],
      [1002, "error", "mail failed: timeout after 30s"],
      [1003, "warn", "mail slow"],
    ]),
    traceWith("a6b8200fbbbb", 2000, [
      [2001, "debug", "cache miss for user 7"],
      [2002, "info", "created user 8"],
    ]),
  ]);
  const find = (text: string) =>
    queryLogs(entries, parseLogQuery(text)).map((entry) => entry.message);

  it("needs every word, wherever it is in the line", () => {
    expect(find("")).toHaveLength(5);
    expect(find("user 7")).toEqual(["cache miss for user 7", "created user 7"]);
    expect(find("MAIL timeout")).toEqual(["mail failed: timeout after 30s"]);
    expect(find("nothing like this")).toEqual([]);
  });

  it("matches a quoted phrase exactly, and leaves out what follows a minus", () => {
    expect(find('"user 7"')).toHaveLength(2);
    expect(find('"7 user"')).toEqual([]);
    expect(find('"created user" -8')).toEqual(["created user 7"]);
    expect(find("mail -slow")).toEqual(["mail failed: timeout after 30s"]);
  });

  it("reads field:value for one part of a line", () => {
    expect(find("level:error")).toEqual(["mail failed: timeout after 30s"]);
    expect(find("level:warn,error")).toHaveLength(2);
    expect(find("-level:info -level:debug")).toHaveLength(2);
    expect(find("trace:2ef0")).toHaveLength(3);
    expect(find("trace:2EF0 level:info")).toEqual(["created user 7"]);
    expect(find("method:post")).toHaveLength(5);
    expect(find("method:get")).toEqual([]);
    expect(find("route:/api/users")).toHaveLength(5);
    expect(find("action:users.create")).toHaveLength(5);
    expect(find('route:"/api/users/create" mail')).toHaveLength(2);
  });

  it("waits for a field's value before it narrows anything", () => {
    expect(find("level:")).toHaveLength(5);
    expect(find("mail trace:")).toHaveLength(2);
    // Not a field: plain text, as typed.
    expect(find("http:")).toEqual([]);
  });

  it("copes with an unclosed quote", () => {
    expect(find('"created')).toHaveLength(2);
  });

  it("counts the lines at each level", () => {
    expect(countLevels(entries)).toEqual({
      debug: 1,
      info: 2,
      warn: 1,
      error: 1,
    });
  });
});

describe("highlight", () => {
  it("marks every place a plain word or phrase appears, in any case", () => {
    const terms = highlightTerms(
      parseLogQuery('MAIL "timeout after" level:error -slow'),
    );
    expect(terms).toEqual(["mail", "timeout after"]);
    expect(highlight("Mail failed: timeout after 30s; mail", terms)).toEqual([
      { text: "Mail", hit: true },
      { text: " failed: ", hit: false },
      { text: "timeout after", hit: true },
      { text: " 30s; ", hit: false },
      { text: "mail", hit: true },
    ]);
  });

  it("returns the message whole when there is nothing to mark, and escapes patterns", () => {
    expect(highlight("a line", [])).toEqual([{ text: "a line", hit: false }]);
    expect(highlight("cost (3) [x] $1", ["(3)", "[x]", "$1"])).toEqual([
      { text: "cost ", hit: false },
      { text: "(3)", hit: true },
      { text: " ", hit: false },
      { text: "[x]", hit: true },
      { text: " ", hit: false },
      { text: "$1", hit: true },
    ]);
  });
});

describe("from ctx.logger to the dashboard", () => {
  // Another test file in the same run may have left a tracer provider
  // registered, which would leave `installTracing` nothing to install.
  beforeAll(() => {
    captureConsole()();
    trace.disable();
    context.disable();
    propagation.disable();
  });

  afterAll(() => {
    captureConsole()();
    (globalThis as Record<symbol, unknown>)[
      Symbol.for("brickkit.logs.capture")
    ] = undefined;
    trace.disable();
    context.disable();
  });

  it("shows a line logged in a traced request, as the dev server records it", async () => {
    const records: TelemetryRecord[] = [];
    // The same call the dev worker makes: it also turns log capture on.
    expect(installTracing((batch) => records.push(...batch))).toBe(true);
    const logger = createLogger("[users:create]");
    const tracer = trace.getTracer("test");
    tracer.startActiveSpan(
      "POST /api/users/create",
      {
        attributes: {
          "http.request.method": "POST",
          "http.route": "/api/users/create",
        },
      },
      (root) => {
        tracer.startActiveSpan("action users.create", (action) => {
          logger.info("created", { id: 7 });
          logger.warn("slow mail");
          action.end();
        });
        root.end();
      },
    );
    // Records are sent in batches, a moment after the spans end.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const store = new DevTelemetryStore();
    store.ingest(records, 1);
    const [summary] = store.snapshot().traces;
    const { entries } = logsOfTrace(summary!);
    expect(entries.map((entry) => [entry.level, entry.message])).toEqual([
      ["info", "created { id: 7 }"],
      ["warn", "slow mail"],
    ]);
    expect(entries[0]).toMatchObject({
      span: "action users.create",
      route: "/api/users/create",
    });
  });
});
