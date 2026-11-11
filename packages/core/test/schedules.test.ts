import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  brick,
  defineDatabase,
  defineSchedule,
  defineService,
  DuplicateNameError,
  scheduleTable,
  syncSchema,
  type ScheduleConfig,
  type ScheduleRun,
} from "../src";
import { Scheduler } from "../src/schedules/scheduler";
import { track, waitFor } from "./helpers";

afterEach(() => {
  setSystemTime();
});

let serial = 0;

const at = (iso: string) => {
  const date = new Date(iso);
  setSystemTime(date);
  return date;
};

function setup(configs: ScheduleConfig[]) {
  const table = scheduleTable("sqlite");
  const database = defineDatabase({ tables: { schedules: table } });
  const db: any = database.getDb();
  syncSchema([table], db);
  const service = defineService(`schedules_test_${++serial}`, { database });
  const app = track(
    brick({
      services: [service],
      events: {
        schedules: configs.map(defineSchedule),
        dispatch: { timer: false },
      },
      requestLogging: false,
      docs: false,
    }),
  );
  const schedules = app.events!.schedules!;
  const row = async (name: string) =>
    (await db.select().from(table)).find((r: any) => r.name === name);
  return { app, db, table, schedules, row };
}

/** A run handler that records what it was given. */
function recorder() {
  const calls: ScheduleRun[] = [];
  return { calls, run: (run: ScheduleRun) => void calls.push(run) };
}

describe("defineSchedule", () => {
  const run = () => {};
  it("refuses bad declarations", () => {
    const bad: [Partial<ScheduleConfig>, string][] = [
      [{ name: "", every: "1h", run }, "needs a name"],
      [{ name: "a:b", every: "1h", run }, "must not contain ':'"],
      [{ name: "a", run }, "cron expression or an interval"],
      [{ name: "a", cron: "* * * * *", every: "1h", run } as any, "not both"],
      [{ name: "a", every: "1h" }, "run handler or a workflow"],
      [{ name: "a", cron: "61 * * * *", run }, "outside 0-59"],
      [{ name: "a", cron: "0 0 30 2 *", run }, "never fires"],
      [{ name: "a", cron: "@daily", timeZone: "Mars/Base", run }, "time zone"],
      [{ name: "a", every: "soon", run }, "not a duration"],
      [{ name: "a", every: "1h", maxAttempts: 0, run }, "maxAttempts"],
      [{ name: "a", every: "1h", catchUp: "all" as any, run }, "catchUp"],
    ];
    for (const [config, message] of bad)
      expect(() => defineSchedule(config as ScheduleConfig)).toThrow(message);
  });

  it("needs one schedule table and unique names", () => {
    const schedule = defineSchedule({ name: "a", every: "1h", run });
    const service = defineService(`schedules_none_${++serial}`, {
      database: defineDatabase({ tables: {} }),
    });
    expect(() =>
      brick({ services: [service], events: { schedules: [schedule] } }),
    ).toThrow("no service database holds one");
    expect(() =>
      brick({
        services: [service],
        events: { schedules: [schedule, schedule] },
      }),
    ).toThrow(DuplicateNameError);
  });
});

