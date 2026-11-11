import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { isSqliteDatabase } from "../events/transaction";
import { nextDue, type Schedule, type ScheduleRun } from "./schedule";
import type { ScheduleRow, ScheduleRunRecord, ScheduleTable } from "./table";

/** A due time this late, on its first try, counts as missed for `catchUp: "skip"`. */
const MISSED_AFTER_MS = 60_000;
/** Runs kept per schedule. */
const KEEP_RUNS = 20;
const ABANDONED = "The process running it stopped before it finished";

/** A schedule as `schedules.list()` reports it. */
export interface ScheduleState {
  name: string;
  kind: "handler" | "workflow";
  cron?: string;
  timeZone?: string;
  /** The interval, in milliseconds. */
  every?: number;
  enabled: boolean;
  /** When it is next due (a retry included), as an ISO timestamp; `null` before a process first started the schedules. */
  nextRunAt: string | null;
  /** Whether a process is running it now. */
  running: boolean;
  /** Tries of the current due time so far. */
  attempts: number;
  lastSuccessAt: string | null;
  /** The last runs, newest first. */
  runs: ScheduleRunRecord[];
}

export interface SchedulerOptions {
  /** Look for due schedules on a timer. */
  timer: boolean;
  intervalMs: number;
  /** How long a run may go without a heartbeat before another process takes it over. */
  claimTimeoutMs: number;
}

/**
 * Runs an app's schedules from one schedule table, shared by every process
 * that runs the app.
 *
 * Each schedule has one row. A process claims a due row with a conditional
 * update (due, and not held by a live claim), so one process wins each due
 * time, on Postgres and SQLite alike. While it runs, the process renews its
 * claim; a process that dies stops renewing, and after `claimTimeoutMs`
 * another process takes the due time over. On Postgres claims are timed by
 * the database's clock, so hosts whose clocks disagree still agree on them. Only success (or giving up after
 * `maxAttempts`) moves the row to the next due time.
 */
export class Scheduler {
  private readonly byName: Map<string, Schedule>;
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  private tickQueue?: Promise<number>;
  private synced?: Promise<void>;
  private readonly postgres: boolean;

  constructor(
    private readonly db: any,
    private readonly table: ScheduleTable,
    schedules: readonly Schedule[],
    private readonly runner: (
      schedule: Schedule,
      run: ScheduleRun,
    ) => Promise<void>,
    private readonly options: SchedulerOptions,
  ) {
    this.byName = new Map(schedules.map((s) => [s.name, s]));
    this.postgres = !isSqliteDatabase(db);
  }

  start(): void {
    if (this.timer || !this.options.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  /** Stop the timer and wait for the runs in progress. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.tickQueue;
    await Promise.allSettled(this.inFlight.values());
  }

  /**
   * Run what is due now and wait for it. Retries that are not due yet are not
   * waited for. For tests and for workers driven by hand.
   *
   * @returns How many runs it started.
   */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const started = await this.tick();
      await Promise.allSettled(this.inFlight.values());
      if (started === 0) return total;
      total += started;
    }
  }

  /** Every schedule with its state. */
  async list(now = new Date()): Promise<ScheduleState[]> {
    const t = this.table as any;
    const rows: ScheduleRow[] = await this.db.select().from(t);
    const byName = new Map(rows.map((row) => [row.name, row]));
    return [...this.byName.values()].map((schedule) => {
      const row = byName.get(schedule.name);
      return {
        name: schedule.name,
        kind: schedule.workflow ? "workflow" : "handler",
        ...(schedule.cron
          ? { cron: schedule.cron.source, timeZone: schedule.timeZone }
          : { every: schedule.every }),
        enabled: schedule.enabled,
        nextRunAt: row ? row.nextAt.toISOString() : null,
        running: Boolean(row?.runId && row.leaseUntil && row.leaseUntil > now),
        attempts: row?.runId ? row.attempts : (row?.attempts ?? 0),
        lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
        runs: row?.runs ?? [],
      };
    });
  }

  /**
   * Make a schedule due now, as a manual run. Whichever process runs the
   * schedules picks it up; this one at once if it does.
   *
   * @returns `false` when the schedule is running now.
   * @throws When no schedule has that name.
   */
  async trigger(name: string): Promise<boolean> {
    if (!this.byName.has(name)) throw new Error(`No schedule named '${name}'`);
    await this.sync();
    const now = new Date();
    const set = await this.reset(name, now, {
      slot: now,
      nextAt: now,
      attempts: 0,
      trigger: "manual",
    });
    if (!set) return false;
    if (this.timer) setTimeout(() => void this.tick(), 0).unref?.();
    return true;
  }

