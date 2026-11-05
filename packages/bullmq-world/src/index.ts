import {
  configFromEnv,
  createRedisBackedWorld,
  type RedisBackedWorld,
} from "@brickkit/redis-world/internal";
import type { RedisWorldConfig } from "./config.js";
import { createQueue } from "./queue.js";
import { debug } from "./util.js";

/** `config` is laid over `configFromEnv()`: an option left out comes from the
 * `WORKFLOW_REDIS_*` variables, then the defaults. */
export function createWorld(
  config: Partial<RedisWorldConfig> = {},
): RedisBackedWorld {
  return createRedisBackedWorld(config, {
    env: {
      ...configFromEnv(),
      jobPrefix: process.env.WORKFLOW_REDIS_JOB_PREFIX,
    },
    createQueue,
    label: "world-redis-bullmq",
    debug,
  });
}

export type { RedisWorldConfig } from "./config.js";
export type { QueueStats } from "./queue.js";
export type { KeepRuns, RunRetention } from "@brickkit/redis-world/internal";
