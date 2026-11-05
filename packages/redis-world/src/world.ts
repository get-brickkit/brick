import {
  mintedSpecVersion,
  reenqueueActiveRuns,
  type World,
} from "@workflow/world";
import { WorkflowRunNotFoundError } from "@workflow/errors";
import { Redis } from "ioredis";
import type { RedisBackedWorldConfig } from "./config.js";
import { createReaper, hasRetention, validateRetention } from "./reaper.js";
import { createRunId } from "./run-id.js";
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from "./storage.js";
import { createStreamer } from "./streamer.js";
import type {
  QueueStats,
  WorldQueue,
  WorldQueueOptions,
} from "./world-queue.js";

export type RedisBackedWorld = World & {
  start(): Promise<void>;
  getQueueStats(): Promise<QueueStats>;
  /** Run one retention sweep now; returns the runs deleted. 0 without `retention`. */
  sweepRetention(): Promise<number>;
};

/**
 * A world on Redis: storage, streams and retention are the same for every
 * queue; `createQueue` supplies the queue. `config` is laid over `env`, so an
 * option the caller leaves out still comes from the environment.
 */
export function createRedisBackedWorld<C extends RedisBackedWorldConfig>(
  config: Partial<C>,
  world: {
    env: C;
    createQueue(
      redis: Redis,
      config: C,
      options: WorldQueueOptions,
    ): WorldQueue;
    /** Log prefix for run recovery on start. */
    label: string;
    debug: (...args: unknown[]) => void;
  },
): RedisBackedWorld {
  const cfg: C = { ...world.env };
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) (cfg as Record<string, unknown>)[key] = value;
  }
  // Batches commands issued in the same event-loop tick into one write. Does
  // nothing for a single serial run, but collapses syscalls under concurrency:
  // measured 1.75x at 256 concurrent invocations, 1.15x at 32, a slight loss
  // at 1. Workers default to 10 and go higher under load, so default on.
  const autoPipelining = cfg.enableAutoPipelining ?? true;
  const redis =
    typeof cfg.redis === "string"
      ? new Redis(cfg.redis, { enableAutoPipelining: autoPipelining })
      : new Redis({ enableAutoPipelining: autoPipelining, ...cfg.redis });

  const keyPrefix = cfg.keyPrefix || "workflow:";
  validateRetention(cfg.retention);
  const reaper = hasRetention(cfg.retention)
    ? createReaper({
        redis,
        keyPrefix,
        retention: cfg.retention,
        log: world.debug,
      })
    : undefined;

  const storageConfig = {
    redis,
    keyPrefix,
    maxEventsPerRun: cfg.maxEventsPerRun,
  };
  const storage = {
    runs: createRunsStorage(storageConfig),
    events: createEventsStorage(storageConfig),
    hooks: createHooksStorage(storageConfig),
    steps: createStepsStorage(storageConfig),
  };
  const queue = world.createQueue(
    redis,
    { ...cfg, keyPrefix },
    {
      runHasStarted: async (runId) => {
        try {
          const run = await storage.runs.get(runId, { resolveData: "none" });
          return run.status !== "pending";
        } catch (error) {
          if (WorkflowRunNotFoundError.is(error)) return false;
          throw error;
        }
      },
    },
  );
  const streamer = createStreamer({ redis, keyPrefix });

  return {
    ...storage,
    ...streamer,
    ...queue,
    // Declares support for the CBOR/binary-safe queue transport so core
    // attaches runInput to workflow messages (resilient start). The queue
    // serializes payloads with a tagged-JSON transport that round-trips
    // Uint8Array values. A function, not a constant: the version this world
    // stamps follows `WORKFLOW_SEALED_LOG`.
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
        world.label,
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
