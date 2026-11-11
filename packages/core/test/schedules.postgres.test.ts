import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { defineSchedule, scheduleTable, syncSchema } from "../src";
import { Scheduler } from "../src/schedules/scheduler";
import { requireService, waitFor } from "./helpers";

const url = requireService("TEST_DATABASE_URL", "schedules.postgres");
const suite = url ? describe : describe.skip;

const clients: ReturnType<typeof postgres>[] = [];
const tables: string[] = [];
afterAll(async () => {
  if (tables.length)
    await clients[0]!.unsafe(
      `DROP TABLE IF EXISTS ${tables.map((name) => `"${name}"`).join(", ")}`,
    );
  await Promise.all(clients.map((client) => client.end()));
});

/** A schedule table of its own, and a database connection per "process". */
async function setup(processes: number) {
  const name = `schedules_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  const table = scheduleTable("postgres", { name });
  const dbs = Array.from({ length: processes }, () => {
    const client = postgres(url!, { max: 4, onnotice: () => {} });
    clients.push(client);
    return drizzle(client);
  });
  tables.push(name);
  await syncSchema([table], dbs[0]);
  return { name, table, dbs };
}

const options = { timer: false, intervalMs: 1000, claimTimeoutMs: 300 };

suite("schedules on Postgres", () => {
  it("runs each due time in one of many processes", async () => {
    const { table, dbs } = await setup(5);
    const runs: { process: number; slot: string }[] = [];
    // A manual trigger is a new due time each round.
    const schedule = defineSchedule({
      name: "job",
      every: "1h",
      run: () => {},
    });
    const schedulers = dbs.map(
      (db, process) =>
        new Scheduler(
          db,
          table,
          [schedule],
          async (_schedule, run) => {
            runs.push({ process, slot: run.slot });
            await Bun.sleep(5);
          },
          options,
        ),
    );
    await Promise.all(schedulers.map((scheduler) => scheduler.drain()));
    for (let round = 0; round < 10; round++) {
      await schedulers[round % 5]!.trigger("job");
      await Promise.all(schedulers.map((scheduler) => scheduler.drain()));
    }
    expect(runs).toHaveLength(11);
    expect(new Set(runs.map((run) => run.slot)).size).toBe(11);
  });

  it("takes over the run of a process that was killed mid-run", async () => {
    const { name, table, dbs } = await setup(1);
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures", "schedule-crash.ts"),
        url!,
        name,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const reader = child.stdout.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("running");
    child.kill("SIGKILL");
    await child.exited;

    const attempts: number[] = [];
    const scheduler = new Scheduler(
      dbs[0],
      table,
      [defineSchedule({ name: "job", every: "1h", run: () => {} })],
      async (_schedule, run) => void attempts.push(run.attempt),
      options,
    );
    // Held by the dead process until its claim runs out.
    expect(await scheduler.drain()).toBe(0);
    await waitFor(async () => (await scheduler.drain()) === 1, 3000);
    expect(attempts).toEqual([2]);
    const [state] = await scheduler.list();
    expect(state!.runs.map((run) => [run.outcome, run.attempt])).toEqual([
      ["succeeded", 2],
      ["failed", 1],
    ]);
    expect(state!.lastSuccessAt).not.toBeNull();
  });
});
