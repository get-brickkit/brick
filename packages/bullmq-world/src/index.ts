import {
  mintedSpecVersion,
  reenqueueActiveRuns,
  type World,
} from "@workflow/world";
import { WorkflowRunNotFoundError } from "@workflow/errors";
import {
  createReaper,
  createRunId,
  createStorage,
  createStreamer,
  hasRetention,
  validateRetention,
} from "@brickkit/redis-world/internal";
import { Redis } from "ioredis";
import type { RedisWorldConfig } from "./config.js";
import { createQueue, type QueueStats } from "./queue.js";
import { debug } from "./util.js";

export function createWorld(
  config: RedisWorldConfig = {
    redis:
      process.env.WORKFLOW_REDIS_URL ||
      process.env.REDIS_URL ||
      "redis://localhost:6379",
    jobPrefix: process.env.WORKFLOW_REDIS_JOB_PREFIX,
    queueConcurrency:
      Number.parseInt(
        process.env.WORKFLOW_REDIS_WORKER_CONCURRENCY || "10",
        10,
      ) || 10,
    keyPrefix: process.env.WORKFLOW_REDIS_KEY_PREFIX || "workflow:",
  },
): World & {
  start(): Promise<void>;
  getQueueStats(): Promise<QueueStats>;
  /** Run one retention sweep now; returns the runs deleted. 0 without `retention`. */
  sweepRetention(): Promise<number>;
} {
  // Batches commands issued in the same event-loop tick into one write. Does
  // nothing for a single serial run, but collapses syscalls under concurrency:
  // measured 1.75x at 256 concurrent invocations, 1.15x at 32, a slight loss
  // at 1. Workers default to 10 and go higher under load, so default on.
  const autoPipelining = config.enableAutoPipelining ?? true;
  const redis =
    typeof config.redis === "string"
      ? new Redis(config.redis, { enableAutoPipelining: autoPipelining })
      : new Redis({ enableAutoPipelining: autoPipelining, ...config.redis });

  const keyPrefix = config.keyPrefix || "workflow:";
  validateRetention(config.retention);
  const reaper = hasRetention(config.retention)
    ? createReaper({
        redis,
        keyPrefix,
        retention: config.retention,
        log: debug,
      })
    : undefined;

  const storage = createStorage(redis, keyPrefix, config.maxEventsPerRun);
  const queue = createQueue(redis, config, {
    runHasStarted: async (runId) => {
      try {
        const run = await storage.runs.get(runId, { resolveData: "none" });
        return run.status !== "pending";
      } catch (error) {
        if (WorkflowRunNotFoundError.is(error)) return false;
        throw error;
      }
    },
  });
  const streamer = createStreamer({ redis, keyPrefix });

  return {
    ...storage,
    ...streamer,
    ...queue,
    // Declares support for the CBOR/binary-safe queue transport so core
    // attaches runInput to workflow messages (resilient start). The queue
    // serializes payloads with a tagged-JSON transport that round-trips
    // Uint8Array values through BullMQ job data. A function, not a constant:
    // the version this world stamps follows `WORKFLOW_SEALED_LOG`.
    specVersion: mintedSpecVersion(),
    createRunId,
    async start() {
      await queue.start();
      reaper?.start();
      // Put runs that were in flight back on the queue, in case the queue lost
      // them (a Redis restart without persistence, a failover). Replay is
      // idempotent, so a duplicate is harmless; the dedup key makes several
      // workers restarting together enqueue one message per run, not one each.
      await reenqueueActiveRuns(
        storage.runs,
        (queueName, message, opts) =>
          queue.queue(queueName, message, {
            ...opts,
            idempotencyKey: `recover:${(message as { runId: string }).runId}`,
          }),
        "world-redis-bullmq",
      );
    },
    async sweepRetention() {
      return reaper ? reaper.sweep() : 0;
    },
    async close() {
      await reaper?.stop();
      await queue.close();
      await streamer.close();
      await redis.quit();
    },
  };
}

// Re-export config and queue types for consumers
export type { RedisWorldConfig } from "./config.js";
export type { QueueStats } from "./queue.js";
export type { KeepRuns, RunRetention } from "@brickkit/redis-world/internal";
