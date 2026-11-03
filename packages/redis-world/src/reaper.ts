import type { Redis } from "ioredis";
import { debug } from "./util.js";

/** How long finished runs are kept, using `age` and `count` limits. */
export interface KeepRuns {
  /** Delete runs that finished more than this many seconds ago. */
  age?: number;
  /** Keep at most this many of the newest runs; delete the rest. */
  count?: number;
}

/**
 * Retention for run data (the run, its event log, steps, hooks, and streams),
 * per terminal status. A status without a policy is kept forever.
 */
export interface RunRetention {
  completed?: KeepRuns;
  failed?: KeepRuns;
  cancelled?: KeepRuns;
  /** How often each worker looks for expired runs (ms). Default: 60000 */
  sweepIntervalMs?: number;
  /** Runs deleted per status per sweep. Default: 200 */
  batchSize?: number;
}

const TERMINAL = ["completed", "failed", "cancelled"] as const;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 200;
const UNLINK_CHUNK = 500;

export interface Reaper {
  start(): void;
  stop(): Promise<void>;
  /** One pass over every status; returns the number of runs deleted. */
  sweep(): Promise<number>;
}

export function validateRetention(retention: RunRetention | undefined): void {
  if (!retention) return;
  for (const status of TERMINAL) {
    const keep = retention[status];
    if (!keep) continue;
    for (const field of ["age", "count"] as const) {
      const value = keep[field];
      if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
        throw new TypeError(
          `retention.${status}.${field} must be a non-negative integer, received ${String(value)}`,
        );
      }
    }
  }
  for (const field of ["sweepIntervalMs", "batchSize"] as const) {
    const value = retention[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new TypeError(
        `retention.${field} must be a positive integer, received ${String(value)}`,
      );
    }
  }
}

export function hasRetention(
  retention: RunRetention | undefined,
): retention is RunRetention {
  return (
    !!retention && TERMINAL.some((status) => retention[status] !== undefined)
  );
}

/**
 * Deletes finished runs once they pass their retention. Safe to run on every
 * worker: one lock per interval picks a single sweeper, and deleting a run is
 * idempotent anyway. A run's own key and index entries go last, in one
 * transaction, so a crash part-way leaves the run listed and the next sweep
 * finishes the job.
 */
