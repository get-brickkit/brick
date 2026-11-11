import type { ScheduleState } from "@brickkit/core";
import { loadBrickApp } from "./app-entry";
import { ConfigError } from "./config";
import { describeSchedule } from "./dashboard-protocol";

/** The schedules as a plain table: name, when, next run, last outcome. */
export function formatSchedules(schedules: ScheduleState[]): string {
  const rows = [
    ["NAME", "WHEN", "NEXT RUN", "LAST RUN"],
    ...schedules.map((schedule) => {
      const last = schedule.runs[0];
      return [
        schedule.name,
        describeSchedule(schedule),
        schedule.running
          ? "running"
          : !schedule.enabled
            ? "disabled"
            : (schedule.nextRunAt ?? "not started yet"),
        last
          ? `${last.outcome} ${last.finishedAt}${last.error ? ` (${last.error})` : ""}`
          : "never",
      ];
    }),
  ];
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column]!),
        )
        .join("  "),
    )
    .join("\n");
}

/**
 * What `brick schedules` runs: list the app's schedules from its schedule
 * table, or, with `run`, make one due now. The processes that run the
 * schedules (`brick start`, `brick worker`) pick it up at their next poll.
 *
 * @throws When the app has no schedules, or none named `run`.
 */
export async function runSchedulesCommand(
  entry: string,
  options: { run?: string } = {},
): Promise<string> {
  const app = await loadBrickApp(entry);
  const schedules = app.events?.schedules;
  if (!schedules)
    throw new ConfigError(
      "Brick: this app has no schedules. Add them with brick({ events: { schedules } }).",
    );
  if (options.run === undefined) return formatSchedules(await schedules.list());
  try {
    return (await schedules.trigger(options.run))
      ? `'${options.run}' is due now: a process running the schedules starts it at its next poll.`
      : `'${options.run}' is running now, so it was not started again.`;
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
}
