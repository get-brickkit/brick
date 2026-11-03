// Storage, streams, retention and run ids, shared with @brickkit/bullmq-world
// through the `@brickkit/redis-world/internal` export. Not a public API: it
// changes with the package versions, which ship in lockstep.
import type { Storage } from "@workflow/world";
import type { Redis } from "ioredis";
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from "./storage.js";

export function createStorage(
  redis: Redis,
  keyPrefix: string,
  maxEventsPerRun?: number,
): Storage {
  const config = { redis, keyPrefix, maxEventsPerRun };
  return {
    runs: createRunsStorage(config),
    events: createEventsStorage(config),
    hooks: createHooksStorage(config),
    steps: createStepsStorage(config),
  };
}

export {
  createReaper,
  hasRetention,
  validateRetention,
  type KeepRuns,
  type RunRetention,
} from "./reaper.js";
export { createRunId, initialMessageKey } from "./run-id.js";
export { createStreamer } from "./streamer.js";
export { createDebugLogger } from "./internal/debug.js";
export { loadOptionalEnvFile } from "./internal/env.js";
export { hasBinary, uint8ArrayReplacer } from "./util.js";