describe("schedules", () => {
  it("runs nothing until the app's events start", async () => {
    const { calls, run } = recorder();
    const { app, row } = setup([{ name: "tick", every: "1h", run }]);
    // brick() and the declarations wrote nothing and ran nothing.
    expect(await row("tick")).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(app.definition.events?.schedules).toEqual([
      { name: "tick", kind: "handler", every: 3_600_000, enabled: true },
    ]);
  });

  it("runs an interval at once, then that long after each success", async () => {
    const start = at("2026-01-01T00:00:00Z");
    const { calls, run } = recorder();
    const { schedules, row } = setup([{ name: "tick", every: "6h", run }]);
    expect(await schedules.drain()).toBe(1);
    expect(calls[0]).toMatchObject({
      schedule: "tick",
      slot: start.toISOString(),
      trigger: "schedule",
      attempt: 1,
      runKey: `tick:${start.toISOString()}`,
    });
    expect((await row("tick")).nextAt.toISOString()).toBe(
      "2026-01-01T06:00:00.000Z",
    );
    at("2026-01-01T05:59:00Z");
    expect(await schedules.drain()).toBe(0);
    at("2026-01-01T06:00:00Z");
    expect(await schedules.drain()).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("runs a cron schedule at its times only", async () => {
    at("2026-01-01T00:10:00Z");
    const { calls, run } = recorder();
    const { schedules } = setup([
      { name: "hourly", cron: "0 * * * *", run },
      {
        name: "berlin",
        cron: "0 9 * * *",
        timeZone: "Europe/Berlin",
        run,
      },
    ]);
    expect(await schedules.drain()).toBe(0);
    const [hourly, berlin] = await schedules.list();
    expect(hourly!.nextRunAt).toBe("2026-01-01T01:00:00.000Z");
    expect(berlin!.nextRunAt).toBe("2026-01-01T08:00:00.000Z");
    at("2026-01-01T01:00:00Z");
    expect(await schedules.drain()).toBe(1);
    expect(calls[0]!.slot).toBe("2026-01-01T01:00:00.000Z");
  });

  it("retries a failed run of the same slot with backoff, then moves on", async () => {
    at("2026-01-01T00:00:00Z");
    const attempts: number[] = [];
    const { schedules, row } = setup([
      {
        name: "flaky",
        cron: "0 0 * * *",
        backoff: "1m",
        maxAttempts: 3,
        run: ({ attempt }) => {
          attempts.push(attempt);
          throw new Error(`boom ${attempt}`);
        },
      },
    ]);
    await schedules.drain();
    at("2026-01-02T00:00:00Z");
    await schedules.drain();
    let state = await row("flaky");
    expect(state.slot.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(state.nextAt.toISOString()).toBe("2026-01-02T00:01:00.000Z");
    at("2026-01-02T00:01:00Z");
    await schedules.drain();
    // The second retry waits twice as long.
    expect((await row("flaky")).nextAt.toISOString()).toBe(
      "2026-01-02T00:03:00.000Z",
    );
    at("2026-01-02T00:03:00Z");
    await schedules.drain();
    expect(attempts).toEqual([1, 2, 3]);
    state = await row("flaky");
    expect(state.nextAt.toISOString()).toBe("2026-01-03T00:00:00.000Z");
    expect(state.attempts).toBe(0);
    expect(state.lastSuccessAt).toBeNull();
    const [listed] = await schedules.list();
    expect(listed!.runs.map((r) => [r.outcome, r.attempt, r.error])).toEqual([
      ["failed", 3, "boom 3"],
      ["failed", 2, "boom 2"],
      ["failed", 1, "boom 1"],
    ]);
  });

  it("counts a slot done only after success", async () => {
    at("2026-01-01T00:00:00Z");
    let fail = true;
    const slots: string[] = [];
    const { schedules, row } = setup([
      {
        name: "backup",
        every: "1h",
        backoff: "10s",
        run: ({ slot }) => {
          slots.push(slot);
          if (fail) throw new Error("disk full");
        },
      },
    ]);
    await schedules.drain();
    fail = false;
    at("2026-01-01T00:00:10Z");
    await schedules.drain();
    expect(slots).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ]);
    const state = await row("backup");
    expect(state.lastSuccessAt.toISOString()).toBe("2026-01-01T00:00:10.000Z");
    // An interval counts from the end of the last success.
    expect(state.nextAt.toISOString()).toBe("2026-01-01T01:00:10.000Z");
  });

  it("takes over a run whose process died, and runs the slot again", async () => {
    at("2026-01-01T00:00:00Z");
    const { calls, run } = recorder();
    const { db, table, schedules, row } = setup([
      { name: "report", cron: "0 0 * * *", run },
    ]);
    await schedules.drain();
    // Another process claimed the midnight run, then died without finishing.
    at("2026-01-02T00:00:00Z");
    await db.update(table).set({
      runId: "dead-process",
      startedAt: new Date(),
      leaseUntil: new Date(Date.now() + 60_000),
      attempts: 1,
    });
    expect(await schedules.drain()).toBe(0);
    at("2026-01-02T00:01:01Z");
    expect(await schedules.drain()).toBe(1);
    expect(calls).toMatchObject([
      { slot: "2026-01-02T00:00:00.000Z", attempt: 2 },
    ]);
    const [listed] = await schedules.list();
    expect(listed!.runs.map((r) => [r.outcome, r.attempt])).toEqual([
      ["succeeded", 2],
      ["failed", 1],
    ]);
    expect(listed!.runs[1]!.error).toContain("stopped before it finished");
    expect((await row("report")).nextAt.toISOString()).toBe(
      "2026-01-03T00:00:00.000Z",
    );
  });

  it("runs slots missed while down once, or skips them", async () => {
    at("2026-01-01T00:30:00Z");
    const once = recorder();
    const skip = recorder();
    const { schedules } = setup([
      { name: "once", cron: "0 * * * *", run: once.run },
      { name: "skip", cron: "0 * * * *", catchUp: "skip", run: skip.run },
    ]);
    await schedules.drain();
    // Down from 00:30 to 05:30: five slots missed.
    at("2026-01-01T05:30:00Z");
    await schedules.drain();
    expect(once.calls).toMatchObject([{ slot: "2026-01-01T01:00:00.000Z" }]);
    expect(skip.calls).toHaveLength(0);
    const [onceState, skipState] = await schedules.list();
    expect(onceState!.nextRunAt).toBe("2026-01-01T06:00:00.000Z");
    expect(skipState!.nextRunAt).toBe("2026-01-01T06:00:00.000Z");
    expect(skipState!.runs.map((r) => r.outcome)).toEqual(["skipped"]);
    // On time, both run.
    at("2026-01-01T06:00:20Z");
    await schedules.drain();
    expect(once.calls).toHaveLength(2);
    expect(skip.calls).toHaveLength(1);
  });

  it("never overlaps a run with the next one", async () => {
    at("2026-01-01T00:00:00Z");
    let release!: () => void;
    let entered = 0;
    const { schedules, row } = setup([
      {
        name: "slow",
        cron: "*/5 * * * *",
        run: () => {
          entered++;
          return new Promise<void>((resolve) => (release = resolve));
        },
      },
    ]);
    await schedules.drain();
    at("2026-01-01T00:05:00Z");
    const first = schedules.drain();
    await waitFor(() => entered === 1);
    expect(await schedules.trigger("slow")).toBe(false);
    expect((await schedules.list())[0]!.running).toBe(true);
    // Two more slots pass while it runs.
    at("2026-01-01T00:12:00Z");
    release();
    await first;
    expect(entered).toBe(1);
    expect((await row("slow")).nextAt.toISOString()).toBe(
      "2026-01-01T00:15:00.000Z",
    );
  });

  it("runs on a manual trigger, even when disabled", async () => {
    at("2026-01-01T00:00:00Z");
    const { calls, run } = recorder();
    const { schedules } = setup([
      { name: "off", every: "1m", enabled: false, run },
    ]);
    expect(await schedules.drain()).toBe(0);
    expect(await schedules.trigger("off")).toBe(true);
    expect(await schedules.drain()).toBe(1);
    expect(calls).toMatchObject([{ trigger: "manual" }]);
    await expect(schedules.trigger("nope")).rejects.toThrow("No schedule");
  });

  it("works out the next time again when the cron expression changes", async () => {
    at("2026-01-01T00:30:00Z");
    const first = setup([{ name: "job", cron: "0 0 * * *", run: () => {} }]);
    await first.schedules.drain();
    expect((await first.schedules.list())[0]!.nextRunAt).toBe(
      "2026-01-02T00:00:00.000Z",
    );
    const changed = defineSchedule({
      name: "job",
      cron: "0 * * * *",
      run: () => {},
    });
    const scheduler = new Scheduler(
      first.db,
      first.table,
      [changed],
      async () => {},
      { timer: false, intervalMs: 1000, claimTimeoutMs: 60_000 },
    );
    await scheduler.drain();
    expect((await scheduler.list())[0]!.nextRunAt).toBe(
      "2026-01-01T01:00:00.000Z",
    );
  });

  it("gives one of two schedulers each slot", async () => {
    at("2026-01-01T00:00:00Z");
    const ran: string[] = [];
    const { db, table } = setup([]);
    const schedule = defineSchedule({
      name: "once",
      every: "1h",
      run: () => {},
    });
    const make = (id: string) =>
      new Scheduler(db, table, [schedule], async () => void ran.push(id), {
        timer: false,
        intervalMs: 1000,
        claimTimeoutMs: 60_000,
      });
    const [a, b] = [make("a"), make("b")];
    await Promise.all([a.drain(), b.drain()]);
    expect(ran).toHaveLength(1);
  });
});
