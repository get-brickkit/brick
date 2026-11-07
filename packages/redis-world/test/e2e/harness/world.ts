import { keys } from "../../../src/keys.js";
import { WORLD } from "./paths.js";

/** The world options a test may tune (see each package's src/config.ts). */
export interface WorldTuning {
  heartbeatTtlMs?: number;
  lockDuration?: number;
  stalledInterval?: number;
  maxStalledCount?: number;
  maxAttempts?: number;
  backoffDelayMs?: number;
  backoffType?: "fixed" | "exponential";
  httpTimeoutMs?: number;
  queueConcurrency?: number;
}

/** What differs between the worlds under test: their queue's knobs and keys. */
export interface WorldUnderTest {
  /** Small lease/lock intervals so a dead worker's messages are recovered quickly. */
  fastRecovery: WorldTuning;
  /** Scenario 16c: two crashes spend the queue's own budget for one message. */
  spentBudget: { title: string; tuning: WorldTuning };
  /** Scenario 17: a budget generous enough to measure correctness under churn. */
  churnBudget: WorldTuning;
  /** A queue prefix of the env's own beyond `keyPrefix`, if the queue needs one. */
  jobPrefix(id: string): string | undefined;
  /** Every Redis key of the queue an env's workers share. */
  queueKeyPattern(keyPrefix: string, jobPrefix: string | undefined): string;
}

const worlds: Record<string, WorldUnderTest> = {
  "redis-world": {
    fastRecovery: { heartbeatTtlMs: 2000 },
    spentBudget: {
      title: "two crashes with maxAttempts 49 still reach a terminal run",
      tuning: { maxAttempts: 49 },
    },
    churnBudget: { maxAttempts: 73 },
    jobPrefix: () => undefined,
    queueKeyPattern: (keyPrefix) => keys(keyPrefix).queue.pattern,
  },
  "bullmq-world": {
    fastRecovery: { lockDuration: 2000, stalledInterval: 1000 },
    spentBudget: {
      title:
        "a run is not stranded when BullMQ gives up on its job (maxStalledCount: 1, two crashes)",
      tuning: { maxStalledCount: 1 },
    },
    churnBudget: { maxStalledCount: 25 },
    jobPrefix: (id) => `e2e_${id}_`,
    queueKeyPattern: (_keyPrefix, jobPrefix) => `bull:${jobPrefix}*`,
  },
};

export const world: WorldUnderTest = worlds[WORLD]!;
