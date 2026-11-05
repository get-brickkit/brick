import { configFromEnv, type RedisWorldConfig } from "./config.js";
import { createQueue } from "./queue.js";
import { debug } from "./util.js";
import { createRedisBackedWorld, type RedisBackedWorld } from "./world.js";

/** `config` is laid over `configFromEnv()`: an option left out comes from the
 * `WORKFLOW_REDIS_*` variables, then the defaults. */
export function createWorld(
  config: Partial<RedisWorldConfig> = {},
): RedisBackedWorld {
  return createRedisBackedWorld(config, {
    env: configFromEnv(),
    createQueue,
    label: "world-redis",
    debug,
  });
}

export type { RedisWorldConfig } from "./config.js";
export type { QueueStats } from "./queue.js";
export type { KeepRuns, RunRetention } from "./reaper.js";
