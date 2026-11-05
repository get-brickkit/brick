import { randomBytes } from "node:crypto";
import {
  hydrateRunError,
  hydrateWorkflowReturnValue,
} from "@workflow/core/serialization";
import {
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  slotToEventId,
  type Event,
  type WorkflowRun,
} from "@workflow/world";
import { Redis } from "ioredis";
import { expect, onTestFinished } from "vitest";
import { pathToFileURL } from "node:url";
import type * as WorldModule from "../../../src/index.js";
import { DIST_ENTRY, SCRATCH_REDIS_URL } from "./paths.js";
import { RedisServer } from "./redis-server.js";
import type { WorkflowRef } from "./workflows.js";
import { WorkerProc } from "./worker.js";
import { world as worldUnderTest, type WorldTuning } from "./world.js";

// The built world under test; both worlds' createWorld take the shared config.
const { createWorld }: typeof WorldModule = await import(
  pathToFileURL(DIST_ENTRY).href
);

type RunStatus = WorkflowRun["status"];

export interface EnvOptions {
  /** Redis to use; defaults to the shared scratch Redis. */
  redisUrl?: string;
  /** Start a redis-server of this test's own (AOF on); `env.redisServer` controls it. */
  ownRedis?: boolean;
  tuning?: WorldTuning;
  concurrency?: number;
  /** Number of worker processes to start immediately. Default 0. */
  workers?: number;
}

