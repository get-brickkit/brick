import {
  createWorldQueue,
  type Deliver,
  type QueueBackend,
  type QueuedMessage,
  type WorldQueue,
  type WorldQueueOptions,
} from "@brickkit/redis-world/internal";
import { MessageId } from "@workflow/world";
import {
  DelayedError,
  type ConnectionOptions,
  type Job,
  Queue,
  Worker,
} from "bullmq";
import type { Redis } from "ioredis";
import { monotonicFactory } from "ulid";
import type { RedisWorldConfig } from "./config.js";
import { debug } from "./util.js";

export type { QueueStats } from "@brickkit/redis-world/internal";

/**
 * Node coerces a timer delay above this to 1 ms. BullMQ derives its lock
 * renewal timer from lockDuration, so the option is capped here.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** BullMQ job data: the message, whose id is the job id. */
type QueueJobData = Omit<QueuedMessage, "messageId">;

/**
 * BullMQ-backed Queue. Job dispatch happens via HTTP fetch to the user's
 * server; this package does not embed a workflow runtime.
 */
export function createQueue(
  redis: Redis,
  config: RedisWorldConfig,
  options: WorldQueueOptions = {},
): WorldQueue {
  const generateMessageId = monotonicFactory();

  const prefix = config.jobPrefix || "workflow_";
  // v5 has one queue kind: a step travels on the workflow queue.
  const flowQueueName = `${prefix}flows`;

  const maxAttempts = config.maxAttempts ?? 73;
  const backoffType = config.backoffType ?? "exponential";
  const backoffDelayMs = config.backoffDelayMs ?? 1000;
  const stalledInterval = config.stalledInterval ?? 30_000;
  const maxStalledCount = config.maxStalledCount ?? 10;
  const maxBackoffMs = config.maxBackoffMs ?? 30_000;
  const lockDuration = config.lockDuration;
  if (
    lockDuration !== undefined &&
    (!Number.isSafeInteger(lockDuration) ||
      lockDuration <= 0 ||
      lockDuration > MAX_TIMER_DELAY_MS)
  ) {
    throw new RangeError(
      `lockDuration must be a positive integer <= ${MAX_TIMER_DELAY_MS}, got ${lockDuration}`,
    );
  }
  const idempotencyTtlMs = config.idempotencyTtlMs;

  // Reuse the full ioredis options (tls, username, path, sentinels, ...) so
  // rediss:// and ACL setups work for the queue half too; an allowlist here
  // would silently drop fields. BullMQ manages its own key prefixes and
  // rejects ioredis keyPrefix, so strip it; maxRetriesPerRequest: null is
  // required by BullMQ for blocking connections.
  // Auto-pipelining is a storage-side setting. BullMQ workers hold blocking
  // connections (BZPOPMIN and friends), where batching a blocking call
  // together with other commands would stall them behind it, so it is dropped
  // here rather than inherited.
  const {
    keyPrefix: _unsupportedByBullmq,
    enableAutoPipelining: _storageOnly,
    ...redisOptions
  } = redis.options;
  // Cast: bullmq's ConnectionOptions type doesn't allow retryStrategy: null,
  // though ioredis accepts it fine at runtime.
  const connectionOptions = {
    ...redisOptions,
    maxRetriesPerRequest: null,
  } as ConnectionOptions;

  const bullQueue = new Queue<QueueJobData>(flowQueueName, {
    connection: connectionOptions,
  });
  let worker: Worker<QueueJobData> | undefined;

  const enqueue: QueueBackend["enqueue"] = async (
    { messageId, ...data },
    { idempotencyKey, delaySeconds },
  ) => {
    const delayMs = delaySeconds ? Math.max(0, delaySeconds * 1000) : undefined;

    // Core treats queue() success as a durability guarantee, so add()
    // failures must propagate. BullMQ does NOT throw on dedup hits; the
    // addJob script returns the existing job id, so any rejection here is a
    // real failure (connection loss, OOM, ...) and swallowing it would strand
    // the run.
    const job = await bullQueue.add(data.queueName, data, {
      jobId: messageId,
      delay: delayMs,
      attempts: maxAttempts,
      // Resolved by `backoffStrategy` on the worker, which caps the delay.
      backoff: { type: "capped", delay: backoffDelayMs },
      // BullMQ native deduplication. Without a ttl the dedup key lives
      // until the job completes or fails (BullMQ deletes it on
      // finalization), the release-on-completion semantics core relies on
      // when it re-enqueues pending steps with the same idempotencyKey on
      // every replay. A ttl is only applied when explicitly configured.
      ...(idempotencyKey && {
        deduplication: {
          id: idempotencyKey,
          ...(idempotencyTtlMs !== undefined && { ttl: idempotencyTtlMs }),
        },
      }),
      removeOnComplete: config.jobRetention?.removeOnComplete ?? {
        age: 86_400,
        count: 1000,
      },
      removeOnFail: config.jobRetention?.removeOnFail ?? { age: 7 * 86_400 },
    });

    // A deduplicated add returns the job that is already queued: report its id,
    // not the one this call minted.
    return MessageId.parse(job.id ?? messageId);
  };

  async function processJob(
    deliver: Deliver,
    job: Job<QueueJobData>,
    token?: string,
  ): Promise<void> {
    const timeoutSeconds = await deliver({
      ...job.data,
      messageId: (job.id ?? `msg_${generateMessageId()}`) as MessageId,
      // Failed deliveries, plus those a crash cut short: a reschedule does not
      // consume an attempt, but a worker that died holding the job does. The runtime
      // treats attempt 1 as a first delivery with nothing yet in the log, so a job
      // that comes back after a crash must not report 1: the step it was running
      // would be started again even though its outcome is already recorded.
      attempt: job.attemptsMade + job.stalledCounter + 1,
      deliveryCount: Math.max(1, job.attemptsStarted),
      createdAt: job.timestamp,
    });
    if (timeoutSeconds !== undefined) {
      // BullMQ requires throwing DelayedError after moveToDelayed so the worker
      // skips its completion/failure machinery for this invocation.
      await job.moveToDelayed(Date.now() + timeoutSeconds * 1000, token);
      throw new DelayedError();
    }
  }
  async function startWorkers(deliver: Deliver) {
    if (worker) return;
    worker = new Worker<QueueJobData>(
      flowQueueName,
      (job, token) => processJob(deliver, job, token),
      {
        connection: connectionOptions,
        concurrency: config.queueConcurrency || 10,
        stalledInterval,
        maxStalledCount,
        settings: {
          // The configured kind decides the curve; the cap keeps a late attempt from
          // waiting hours.
          backoffStrategy: (attemptsMade, _type, _err, job) => {
            const base = job?.opts.backoff
              ? ((job.opts.backoff as { delay?: number }).delay ??
                backoffDelayMs)
              : backoffDelayMs;
            const delay =
              backoffType === "fixed"
                ? base
                : base * 2 ** Math.max(0, attemptsMade - 1);
            return Math.min(delay, maxBackoffMs);
          },
        },
        ...(lockDuration !== undefined && { lockDuration }),
        // Low drainDelay reduces idle pickup latency.
        drainDelay: 300,
      },
    );

    worker.on("failed", (job, err) => {
      console.error(`Job ${job?.id} failed:`, err);
      // BullMQ retires a job that stalled more often than `maxStalledCount`. Crashes
      // are the world's failure, not the message's, and a retired job leaves its run
      // `running` with nothing in the queue to advance it. Retry the same job: its id
      // is the message id the runtime ties step ownership to, and the attempt header
      // counts the stalls, so the runtime's own delivery ceiling still ends a crash
      // loop (it fails the run on delivery 49).
      if (job && /stalled more than allowable limit/.test(err?.message ?? "")) {
        job.retry("failed").catch((retryError) => {
          console.error(
            `Could not retry job ${job.id} after it stalled too often:`,
            retryError,
          );
        });
      }
    });
    worker.on("error", (err) => {
      console.error("Worker error:", err);
    });

    await worker.waitUntilReady();
  }

  return createWorldQueue(
    {
      enqueue,
      async getQueueStats() {
        const counts = await bullQueue.getJobCounts(
          "waiting",
          "active",
          "completed",
          "failed",
          "delayed",
        );
        return {
          waiting: counts.waiting,
          active: counts.active,
          completed: counts.completed,
          failed: counts.failed,
          delayed: counts.delayed,
        };
      },
      start: startWorkers,
      async close() {
        await worker?.close();
        worker = undefined;
        await bullQueue.close();
      },
    },
    config,
    { ...options, debug },
  );
}
