// A process that claims a schedule's due time and hangs in its run, for the
// test to kill: `bun schedule-crash.ts <database url> <table name>`.
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { defineSchedule, scheduleTable } from "../../src";
import { Scheduler } from "../../src/schedules/scheduler";

const [url, name] = process.argv.slice(2) as [string, string];
const table = scheduleTable("postgres", { name });
const db = drizzle(postgres(url, { onnotice: () => {} }));
const schedule = defineSchedule({ name: "job", every: "1h", run: () => {} });
const scheduler = new Scheduler(
  db,
  table,
  [schedule],
  () => {
    console.log("running");
    return new Promise(() => {});
  },
  { timer: false, intervalMs: 1000, claimTimeoutMs: 300 },
);
void scheduler.drain();
