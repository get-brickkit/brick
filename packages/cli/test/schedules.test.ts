import { afterEach, describe, expect, it } from "bun:test";
import { resetGlobalRegistry, type BrickApp } from "@brickkit/core";
import { startWorker } from "../src/runner";
import { formatSchedules, runSchedulesCommand } from "../src/schedules";
import { waitFor } from "./helpers";

const entry = new URL("./fixtures/schedules-app.ts", import.meta.url).pathname;
const apps: BrickApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.shutdown();
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.removeAllListeners(signal);
});

describe("schedules in the CLI", () => {
  it("brick worker runs the schedules, and brick schedules lists and triggers them", async () => {
    resetGlobalRegistry();
    const app = (await startWorker({ entry })) as BrickApp;
    apps.push(app);
    const { ran } = await import(entry);
    await waitFor(() => ran.includes("warm-cache"));

    const listing = await runSchedulesCommand(entry);
    expect(listing).toMatch(/^NAME\s+WHEN\s+NEXT RUN\s+LAST RUN/);
    expect(listing).toContain("every 6h");
    expect(listing).toContain("0 2 * * * (Europe/Berlin)");
    expect(listing).toMatch(/report\s+.*disabled\s+never/);
    expect(listing).toMatch(/warm-cache\s+every 6h\s+\S+\s+succeeded/);

    expect(await runSchedulesCommand(entry, { run: "report" })).toContain(
      "'report' is due now",
    );
    // The command loaded this same app module and stopped its events (it is
    // another process in real use), so run what is due by hand.
    expect(await app.events!.schedules!.drain()).toBe(1);
    expect(ran).toContain("report");
    await expect(runSchedulesCommand(entry, { run: "nope" })).rejects.toThrow(
      "No schedule named 'nope'",
    );
  });

  it("formats a schedule that never ran", () => {
    expect(
      formatSchedules([
        {
          name: "a",
          kind: "handler",
          every: 90_000,
          enabled: true,
          nextRunAt: null,
          running: false,
          attempts: 0,
          lastSuccessAt: null,
          runs: [],
        },
      ]).split("\n")[1],
    ).toBe("a     every 90s  not started yet  never");
  });
});
