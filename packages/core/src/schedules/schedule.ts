import {
  checkTimeZone,
  nextCron,
  parseCron,
  parseDuration,
  type CronExpression,
} from "./cron";

/** What a schedule's `run` receives: which run this is. */
export interface ScheduleRun {
  /** The schedule's name. */
  schedule: string;
  /**
   * When this run was due, as an ISO timestamp: the cron time, the end of the
   * interval, or the moment someone triggered it. Retries of a failed run keep it.
   */
  slot: string;
  /** `manual` when started with `schedules.trigger(name)` or `brick schedules run`. */
  trigger: "schedule" | "manual";
  /** 1 on the first try, 2 on the first retry, and so on. */
  attempt: number;
  /** `<schedule>:<slot>`: the same on every retry, for idempotency keys. */
  runKey: string;
}

/** What a schedule's workflow receives: the run, without `attempt` (a run starts one workflow however often it is tried). */
export type ScheduleWorkflowRun = Omit<ScheduleRun, "attempt">;

/** A function marked `"use workflow"`, started once per run of the schedule it is given to. */
export type ScheduleWorkflow = (run: ScheduleWorkflowRun) => Promise<unknown>;

type When =
  | {
      /**
       * A cron expression: `"0 2 * * *"` is 02:00 every day. Five fields, or six
       * with seconds first; `@daily` and the other macros work too.
       */
      cron: string;
      /** The IANA time zone `cron` is read in, such as `"Europe/Berlin"`. Default `"UTC"`. */
      timeZone?: string;
      every?: never;
    }
  | {
      /**
       * Run again this long after the last successful run finished: `"6h"`,
       * `"15m"`, `"1h30m"`, or milliseconds. The first run is due as soon as a
       * process starts the schedules.
       */
      every: string | number;
      cron?: never;
      timeZone?: never;
    };

/** What `defineSchedule` takes. */
export type ScheduleConfig = When & {
  /** Unique among the app's schedules, and the key its state is stored under: renaming it starts it afresh. */
  name: string;
  /**
   * A due time that passed while no process ran the schedules (or one more
   * than a minute late): `"once"` (the default) runs it once, however many
   * were missed; `"skip"` skips it and waits for the next.
   */
  catchUp?: "once" | "skip";
  /** Tries per due time, the first included. Default 3. */
  maxAttempts?: number;
  /** The wait before the first retry, doubling on each retry after it; 0 retries at once. Default `"1m"`. */
  backoff?: string | number;
  /** A random delay of up to this much, added to every due time, so many processes or apps do not all start at once. */
  jitter?: string | number;
  /** `false` keeps the schedule from running on its own; `trigger` still runs it. Default `true`. */
  enabled?: boolean;
} & (
    | {
        /** Runs in the process that claims the due time. Throwing retries it. */
        run: (run: ScheduleRun) => void | Promise<void>;
        workflow?: never;
      }
    | {
        /**
         * A durable workflow started for each due time, on the app's
         * `events.world`. The run counts as done once the workflow started; the
         * workflow retries its own steps.
         */
        workflow: ScheduleWorkflow;
        run?: never;
      }
  );

/** A schedule, made by `defineSchedule`. */
export interface Schedule {
  readonly name: string;
  readonly cron?: CronExpression;
  readonly timeZone?: string;
  /** The interval, in milliseconds. */
  readonly every?: number;
  readonly catchUp: "once" | "skip";
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly jitterMs: number;
  readonly enabled: boolean;
  readonly run?: (run: ScheduleRun) => void | Promise<void>;
  readonly workflow?: ScheduleWorkflow;
  /** What decides the due times, as stored with them: a change makes the next one be worked out again. */
  readonly spec: string;
}