export function createReaper(options: {
  redis: Redis;
  keyPrefix: string;
  retention: RunRetention;
  /** Logs sweep failures; each world passes its own debug namespace. */
  log?: (...args: unknown[]) => void;
}): Reaper {
  const { redis, keyPrefix, retention, log = debug } = options;
  const intervalMs = retention.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const batchSize = retention.batchSize ?? DEFAULT_BATCH_SIZE;
  const lockKey = `${keyPrefix}reaper:lock`;

  const byStatusKey = (status: string) =>
    `${keyPrefix}runs:by_status:${status}`;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> = Promise.resolve();

  /** Runs past retention, oldest first: too old, or beyond the newest `count`. */
  async function expired(status: (typeof TERMINAL)[number]): Promise<string[]> {
    const keep = retention[status];
    if (!keep) return [];
    const ids = new Set<string>();
    if (keep.age !== undefined) {
      const cutoff = Date.now() - keep.age * 1000;
      for (const id of await redis.zrangebyscore(
        byStatusKey(status),
        "-inf",
        cutoff,
        "LIMIT",
        0,
        batchSize,
      )) {
        ids.add(id);
      }
    }
    if (keep.count !== undefined) {
      // Everything below the newest `count`, oldest first.
      const stop = -(keep.count + 1);
      for (const id of await redis.zrange(
        byStatusKey(status),
        "0",
        String(stop),
      )) {
        if (ids.size >= batchSize) break;
        ids.add(id);
      }
    }
    return [...ids].slice(0, batchSize);
  }

  async function unlink(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += UNLINK_CHUNK) {
      await redis.unlink(...keys.slice(i, i + UNLINK_CHUNK));
    }
  }

  async function scan(pattern: string): Promise<string[]> {
    const found: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        1000,
      );
      cursor = next;
      found.push(...batch);
    } while (cursor !== "0");
    return found;
  }

  /** Delete one run if it is still finished. Returns whether it was deleted. */
  async function deleteRun(runId: string, listedAs: string): Promise<boolean> {
    const metaKey = `${keyPrefix}run:meta:${runId}`;
    const meta = await redis.get(metaKey);
    const status = meta?.split("|")[0];
    if (!status || !(TERMINAL as readonly string[]).includes(status)) {
      // Gone: drop the stale index entry. Moved on to a live status: leave it alone.
      if (!meta) await redis.zrem(byStatusKey(listedAs), runId);
      return false;
    }

    const runKey = `${keyPrefix}run:${runId}`;
    const runJson = await redis.get(runKey);
    const workflowName = runJson
      ? (JSON.parse(runJson) as { workflowName?: string }).workflowName
      : undefined;

    const eventsKey = `${keyPrefix}events:data:${runId}`;
    const correlationIds = new Set<string>();
    let hasResume = false;
    for (const raw of await redis.hvals(eventsKey)) {
      try {
        const event = JSON.parse(raw) as {
          correlationId?: string;
          eventType?: string;
        };
        if (event.correlationId) correlationIds.add(event.correlationId);
        if (event.eventType === "hook_received") hasResume = true;
      } catch {
        // An unreadable event still goes with the log key.
      }
    }

    const stepIds = await redis.zrange(
      `${keyPrefix}steps:by_run:${runId}`,
      "0",
      "-1",
    );
    const hookIds = await redis.zrange(
      `${keyPrefix}hooks:by_run:${runId}`,
      "0",
      "-1",
    );
    const streamNames = await redis.smembers(
      `${keyPrefix}streams:by_run:${runId}`,
    );

    const keys = [
      eventsKey,
      `${keyPrefix}run:attrs:${runId}`,
      `${keyPrefix}steps:by_run:${runId}`,
      `${keyPrefix}hooks:by_run:${runId}`,
      `${keyPrefix}hooks:tokens:${runId}`,
      `${keyPrefix}streams:by_run:${runId}`,
      ...[...correlationIds].map(
        (id) => `${keyPrefix}events:by_correlation:${runId}:${id}`,
      ),
      ...stepIds.flatMap((id) => [
        `${keyPrefix}step:${runId}:${id}`,
        `${keyPrefix}step:status:${runId}:${id}`,
      ]),
      ...hookIds.map((id) => `${keyPrefix}hook:${id}`),
      ...streamNames.map((name) => `${keyPrefix}stream:${runId}:${name}`),
    ];
    // Resume claims are not indexed; only a run that received a hook payload can have one.
    if (hasResume)
      keys.push(...(await scan(`${keyPrefix}events:resume:${runId}:*`)));
    await unlink(keys);

    const tx = redis
      .multi()
      .zrem(`${keyPrefix}runs:index`, runId)
      .zrem(byStatusKey(status), runId)
      .unlink(metaKey, runKey);
    if (workflowName)
      tx.zrem(`${keyPrefix}runs:by_name:${workflowName}`, runId);
    await tx.exec();
    return true;
  }

  async function sweep(): Promise<number> {
    // One sweeper per interval; the lock simply expires.
    const locked = await redis.set(
      lockKey,
      "1",
      "PX",
      Math.max(1000, Math.floor(intervalMs / 2)),
      "NX",
    );
    if (locked !== "OK") return 0;
    let deleted = 0;
    for (const status of TERMINAL) {
      for (const runId of await expired(status)) {
        try {
          if (await deleteRun(runId, status)) deleted++;
        } catch (err) {
          log("reaper failed to delete run", runId, err);
        }
      }
    }
    return deleted;
  }

  return {
    sweep,
    start() {
      if (timer) return;
      const tick = () => {
        running = sweep().catch((err) => log("reaper sweep failed", err));
      };
      timer = setInterval(tick, intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await running;
    },
  };
}
