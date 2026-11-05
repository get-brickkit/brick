import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { trace } from "@opentelemetry/api";
import { GLOBAL_SYMBOL } from "@brickkit/core";
import { captureConsole, installTracing } from "../src/dev-telemetry";
import type { SpanEndRecord, TelemetryRecord } from "../src/dashboard-protocol";
import { resetTracing, waitFor } from "./helpers";

const CAPTURE = Symbol.for(GLOBAL_SYMBOL.logsCapture);

beforeEach(resetTracing);
afterEach(resetTracing);

/** The log events of the spans a run of `work` produced. */
async function logsFrom(work: () => void) {
  const records: TelemetryRecord[] = [];
  installTracing((batch) => records.push(...batch));
  trace.getTracer("test").startActiveSpan("work", (span) => {
    work();
    span.end();
  });
  await waitFor(() => records.some((record) => record.phase === "end"));
  return records
    .filter((record): record is SpanEndRecord => record.phase === "end")
    .flatMap((record) => record.events)
    .filter((event) => event.name === "log")
    .map((event) => [
      event.attributes["log.level"],
      event.attributes["log.message"],
    ]);
}

describe("captureConsole", () => {
  it("sends console lines from a traced request to the dashboard, not the terminal", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    const debug = spyOn(console, "debug").mockImplementation(() => {});
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const lines = await logsFrom(() => {
        console.log("created", { id: 1 });
        console.info("noted");
        console.warn("slow", 12, "ms");
        console.error("failed:", new Error("db down").message);
        console.debug("detail %s", "x");
      });
      expect(lines).toEqual([
        ["info", "created { id: 1 }"],
        ["info", "noted"],
        ["warn", "slow 12 ms"],
        ["error", "failed: db down"],
        ["debug", "detail x"],
      ]);
      for (const spy of [log, warn, error, debug, info])
        expect(spy).not.toHaveBeenCalled();
    } finally {
      captureConsole()();
      for (const spy of [log, warn, error, debug, info]) spy.mockRestore();
    }
  });

  it("still prints a console line logged outside a request", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      installTracing(() => {});
      console.log("starting up", 1);
      expect(log).toHaveBeenCalledWith("starting up", 1);
    } finally {
      captureConsole()();
      log.mockRestore();
    }
  });

  it("counts a line once however many times it is installed", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      captureConsole();
      captureConsole();
      const lines = await logsFrom(() => console.log("once"));
      expect(lines).toEqual([["info", "once"]]);
    } finally {
      captureConsole()();
      log.mockRestore();
    }
  });

  it("puts the console back, and leaves it alone until the dev server asks", () => {
    const before = console.log;
    const restore = captureConsole();
    expect(console.log).not.toBe(before);
    restore();
    expect(console.log).toBe(before);
  });

  it("prints everything when log capture is off", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      captureConsole();
      const lines = await logsFrom(() => {
        (globalThis as Record<symbol, unknown>)[CAPTURE] = undefined;
        console.log("not captured");
      });
      expect(lines).toEqual([]);
      expect(log).toHaveBeenCalledWith("not captured");
    } finally {
      captureConsole()();
      log.mockRestore();
    }
  });
});