  /**
   * Set a schedule's row afresh, unless a live claim holds it. A claim whose
   * process died is recorded first, as a failed run of its own due time.
   *
   * @returns Whether the row was set.
   */
  private async reset(
    name: string,
    now: Date,
    values: Partial<ScheduleRow>,
  ): Promise<boolean> {
    const t = this.table as any;
    const [row]: ScheduleRow[] = await this.db
      .select()
      .from(t)
      .where(eq(t.name, name));
    if (!row) return false;
    const updated = await this.db
      .update(t)
      .set({
        ...values,
        runId: null,
        startedAt: null,
        leaseUntil: null,
        // Only the holder of a claim writes the runs, and this one is dead.
        ...(row.runId
          ? {
              runs: [
                this.record(row, row.startedAt!, "failed", ABANDONED),
                ...row.runs,
              ].slice(0, KEEP_RUNS),
            }
          : {}),
      })
      // Unless its claim is live, or another process claimed it meanwhile.
      .where(and(eq(t.name, name), this.unchanged(row.runId), this.free(now)))
      .returning({ name: t.name });
    return updated.length > 0;
  }

  /** Not held by a live claim. */
  private free(now: Date) {
    const t = this.table as any;
    return or(isNull(t.runId), lt(t.leaseUntil, this.clock(now)));
  }

  /** Still held by the claim `runId`, or by none when it is null. */
  private unchanged(runId: string | null) {
    const t = this.table as any;
    return runId ? eq(t.runId, runId) : isNull(t.runId);
  }

  /** Now, for claims: the database's clock on Postgres, this host's on SQLite (one host). */
  private clock(now: Date) {
    return this.postgres ? sql`now()` : now;
  }

  /** When a claim made or renewed now runs out. */
  private leaseFrom(now: Date) {
    const ms = this.options.claimTimeoutMs;
    return this.postgres
      ? sql`now() + make_interval(secs => ${ms / 1000})`
      : new Date(now.getTime() + ms);
  }

  /** A row due at the schedule's first time from now: an interval at once, a cron schedule at its next time. */
  private fresh(schedule: Schedule, now: Date) {
    const slot = schedule.cron ? nextDue(schedule, now) : now;
    return (
      slot && {
        spec: schedule.spec,
        slot,
        nextAt: this.jittered(schedule, slot),
        attempts: 0,
        trigger: "schedule" as const,
      }
    );
  }

  /**
   * Give each schedule its row, and work its next due time out again when what
   * decides it changed (an edited cron expression). Once per scheduler.
   */
  private sync(): Promise<void> {
    this.synced ??= this.writeRows().catch((error) => {
      this.synced = undefined;
      throw error;
    });
    return this.synced;
  }

  private async writeRows(): Promise<void> {
    const t = this.table as any;
    const now = new Date();
    for (const schedule of this.byName.values()) {
      const fresh = this.fresh(schedule, now);
      if (!fresh) continue;
      await this.db
        .insert(t)
        .values({ name: schedule.name, runs: [], ...fresh })
        .onConflictDoNothing();
      const [row]: Pick<ScheduleRow, "spec">[] = await this.db
        .select({ spec: t.spec })
        .from(t)
        .where(eq(t.name, schedule.name));
      if (row && row.spec !== schedule.spec)
        await this.reset(schedule.name, now, fresh);
    }
  }

  private tick(): Promise<number> {
    this.tickQueue = (this.tickQueue ?? Promise.resolve(0)).then(
      () => this.claimAndRun(),
      () => this.claimAndRun(),
    );
    return this.tickQueue;
  }

  private async claimAndRun(): Promise<number> {
    try {
      await this.sync();
      const t = this.table as any;
      const now = new Date();
      const due: Pick<
        ScheduleRow,
        "name" | "spec" | "trigger" | "runId" | "startedAt"
      >[] = await this.db
        .select({
          name: t.name,
          spec: t.spec,
          trigger: t.trigger,
          runId: t.runId,
          startedAt: t.startedAt,
        })
        .from(t)
        .where(
          and(
            inArray(t.name, [...this.byName.keys()]),
            lte(t.nextAt, now),
            this.free(now),
          ),
        );
      let started = 0;
      for (const candidate of due) {
        const schedule = this.byName.get(candidate.name)!;
        if (this.inFlight.has(schedule.name)) continue;
        if (!schedule.enabled && candidate.trigger !== "manual") continue;
        // Another version of the app wrote it (a rolling deploy): this
        // process's definition decides when it is due.
        if (candidate.spec !== schedule.spec) {
          const fresh = this.fresh(schedule, now);
          if (fresh) await this.reset(schedule.name, now, fresh);
          continue;
        }
        const runId = crypto.randomUUID();
        const [row]: ScheduleRow[] = await this.db
          .update(t)
          .set({
            runId,
            startedAt: now,
            leaseUntil: this.leaseFrom(now),
            // Counted at the claim, so a try whose process dies still counts.
            attempts: sql`${t.attempts} + 1`,
          })
          .where(
            and(
              eq(t.name, schedule.name),
              lte(t.nextAt, now),
              this.free(now),
              // As read: the abandoned try recorded below is that claim's.
              this.unchanged(candidate.runId),
            ),
          )
          .returning();
        if (!row) continue; // Another process won it, or changed it.
        started++;
        const run = this.execute(
          schedule,
          row,
          candidate.runId === null ? undefined : candidate.startedAt!,
        )
          .catch((error) => this.logError(error))
          .finally(() => this.inFlight.delete(schedule.name));
        this.inFlight.set(schedule.name, run);
      }
      return started;
    } catch (error) {
      this.logError(error);
      return 0;
    }
  }

