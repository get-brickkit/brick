import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  TracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace";
import { createLogger, DEFAULT_LOG_PREFIXES, stripAnsi } from "../src/logger";

const CAPTURE = Symbol.for("brickkit.logs.capture");
const exporter = new InMemorySpanExporter();
const capture = (on: boolean) => {
  (globalThis as Record<symbol, unknown>)[CAPTURE] = on ? true : undefined;
};

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

afterEach(() => {
  capture(false);
  exporter.reset();
});

afterAll(() => {
  trace.disable();
  context.disable();
});

/** Run `fn` inside a span and return the span as it was exported. */
function inSpan(fn: () => void) {
  trace.getTracer("test").startActiveSpan("work", (span) => {
    fn();
    span.end();
  });
  return exporter.getFinishedSpans()[0]!;
}

describe("createLogger", () => {
  it("prints with its prefix when the dashboard is not collecting logs", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = createLogger("[users:create]");
      const span = inSpan(() => {
        logger.info("created", { id: 1 });
        logger.error("broke");
      });
      expect(log).toHaveBeenCalledWith("[users:create]", "created", { id: 1 });
      expect(error).toHaveBeenCalledWith("[users:create]", "broke");
      expect(span.events).toHaveLength(0);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("uses one prefix per level when given a record", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      createLogger(DEFAULT_LOG_PREFIXES).warn("careful");
      expect(warn).toHaveBeenCalledWith("[WARN]", "careful");
    } finally {
      warn.mockRestore();
    }
  });

  it("records a line as an event on the running span instead of printing", () => {
    capture(true);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      const logger = createLogger("[users:create]");
      const span = inSpan(() => {
        logger.info("created", { id: 1, tags: ["a"] });
        logger.warn("slow", 12, "ms");
        logger.debug("detail");
        logger.error("failed:", new Error("db down"));
      });
      expect(log).not.toHaveBeenCalled();
      expect(span.events.map((event) => event.name)).toEqual([
        "log",
        "log",
        "log",
        "log",
      ]);
      expect(
        span.events.map((event) => event.attributes?.["log.level"]),
      ).toEqual(["info", "warn", "debug", "error"]);
      expect(span.events[0]!.attributes?.["log.message"]).toBe(
        "created { id: 1, tags: [ 'a' ] }",
      );
      expect(span.events[1]!.attributes?.["log.message"]).toBe("slow 12 ms");
      // Errors keep their stack, as console.error would show it.
      expect(String(span.events[3]!.attributes?.["log.message"])).toContain(
        "Error: db down\n    at ",
      );
    } finally {
      log.mockRestore();
    }
  });

  it("still prints a line logged outside any span", () => {
    capture(true);
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      createLogger("[boot]").info("starting");
      expect(log).toHaveBeenCalledWith("[boot]", "starting");
    } finally {
      log.mockRestore();
    }
  });

  it("cuts long lines and large objects down", () => {
    capture(true);
    const logger = createLogger("[x]");
    const span = inSpan(() => {
      logger.info("y".repeat(10_000));
      logger.info({ list: Array.from({ length: 500 }, (_, i) => i) });
    });
    const [long, big] = span.events.map((event) =>
      String(event.attributes?.["log.message"]),
    );
    expect(long!.length).toBeLessThanOrEqual(4001);
    expect(long!.endsWith("…")).toBe(true);
    expect(big).toContain("more items");
  });

  it("keeps 100 lines a span and counts the rest, leaving room for exceptions", () => {
    capture(true);
    const logger = createLogger("[x]");
    const span = inSpan(() => {
      for (let i = 0; i < 130; i++) logger.info(`line ${i}`);
      trace.getActiveSpan()!.recordException(new Error("late failure"));
    });
    const logs = span.events.filter((event) => event.name === "log");
    expect(logs).toHaveLength(100);
    expect(logs.at(-1)!.attributes?.["log.message"]).toBe("line 99");
    expect(span.attributes["brick.logs.dropped"]).toBe(30);
    // The error that ended the work is still there.
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
  });

  it("counts each span's lines on their own", () => {
    capture(true);
    const logger = createLogger("[x]");
    const tracer = trace.getTracer("test");
    for (let n = 0; n < 2; n++) {
      tracer.startActiveSpan("work", (span) => {
        for (let i = 0; i < 100; i++) logger.info("line");
        span.end();
      });
    }
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.events.length)).toEqual([100, 100]);
    expect(spans.some((span) => "brick.logs.dropped" in span.attributes)).toBe(
      false,
    );
  });

  it("leaves terminal colors out of the line, as a library's console output carries them", () => {
    capture(true);
    const logger = createLogger("[x]");
    const colored =
      "\u001b[2m2026-10-17T04:37:49.405Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[1m[Better Auth]:\u001b[0m State not found undefined";
    const span = inSpan(() => {
      logger.error(colored);
      logger.info("\u001b[32mgreen\u001b[39m", { id: 1 });
    });
    expect(
      span.events.map((event) => event.attributes?.["log.message"]),
    ).toEqual([
      "2026-10-17T04:37:49.405Z ERROR [Better Auth]: State not found undefined",
      "green { id: 1 }",
    ]);
  });
});

describe("stripAnsi", () => {
  it("removes color, style, and cursor codes, and titles or links", () => {
    expect(stripAnsi("\u001b[1;31mred\u001b[0m")).toBe("red");
    expect(stripAnsi("\u001b[38;5;208morange\u001b[0m")).toBe("orange");
    expect(stripAnsi("a\u001b[2K\u001b[1Gb")).toBe("ab");
    expect(
      stripAnsi("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007"),
    ).toBe("link");
    expect(stripAnsi("\u001b]0;title\u001b\\text")).toBe("text");
  });

  it("leaves everything else alone, brackets that are only text included", () => {
    expect(stripAnsi("plain [2m text [0m")).toBe("plain [2m text [0m");
    expect(stripAnsi("")).toBe("");
    expect(stripAnsi("tabs\tand\nnewlines")).toBe("tabs\tand\nnewlines");
  });
});
