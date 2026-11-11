import { describe, expect, it } from "bun:test";
import { nextCron, parseCron, parseDuration } from "../src/schedules/cron";

/** The next `count` times `expression` fires after `from`, as ISO strings. */
function fires(
  expression: string,
  from: string,
  timeZone = "UTC",
  count = 1,
): string[] {
  const cron = parseCron(expression);
  const out: string[] = [];
  let at = new Date(from);
  for (let i = 0; i < count; i++) {
    at = nextCron(cron, at, timeZone)!;
    out.push(at.toISOString());
  }
  return out;
}

describe("parseCron", () => {
  it("refuses malformed expressions", () => {
    for (const bad of [
      "",
      "* * * *",
      "* * * * * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 8",
      "5-1 * * * *",
      "*/0 * * * *",
      "a * * * *",
      "1/2/3 * * * *",
      "1-5-9 * * * *",
    ])
      expect(() => parseCron(bad)).toThrow();
  });

  it("reads ranges, steps, lists, names and macros", () => {
    const cron = parseCron("0-10/5,30 9-17 * jan-mar mon-fri");
    expect([...cron.minutes]).toEqual([0, 5, 10, 30]);
    expect([...cron.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...cron.months]).toEqual([1, 2, 3]);
    expect([...cron.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect([...cron.seconds]).toEqual([0]);
    expect([...parseCron("5/20 * * * *").minutes]).toEqual([5, 25, 45]);
    expect([...parseCron("* * * * 7").weekdays]).toEqual([0]);
    expect(parseCron("@daily").minutes).toEqual(parseCron("0 0 * * *").minutes);
  });
});

describe("nextCron", () => {
  it("finds the next time, strictly after the given one", () => {
    expect(fires("*/15 * * * *", "2026-01-01T10:07:30Z")).toEqual([
      "2026-01-01T10:15:00.000Z",
    ]);
    expect(fires("*/15 * * * *", "2026-01-01T10:15:00Z")).toEqual([
      "2026-01-01T10:30:00.000Z",
    ]);
    expect(fires("0 */6 * * *", "2026-01-01T05:59:59.999Z", "UTC", 3)).toEqual([
      "2026-01-01T06:00:00.000Z",
      "2026-01-01T12:00:00.000Z",
      "2026-01-01T18:00:00.000Z",
    ]);
  });

  it("takes seconds as a sixth field", () => {
    expect(fires("*/20 * * * * *", "2026-01-01T00:00:00Z", "UTC", 3)).toEqual([
      "2026-01-01T00:00:20.000Z",
      "2026-01-01T00:00:40.000Z",
      "2026-01-01T00:01:00.000Z",
    ]);
  });

  it("treats a stepped star day field as unrestricted, as Vixie cron does", () => {
    // Odd days that are Mondays, not odd days or Mondays. 2026-02-09 is a Monday.
    expect(fires("0 0 */2 * 1", "2026-02-01T00:00:00Z", "UTC", 2)).toEqual([
      "2026-02-09T00:00:00.000Z",
      "2026-02-23T00:00:00.000Z",
    ]);
  });

  it("matches either day field when both are restricted", () => {
    // The 13th, or any Friday. 2026-02-06 is a Friday.
    expect(fires("0 0 13 * fri", "2026-02-01T00:00:00Z", "UTC", 3)).toEqual([
      "2026-02-06T00:00:00.000Z",
      "2026-02-13T00:00:00.000Z",
      "2026-02-20T00:00:00.000Z",
    ]);
  });

  it("crosses months and years, and finds leap days", () => {
    expect(fires("0 0 31 * *", "2026-01-31T00:00:00Z")).toEqual([
      "2026-03-31T00:00:00.000Z",
    ]);
    expect(fires("0 12 29 2 *", "2026-03-01T00:00:00Z")).toEqual([
      "2028-02-29T12:00:00.000Z",
    ]);
    expect(nextCron(parseCron("0 0 30 2 *"), new Date())).toBeUndefined();
  });

  it("reads wall-clock times in the time zone", () => {
    expect(fires("0 9 * * *", "2026-06-01T00:00:00Z", "Asia/Kolkata")).toEqual([
      "2026-06-01T03:30:00.000Z",
    ]);
    // Berlin is UTC+2 in summer and UTC+1 in winter.
    expect(fires("0 2 * * *", "2026-07-01T12:00:00Z", "Europe/Berlin")).toEqual(
      ["2026-07-02T00:00:00.000Z"],
    );
    expect(fires("0 2 * * *", "2026-12-01T12:00:00Z", "Europe/Berlin")).toEqual(
      ["2026-12-02T01:00:00.000Z"],
    );
  });

  describe("across DST changes (America/New_York)", () => {
    const zone = "America/New_York";

    it("runs a time the clocks skip once, when they jump", () => {
      // 2026-03-08: 02:00 EST becomes 03:00 EDT, so 02:30 does not exist.
      expect(fires("30 2 * * *", "2026-03-07T12:00:00Z", zone, 3)).toEqual([
        "2026-03-08T07:30:00.000Z", // 03:30 EDT, shifted by the gap
        "2026-03-09T06:30:00.000Z", // 02:30 EDT
        "2026-03-10T06:30:00.000Z",
      ]);
      expect(fires("0 * * * *", "2026-03-08T06:30:00Z", zone, 2)).toEqual([
        "2026-03-08T07:00:00.000Z", // 03:00 EDT: 02:00 shifts onto it, once
        "2026-03-08T08:00:00.000Z",
      ]);
    });

    it("runs a time the clocks repeat once, the first time", () => {
      // 2026-11-01: 02:00 EDT becomes 01:00 EST, so 01:30 happens twice.
      expect(fires("30 1 * * *", "2026-10-31T12:00:00Z", zone, 2)).toEqual([
        "2026-11-01T05:30:00.000Z", // 01:30 EDT
        "2026-11-02T06:30:00.000Z", // 01:30 EST
      ]);
      expect(fires("0 * * * *", "2026-11-01T04:30:00Z", zone, 3)).toEqual([
        "2026-11-01T05:00:00.000Z", // 01:00 EDT
        "2026-11-01T07:00:00.000Z", // 02:00 EST; the repeated 01:00 ran already
        "2026-11-01T08:00:00.000Z",
      ]);
      // From inside the repeated hour, its times are not run again.
      expect(fires("30 1 * * *", "2026-11-01T06:10:00Z", zone)).toEqual([
        "2026-11-02T06:30:00.000Z",
      ]);
    });
  });
});

describe("parseDuration", () => {
  it("reads milliseconds and unit text", () => {
    expect(parseDuration(1500)).toBe(1500);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("15m")).toBe(900_000);
    expect(parseDuration("6h")).toBe(21_600_000);
    expect(parseDuration("1d")).toBe(86_400_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("250ms")).toBe(250);
  });

  it("takes zero only when asked to", () => {
    expect(parseDuration("0s", { allowZero: true })).toBe(0);
    expect(parseDuration(0, { allowZero: true })).toBe(0);
    expect(() => parseDuration(-1, { allowZero: true })).toThrow();
  });

  it("refuses anything else", () => {
    for (const bad of [
      "",
      "6",
      "6x",
      "h",
      "1h 30",
      0,
      -5,
      Number.NaN,
      0.4,
      "0.1ms",
      "100000000000d",
      1e16,
    ])
      expect(() => parseDuration(bad)).toThrow("is not a duration");
  });
});