  private async execute(
    schedule: Schedule,
    row: ScheduleRow,
    /** When the last try started, when its process stopped before it finished. */
    abandonedAt: Date | undefined,
  ): Promise<void> {
    const runs = [...row.runs];
    const startedAt = row.startedAt!;
    const attempt = row.attempts;
    if (abandonedAt)
      runs.unshift(
        this.record(
          { ...row, attempts: attempt - 1 },
          abandonedAt,
          "failed",
          ABANDONED,
        ),
      );
    const now = () => new Date();
    if (
      attempt === 1 &&
      row.trigger === "schedule" &&
      // An overdue interval has no later time to wait for.
      schedule.cron &&
      schedule.catchUp === "skip" &&
      startedAt.getTime() - row.nextAt.getTime() > MISSED_AFTER_MS
    ) {
      runs.unshift(this.record(row, startedAt, "skipped"));
      return this.advance(schedule, row, runs, now(), false);
    }
    if (attempt > schedule.maxAttempts)
      return this.advance(schedule, row, runs, now(), false);
    const heartbeat = setInterval(
      () => void this.renew(row).catch((error) => this.logError(error)),
      Math.max(10, Math.floor(this.options.claimTimeoutMs / 3)),
    );
    heartbeat.unref?.();
    const slot = row.slot.toISOString();
    try {
      await this.runner(schedule, {
        schedule: schedule.name,
        slot,
        trigger: row.trigger,
        attempt,
        runKey: `${schedule.name}:${slot}`,
      });
    } catch (error) {
      clearInterval(heartbeat);
      const message = error instanceof Error ? error.message : String(error);
      runs.unshift(this.record(row, startedAt, "failed", message));
      return this.retry(schedule, row, runs, now());
    }
    clearInterval(heartbeat);
    runs.unshift(this.record(row, startedAt, "succeeded"));
    return this.advance(schedule, row, runs, now(), true);
  }

  private async renew(row: ScheduleRow): Promise<void> {
    const t = this.table as any;
    const updated = await this.db
      .update(t)
      .set({
        leaseUntil: this.leaseFrom(new Date()),
      })
      .where(and(eq(t.name, row.name), eq(t.runId, row.runId)))
      .returning({ name: t.name });
    if (!updated.length)
      console.warn(
        `[Brick-TS schedules] Schedule '${row.name}' lost its claim while running; another process may run it too.`,
      );
  }

  /** After a failure: try the same due time again later, unless the tries ran out or the next due time comes first. */
  private async retry(
    schedule: Schedule,
    row: ScheduleRow,
    runs: ScheduleRunRecord[],
    now: Date,
  ): Promise<void> {
    const retryAt = new Date(
      now.getTime() + schedule.backoffMs * 2 ** (row.attempts - 1),
    );
    const next = schedule.cron ? nextDue(schedule, now) : undefined;
    if (row.attempts >= schedule.maxAttempts || (next && next <= retryAt))
      return this.advance(schedule, row, runs, now, false);
    await this.release(row, { nextAt: retryAt, runs });
  }

  /** Done with this due time: on to the next one. */
  private async advance(
    schedule: Schedule,
    row: ScheduleRow,
    runs: ScheduleRunRecord[],
    now: Date,
    succeeded: boolean,
  ): Promise<void> {
    // Due times that passed during the run are skipped: runs never overlap.
    const slot = nextDue(schedule, now);
    await this.release(row, {
      spec: schedule.spec,
      ...(slot
        ? { slot, nextAt: this.jittered(schedule, slot) }
        : // A cron expression that fires no more: park it far ahead.
          { nextAt: new Date(8.64e15) }),
      attempts: 0,
      trigger: "schedule",
      runs,
      ...(succeeded ? { lastSuccessAt: now } : {}),
    });
  }

  private async release(
    row: ScheduleRow,
    values: Partial<ScheduleRow>,
  ): Promise<void> {
    const t = this.table as any;
    const updated = await this.db
      .update(t)
      .set({
        ...values,
        runs: values.runs?.slice(0, KEEP_RUNS),
        runId: null,
        leaseUntil: null,
      })
      .where(and(eq(t.name, row.name), eq(t.runId, row.runId)))
      .returning({ name: t.name });
    if (!updated.length)
      console.warn(
        `[Brick-TS schedules] Schedule '${row.name}': another process took the run over, so this outcome is not recorded.`,
      );
  }

  private record(
    row: ScheduleRow,
    startedAt: Date,
    outcome: ScheduleRunRecord["outcome"],
    error?: string,
  ): ScheduleRunRecord {
    return {
      slot: row.slot.toISOString(),
      trigger: row.trigger,
      attempt: row.attempts,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      outcome,
      ...(error !== undefined ? { error } : {}),
    };
  }

  private jittered(schedule: Schedule, slot: Date): Date {
    return schedule.jitterMs
      ? new Date(slot.getTime() + Math.floor(Math.random() * schedule.jitterMs))
      : slot;
  }

  private logError(error: unknown): void {
    console.error("[Brick-TS schedules]", error);
  }
}