/**
 * Define a schedule: code that runs at set times, in one process among all
 * those that run the app. Pass it to `brick({ events: { schedules } })`.
 *
 * It runs either on a `cron` expression, at fixed wall-clock times in a time
 * zone, or `every` so long, counted from the end of the last successful run.
 * State lives in the app's `scheduleTable()`, so a due time runs once however
 * many processes there are, and a restart or deploy carries on where it
 * stopped. A due time counts as done only once its run succeeds: a run that
 * throws is retried with a growing delay, and one whose process died is taken
 * over by another process. A run is never started while the last one is still
 * running; due times that pass in the meantime are skipped.
 *
 * @param config - `name`, `cron` (and `timeZone`) or `every`, `run` or
 * `workflow`, and optionally `catchUp`, `maxAttempts`, `backoff`, `jitter` and
 * `enabled`.
 * @returns The schedule.
 * @throws When the name is empty or contains `:`, the cron expression or time
 * zone is invalid, or the schedule has both or neither of `cron` and `every`,
 * or of `run` and `workflow`.
 * @example
 * import { brick, defineSchedule } from "@brickkit/core";
 *
 * const backup = defineSchedule({
 *   name: "db-backup",
 *   cron: "0 *\/6 * * *",
 *   timeZone: "Europe/Berlin",
 *   run: () => backupDatabase(),
 * });
 *
 * export default brick({ services, events: { schedules: [backup] } });
 */
export function defineSchedule(config: ScheduleConfig): Schedule {
  const { name } = config;
  if (typeof name !== "string" || !name)
    throw new Error("A schedule needs a name");
  if (name.includes(":"))
    throw new Error(`Schedule name '${name}' must not contain ':'`);
  const fail = (message: string): never => {
    throw new Error(`Schedule '${name}': ${message}`);
  };
  const attempt = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (error) {
      return fail((error as Error).message);
    }
  };
  /** A duration that may also be 0: none. */
  const optionalDuration = (
    value: string | number | undefined,
    fallback: number,
  ) =>
    value === undefined
      ? fallback
      : value === 0
        ? 0
        : attempt(() => parseDuration(value));
  if ((config.cron === undefined) === (config.every === undefined))
    fail("give it a cron expression or an interval (every), not both");
  if ((config.run === undefined) === (config.workflow === undefined))
    fail("give it a run handler or a workflow, not both");
  if (config.run !== undefined && typeof config.run !== "function")
    fail("run must be a function");
  if (config.workflow !== undefined && typeof config.workflow !== "function")
    fail('workflow must be a function marked "use workflow"');
  const maxAttempts = config.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1)
    fail("maxAttempts must be a positive integer");
  if (
    config.catchUp !== undefined &&
    !["once", "skip"].includes(config.catchUp)
  )
    fail('catchUp must be "once" or "skip"');
  let when: Pick<Schedule, "cron" | "timeZone" | "every" | "spec">;
  if (config.cron !== undefined) {
    const timeZone = config.timeZone ?? "UTC";
    const cron = attempt(() => parseCron(config.cron!));
    attempt(() => checkTimeZone(timeZone));
    if (!nextCron(cron, new Date(), timeZone))
      fail(`cron expression '${config.cron}' never fires`);
    when = { cron, timeZone, spec: `cron ${cron.source} ${timeZone}` };
  } else {
    const every = attempt(() => parseDuration(config.every!));
    when = { every, spec: `every ${every}` };
  }
  return Object.freeze({
    name,
    ...when,
    catchUp: config.catchUp ?? "once",
    maxAttempts,
    backoffMs: optionalDuration(config.backoff, 60_000),
    jitterMs: optionalDuration(config.jitter, 0),
    enabled: config.enabled ?? true,
    ...(config.run ? { run: config.run } : {}),
    ...(config.workflow ? { workflow: config.workflow } : {}),
  });
}

/**
 * The first due time of `schedule` after `after`, before jitter: the next
 * cron time, or `after` plus the interval. `undefined` when the cron
 * expression fires no more.
 */
export function nextDue(schedule: Schedule, after: Date): Date | undefined {
  return schedule.cron
    ? nextCron(schedule.cron, after, schedule.timeZone)
    : new Date(after.getTime() + schedule.every!);
}
