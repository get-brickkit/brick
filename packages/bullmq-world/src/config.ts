import type { KeepJobs } from "bullmq";
import type { RedisBackedWorldConfig } from "@brickkit/redis-world/internal";

/** The shared Redis world options (see `RedisBackedWorldConfig`), plus BullMQ's. */
export interface RedisWorldConfig extends RedisBackedWorldConfig {
  /**
   * Optional prefix for job queue names
   * Default: 'workflow_'
   */
  jobPrefix?: string;

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