export interface RunResult {
  status: "completed" | "failed" | "timeout";
  value?: unknown;
  errorCode?: string | null;
  message?: string;
  cause?: { name?: string; message?: string } | string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Everything one test needs: unique Redis prefixes, a set of worker processes,
 * and a test-side world pointing at the same Redis for reading the run state
 * and event log the way an operator would. Disposed automatically when the
 * test finishes (workers killed, keys under the test's prefixes deleted).
 */
export class Env {
  readonly id = randomBytes(5).toString("hex");
  readonly keyPrefix = `e2e:${this.id}:`;
  readonly jobPrefix = worldUnderTest.jobPrefix(this.id);
  readonly workers: WorkerProc[] = [];
  readonly world: ReturnType<typeof createWorld>;
  /** Direct Redis access for evidence (counters) and for chaos (deleting queue keys). */
  readonly redis: Redis;
  /** Every run this env started, for the failure dump. */
  readonly runIds: string[] = [];
  private nextWorker = 0;
  private disposed = false;

  private constructor(
    readonly opts: EnvOptions & { redisUrl: string },
    readonly redisServer?: RedisServer,
  ) {
    this.world = createWorld({
      redis: opts.redisUrl,
      keyPrefix: this.keyPrefix,
      ...(this.jobPrefix && { jobPrefix: this.jobPrefix }),
    });
    this.redis = new Redis(opts.redisUrl, { maxRetriesPerRequest: null });
    this.redis.on("error", () => {});
  }

  static async create(opts: EnvOptions = {}): Promise<Env> {
    const redisServer = opts.ownRedis ? await RedisServer.start() : undefined;
    const env = new Env(
      {
        ...opts,
        redisUrl: redisServer?.url ?? opts.redisUrl ?? SCRATCH_REDIS_URL,
      },
      redisServer,
    );
    // One hook, so the evidence is gathered while the workers and queue still
    // exist: vitest runs onTestFailed callbacks after onTestFinished ones.
    onTestFinished(async ({ task }) => {
      try {
        if (task.result?.state === "fail" || process.env.E2E_DUMP)
          await env.dumpEvidence();
      } finally {
        await env.dispose();
      }
    });
    try {
      for (let i = 0; i < (opts.workers ?? 0); i++) await env.startWorker();
    } catch (error) {
      await env.dispose();
      throw error;
    }
    return env;
  }

  get redisUrl(): string {
    return this.opts.redisUrl;
  }

  /** A Redis key for test evidence, inside the prefix that gets cleaned up. */
  counterKey(label: string): string {
    return `${this.keyPrefix}count:${label}`;
  }

  async startWorker(name = `w${this.workers.length + 1}`): Promise<WorkerProc> {
    const worker = await WorkerProc.spawn({
      name,
      redisUrl: this.opts.redisUrl,
      keyPrefix: this.keyPrefix,
      jobPrefix: this.jobPrefix,
      tuning: this.opts.tuning,
      concurrency: this.opts.concurrency,
    });
    this.workers.push(worker);
    return worker;
  }

  liveWorkers(): WorkerProc[] {
    return this.workers.filter((w) => w.alive);
  }

  /** Round-robin over the live workers. */
  private pick(): WorkerProc {
    const live = this.liveWorkers();
    const worker = live[this.nextWorker++ % live.length];
    if (!worker) throw new Error("no live worker to talk to");
    return worker;
  }

  /** Start a run through a worker's `start()` (the real SDK path). */
  async invoke(
    wf: WorkflowRef,
    args: unknown[] = [],
    via?: WorkerProc,
    options?: Record<string, unknown>,
  ): Promise<string> {
    const { runId } = await (via ?? this.pick()).fetchJson<{ runId: string }>(
      "/invoke",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...wf, args, options }),
      },
    );
    expect(runId).toMatch(/^wrun_/);
    this.runIds.push(runId);
    return runId;
  }

  async invokeMany(
    count: number,
    wf: WorkflowRef,
    argsFor: (i: number) => unknown[],
    concurrency = 20,
  ): Promise<string[]> {
    const ids = Array.from<string>({ length: count });
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, count) }, async () => {
        while (next < count) {
          const i = next++;
          ids[i] = await this.invoke(wf, argsFor(i));
        }
      }),
    );
    return ids;
  }

  async getRun(runId: string): Promise<WorkflowRun> {
    return (await this.world.runs.get(runId)) as WorkflowRun;
  }

  async status(runId: string): Promise<RunStatus> {
    return (await this.world.runs.get(runId, { resolveData: "none" })).status;
  }

  /** Poll `fn` until it returns a defined value; fail with `what` after the deadline. */
  async until<T>(
    what: string,
    fn: () => Promise<T | undefined>,
    timeoutMs = 120_000,
    intervalMs = 200,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const value = await fn();
        if (value !== undefined) return value;
        lastError = undefined;
      } catch (error) {
        lastError = error;
      }
      await sleep(intervalMs);
    }
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${what}${lastError ? `: ${String(lastError)}` : ""}`,
    );
  }

  /**
   * Wait for every run to reach `expected`. A run that ends in any other
   * terminal state fails the wait immediately, with its recorded error.
   */
  async waitForRuns(
    runIds: string[],
    expected: RunStatus = "completed",
    timeoutMs = 120_000,
  ): Promise<Map<string, WorkflowRun>> {
    const done = new Map<string, WorkflowRun>();
    const terminal: RunStatus[] = ["completed", "failed", "cancelled"];
    const deadline = Date.now() + timeoutMs;
    let pending = [...runIds];
    while (pending.length > 0) {
      const runs = await Promise.all(
        pending.map((id) =>
          this.world.runs
            .get(id, { resolveData: "none" })
            .catch(() => undefined),
        ),
      );
      const still: string[] = [];
      runs.forEach((run, i) => {
        const id = pending[i] as string;
        if (!run) return still.push(id);
        if (run.status === expected)
          return void done.set(id, run as WorkflowRun);
        if (terminal.includes(run.status)) {
          throw new Error(
            `run ${id} ended ${run.status} (wanted ${expected}); errorCode=${(run as WorkflowRun).errorCode ?? "none"}`,
          );
        }
        still.push(id);
      });
      pending = still;
      if (pending.length === 0) break;
      if (Date.now() > deadline) {
        const sample = await Promise.all(
          pending
            .slice(0, 5)
            .map(
              async (id) =>
                `${id}=${await this.status(id).catch((e) => `error:${String(e)}`)}`,
            ),
        );
        throw new Error(
          `timed out after ${timeoutMs}ms: ${pending.length}/${runIds.length} runs not ${expected}; e.g. ${sample.join(", ")}`,
        );
      }
      await sleep(250);
    }
    return done;
  }

  /** The run's whole event log, oldest first, read through the world. */
  async events(runId: string): Promise<Event[]> {
    const all: Event[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.world.events.list({
        runId,
        resolveData: "none",
        pagination: {
          sortOrder: "asc",
          limit: 1000,
          ...(cursor ? { cursor } : {}),
        },
      });
      all.push(...page.data);
      if (!page.hasMore || !page.cursor) break;
      cursor = page.cursor;
    }
    return all;
  }

  /**
   * Assert the log is dense: ids are `evnt_` + a 26-digit slot, slots run
   * 1..N in order with no gap and no duplicate. Returns the events.
   */
  async expectDenseLog(runId: string): Promise<Event[]> {
    const events = await this.events(runId);
    expect(events.length, `run ${runId} has events`).toBeGreaterThan(0);
    const slots = events.map((e) => eventIdToSlot(e.eventId));
    expect(
      events.filter((_, i) => slots[i] === null).map((e) => e.eventId),
      `run ${runId}: ids that are not slot-numbered`,
    ).toEqual([]);
    const duplicates = events
      .map((e) => e.eventId)
      .filter((id, i, a) => a.indexOf(id) !== i);
    expect(duplicates, `run ${runId}: duplicate event ids`).toEqual([]);
    expect(slots, `run ${runId}: slots are 1..N without gaps`).toEqual(
      events.map((_, i) => FIRST_EVENT_SLOT + i),
    );
    expect(
      events.map((e) => e.eventId),
      `run ${runId}: ids use the canonical evnt_ + 26 digit format`,
    ).toEqual(events.map((_, i) => slotToEventId(FIRST_EVENT_SLOT + i)));
    for (const e of events) expect(e.eventId).toMatch(/^evnt_\d{26}$/);
    return events;
  }

  static countByType(events: Event[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const e of events)
      counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
    return counts;
  }

  /** The completed run's return value, hydrated the way a client would. */
  async output<T = unknown>(runId: string): Promise<T> {
    const run = await this.getRun(runId);
    expect(run.status).toBe("completed");
    return (await hydrateWorkflowReturnValue(
      (run as { output?: unknown }).output,
      runId,
      undefined,
    )) as T;
  }

  /** The failed run's recorded error, hydrated the way a client would. */
  async runError(
    runId: string,
  ): Promise<{ errorCode?: string; error: unknown }> {
    const run = (await this.getRun(runId)) as WorkflowRun & {
      error?: unknown;
      errorCode?: string;
    };
    expect(run.status).toBe("failed");
    return {
      errorCode: run.errorCode,
      error:
        run.error === undefined
          ? undefined
          : await hydrateRunError(run.error, runId, undefined),
    };
  }

  /** The run's terminal state as the SDK's `run.returnValue` reports it. */
  async result(runId: string, timeoutMs = 60_000): Promise<RunResult> {
    return await this.pick().fetchJson<RunResult>(
      `/runs/${runId}/result?timeoutMs=${timeoutMs}`,
    );
  }

  async counts(counterKey: string): Promise<Record<string, number>> {
    const raw = await this.redis.hgetall(counterKey);
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, Number(v)]),
    );
  }

  /** All Redis keys of the queue this env's workers share. */
  queueKeyPattern(): string {
    return worldUnderTest.queueKeyPattern(this.keyPrefix, this.jobPrefix);
  }

  async scan(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        1000,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    return keys;
  }

  private async deleteKeys(pattern: string): Promise<void> {
    for (const key of await this.scan(pattern)) await this.redis.unlink(key);
  }

  /** Evidence printed when the test fails: worker logs, queue state, event logs. */
  async dumpEvidence(): Promise<void> {
    const lines: string[] = [
      `===== E2E EVIDENCE (env ${this.id}, redis ${this.redisUrl}) =====`,
    ];
    const guard = async <T>(
      label: string,
      fn: () => Promise<T>,
    ): Promise<T | undefined> => {
      try {
        return await Promise.race([
          fn(),
          sleep(10_000).then(() => {
            throw new Error("timed out");
          }),
        ]);
      } catch (error) {
        lines.push(`(${label} unavailable: ${String(error)})`);
        return undefined;
      }
    };
    const stats = await guard("queue stats", () => this.world.getQueueStats());
    if (stats) lines.push(`queue: ${JSON.stringify(stats)}`);
    const shown = this.runIds.slice(0, 3);
    const statuses = await guard("run statuses", async () => {
      const out: Record<string, number> = {};
      for (const id of this.runIds.slice(0, 500)) {
        const s = await this.status(id).catch(() => "missing");
        out[s] = (out[s] ?? 0) + 1;
      }
      return out;
    });
    if (statuses)
      lines.push(
        `run statuses (first 500 of ${this.runIds.length}): ${JSON.stringify(statuses)}`,
      );
    for (const id of shown) {
      const events = await guard(`events of ${id}`, () => this.events(id));
      if (!events) continue;
      lines.push(
        `--- run ${id}: ${events.length} events, ${JSON.stringify(Env.countByType(events))}`,
      );
      lines.push(
        ...events
          .slice(-25)
          .map(
            (e) =>
              `  ${e.eventId} ${e.eventType}${e.correlationId ? ` ${e.correlationId}` : ""}`,
          ),
      );
    }
    for (const w of this.workers) {
      lines.push(
        `--- worker ${w.name} (pid ${w.pid}, ${w.alive ? "alive" : "dead"}) last 60 log lines`,
      );
      lines.push(w.log(60));
    }
    console.log(lines.join("\n"));
  }

  /**
   * For tests where nothing is supposed to go wrong: no queue job failed, no
   * worker-level error, no SDK warning/error line in any worker's output.
   */
  expectCleanWorkerLogs(): void {
    const bad =
      /Job \S+ failed|Worker error|[Uu]nhandled|ReplayDivergence|REPLAY_DIVERGENCE|^\[workflow-sdk\]|ERR_|TypeError|ReferenceError/m;
    for (const w of this.workers) {
      const lines = w.output.join("").split("\n");
      const offending = lines.filter((l) => bad.test(l));
      expect(offending, `worker ${w.name} logged unexpected errors`).toEqual(
        [],
      );
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.all(
      this.workers.map((w) => w.kill("SIGKILL").catch(() => {})),
    );
    await Promise.race([this.world.close?.().catch(() => {}), sleep(10_000)]);
    await Promise.race([
      (async () => {
        await this.deleteKeys(`${this.keyPrefix}*`);
        await this.deleteKeys(this.queueKeyPattern());
      })().catch(() => {}),
      sleep(10_000),
    ]);
    this.redis.disconnect();
    await this.redisServer?.dispose();
  }

  /**
   * Kill a random live worker every `intervalMs` and start a replacement
   * `restartAfterMs` later, never leaving fewer than one worker alive, until
   * `stop()` is called. Returns the number of kills when stopped.
   */
  startChaosMonkey(opts: {
    intervalMs: number;
    restartAfterMs: number;
    seed?: number;
  }): {
    stop(): Promise<number>;
  } {
    let kills = 0;
    let stopped = false;
    let rng = opts.seed ?? 1;
    const random = () => {
      rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
      return rng / 2 ** 32;
    };
    const pending: Promise<unknown>[] = [];
    const loop = (async () => {
      while (!stopped) {
        await sleep(opts.intervalMs);
        if (stopped) break;
        const live = this.liveWorkers();
        if (live.length < 2) continue; // never leave the cluster with nobody alive
        const victim = live[Math.floor(random() * live.length)];
        if (!victim) continue;
        kills++;
        await victim.kill("SIGKILL");
        pending.push(
          sleep(opts.restartAfterMs)
            .then(() =>
              this.disposed ? undefined : this.startWorker(`m${kills}`),
            )
            .catch(() => {}),
        );
      }
    })();
    return {
      stop: async () => {
        stopped = true;
        await loop;
        await Promise.all(pending);
        return kills;
      },
    };
  }

  /** Where each execution of a counted step body ran: `{'<field>#<n>': workerName}`. */
  async executions(counterKey: string): Promise<Record<string, string>> {
    return await this.redis.hgetall(`${counterKey}:exec`);
  }

  /** Workflow-job deliveries each live worker's flow route has accepted. */
  async deliveriesByWorker(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const w of this.liveWorkers()) {
      out[w.name] = (
        await w.fetchJson<{ flowHits: number }>("/_ping")
      ).flowHits;
    }
    return out;
  }

  /**
   * Wait until the queue has no waiting or active job, i.e. every
   * delivery that was due has been consumed. Delayed jobs are deliberately not
   * waited for: after a duplicate delivery the SDK parks a "backstop wake"
   * (idempotency key `step_...:backstop:<epoch>`, ~860s delay) for steps it saw
   * owned by another invocation; those fire long after the run is terminal and
   * are no-ops.
   */
  async waitForQueueIdle(timeoutMs = 60_000): Promise<void> {
    await this.until(
      "queue idle (no waiting or active jobs)",
      async () => {
        const s = await this.world.getQueueStats();
        return s.waiting + s.active === 0 ? true : undefined;
      },
      timeoutMs,
    );
  }

  /** The runs whose log contains an event of `type` (e.g. 'wait_created'). */
  async hasEvent(runId: string, type: string): Promise<boolean> {
    return (await this.events(runId)).some((e) => e.eventType === type);
  }
}
