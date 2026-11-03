import type { KeepJobs } from "bullmq";
import type { RedisOptions } from "ioredis";
import type { RunRetention } from "@brickkit/redis-world/internal";

export interface RedisWorldConfig {
  /**
   * Redis connection URL or connection options
   * Examples:
   * - 'redis://localhost:6379'
   * - 'rediss://username:password@host:6380/0'
   * - { host: 'localhost', port: 6379 }
   */
  redis: string | RedisOptions;

  /**
   * Optional prefix for job queue names
   * Default: 'workflow_'
   */
  jobPrefix?: string;

  /**
   * Number of concurrent workers processing jobs
   * Default: 10
   */
  queueConcurrency?: number;

  /**
   * Optional key prefix for all Redis keys
   * Useful for multi-tenancy or namespace isolation
   * Default: 'workflow:'
   */
  keyPrefix?: string;

  /**
   * Maximum delivery attempts before a job is marked as permanently failed.
   *
   * Keep it above the runtime's own delivery ceiling (48). The runtime records a
   * run as failed (`MAX_DELIVERIES_EXCEEDED`) on delivery 49; a job retired
   * earlier strands its run in `running`, with nothing to redeliver it until a
   * process calls `start()` again.
   * Default: 73
   */
  maxAttempts?: number;

  /**
   * Backoff strategy for retries: 'fixed' replays at the same interval,
   * 'exponential' doubles the delay on each attempt.
   * Default: 'exponential'
   */
  backoffType?: "fixed" | "exponential";

  /**
   * Base delay for backoff (ms). For exponential backoff this is multiplied
   * by 2^(attempt - 1), up to `maxBackoffMs`.
   * Default: 1000
   */
  backoffDelayMs?: number;

  /**
   * The longest a retry is delayed (ms). With the default number of attempts an
   * uncapped exponential backoff would wait hours between late attempts.
   * Default: 30000 (30s)
   */
  maxBackoffMs?: number;

  /**
   * How often workers check for stalled jobs (ms). A job is stalled when its
   * lock has expired (see `lockDuration`); the check returns it to the wait
   * list for another worker.
   * Default: 30000 (30s)
   */
  stalledInterval?: number;

  /**
   * How many times a job may be recovered from a stall before it is marked as
   * failed instead. A failed job strands its run (see `maxAttempts`), so this is
   * generous.
   * Default: 10
   */
  maxStalledCount?: number;

  /**
   * How long a worker's job lock lives without renewal (ms). BullMQ renews it
   * from the worker's event loop once it is between a quarter and half of this
   * old, so a step blocking that loop for longer than half of it can lose the
   * lock and be re-delivered while it still runs. Set it to at least 2x the
   * longest event-loop block. Maximum 2_147_483_647 (Node's timer limit).
   * Default: BullMQ's own, 30000 (30s)
   */
  lockDuration?: number;

  /**
   * Base URL the BullMQ worker uses to dispatch jobs back to the user's HTTP
   * server, which must serve `world.createQueueHandler(...)` at
   * `/.well-known/workflow/v1/flow` (steps travel on the same route). A route
   * registered with `world.registerRoute`, or an in-process handler registered
   * with `world.registerHandler`, takes precedence.
   * Default: process.env.WORKFLOW_BASE_URL || `http://localhost:${process.env.PORT ?? 3000}`
   */
  baseUrl?: string;

  /**
   * Per-job HTTP request timeout (ms). Long-running workflow steps may need a
   * higher value.
   * Default: 300_000 (5 minutes)
   */
  httpTimeoutMs?: number;

  /**
   * Optional TTL (ms) for BullMQ native deduplication when `idempotencyKey`
   * is supplied to `queue()`. By default no TTL is applied: the dedup key
   * lives until the job completes or fails, so duplicate enqueues are dropped
   * for the entire lifetime of the pending/delayed job (the semantics the
   * workflow runtime relies on when re-enqueuing pending steps on replay).
   * Only set this if you need the dedup guard to expire on wall-clock time;
   * it must be much larger than the longest expected queue delay/backlog,
   * otherwise duplicate step executions become possible.
   * Default: undefined (dedup key released on job completion)
   */
  idempotencyTtlMs?: number;

  /** Maximum events a run may accumulate, reported as `EventResult.maxEvents`.
   * Default: `WORKFLOW_MAX_EVENTS` || 25_000 */
  maxEventsPerRun?: number;

  /**
   * Batch commands issued in the same event-loop tick into one write. A win
   * once several runs are in flight (~1.75x at 256 concurrent) and a marginal
   * loss for a single serial caller.
   * Default: true
   */
  enableAutoPipelining?: boolean;

  /**
   * How long finished runs are kept, per terminal status, in the shape of
   * BullMQ's `removeOnComplete`: `age` in seconds, `count` of newest runs to
   * keep. A reaper on each worker deletes the run, its event log, steps, hooks
   * and streams once it passes. A status without a policy is kept forever.
   * Default: undefined (nothing expires)
   *
   * @example
   * retention: {
   *   completed: { age: 24 * 60 * 60, count: 1000 },
   *   failed: { age: 7 * 24 * 60 * 60 },
   * }
   */
  retention?: RunRetention;

  /**
   * How long BullMQ keeps the queue's own finished jobs (delivery records, not
   * run data). Each is BullMQ's `KeepJobs`: `age` in seconds, `count` to keep.
   * Default: complete `{ age: 86400, count: 1000 }`, fail `{ age: 604800 }`
   */
  jobRetention?: {
    removeOnComplete?: KeepJobs;
    removeOnFail?: KeepJobs;
  };
}
