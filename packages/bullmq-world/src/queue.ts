import {
  MessageId,
  parseQueueName,
  parseQueueRoute,
  type Queue as QueueInterface,
  type QueuePrefix,
  type ValidQueueName,
} from "@workflow/world";
import {
  createAppRouteUrl,
  createWorkflowBaseUrl,
  createWorkflowUrl,
} from "@workflow/utils";
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
import { initialMessageKey } from "@brickkit/redis-world/internal";
import { debug, hasBinary, uint8ArrayReplacer } from "./util.js";

/**
 * Queue statistics from BullMQ, useful for monitoring and observability.
 */
export interface QueueStats {
  /** Jobs waiting to be processed */
  waiting: number;
  /** Jobs currently being processed */
  active: number;
  /** Successfully completed jobs (still retained) */
  completed: number;
  /** Failed jobs (still retained) */
  failed: number;
  /** Jobs scheduled for future execution */
  delayed: number;
}

/**
 * Node coerces a timer delay above this to 1 ms. BullMQ derives its lock
 * renewal timer from lockDuration, so the option is capped here.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface QueueJobData {
  /** The actual workflow/step queue name, including the suffix (e.g. `__wkf_workflow_wrun_...`) */
  queueName: ValidQueueName;
  /**
   * The queue payload, serialized with the tagged-JSON transport, forwarded
   * verbatim as the fetch body. Pre-serializing keeps Uint8Array values (e.g.
   * the resilient-start runInput.input) intact through BullMQ's own JSON
   * serialization of job data.
   */
  message: string;
  /**
   * Extra headers the producer asked to forward on delivery (`QueueOptions.headers`).
   * The `x-vqs-*` delivery headers are set by the worker and override these.
   */
  headers?: Record<string, string>;
  /** The route the producer registered for this prefix, if any (see `registerRoute`). */
  route?: string;
}

/**
 * JSON transport that preserves Uint8Array values via a tagged envelope
 * ({ __type: 'Uint8Array', data: '<base64>' }), matching the upstream
 * world-local/world-postgres queue transports. Required because BullMQ
 * JSON-serializes job data, which would otherwise mangle binary payloads.
 */
// Same fast path as storage: a replacer/reviver forces V8 off its fast path,
// costing ~2.6x on serialize and ~8x on parse. Queue payloads carry the same
// step inputs and results, so this applies per enqueue and dequeue.
function serializeQueueMessage(message: unknown): string {
  return hasBinary(message)
    ? JSON.stringify(message, uint8ArrayReplacer)
    : JSON.stringify(message);
}

function queueMessageReviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object") {
    const tagged = value as { __type?: unknown; data?: unknown };
    if (tagged.__type === "Uint8Array" && typeof tagged.data === "string") {
      return new Uint8Array(Buffer.from(tagged.data, "base64"));
    }
  }
  return value;
}

function deserializeQueueMessage(text: string): unknown {
  // Queue messages carry no Date fields, so with the tag absent a plain parse
  // is exactly equivalent.
  return text.includes('"__type"')
    ? JSON.parse(text, queueMessageReviver)
    : JSON.parse(text);
}

/**
 * Build the HTTP callback URL the BullMQ worker will POST to. The user must
 * mount `world.createQueueHandler(...)` at `/.well-known/workflow/v1/flow` and
 * `/.well-known/workflow/v1/step` (the Workflow DevKit convention).
 */
function resolveBaseUrl(config: RedisWorldConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (process.env.WORKFLOW_BASE_URL) return process.env.WORKFLOW_BASE_URL;
  const port = process.env.PORT ?? "3000";
  return `http://localhost:${port}`;
}

/**
 * BullMQ-backed Queue. Job dispatch happens via HTTP fetch to the user's
 * server; this package does not embed a workflow runtime.
 */
export function createQueue(
  redis: Redis,
  config: RedisWorldConfig,
  options: {
    /**
     * Whether a run has moved past `pending`. The first message of a run is not
     * queued again once it has, see `initialMessageKey`.
     */
    runHasStarted?: (runId: string) => Promise<boolean>;
  } = {},
): QueueInterface & {
  start(): Promise<void>;
  close(): Promise<void>;
  getQueueStats(): Promise<QueueStats>;
} {
  const generateMessageId = monotonicFactory();

  const prefix = config.jobPrefix || "workflow_";
  // v5 has one queue kind: a step travels on the workflow queue.
  const flowQueueName = `${prefix}flows`;

  const maxAttempts = config.maxAttempts ?? 73;
  const backoffType = config.backoffType ?? "exponential";
  const backoffDelayMs = config.backoffDelayMs ?? 1000;
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;
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

  /** In-process handlers by queue prefix (`registerHandler`). */
  const directHandlers = new Map<
    QueuePrefix,
    (req: Request) => Promise<Response>
  >();
  /** HTTP delivery routes by queue prefix (`registerRoute`). */
  const routes = new Map<QueuePrefix, string>();

  const queue: QueueInterface["queue"] = async (queueName, message, opts) => {
    const { prefix: queuePrefix } = parseQueueName(queueName);
    const route = routes.get(queuePrefix);

    const messageId = MessageId.parse(`msg_${generateMessageId()}`);
    const idempotencyKey = opts?.idempotencyKey ?? initialMessageKey(message);
    if (
      !opts?.idempotencyKey &&
      idempotencyKey &&
      (await options.runHasStarted?.((message as { runId: string }).runId))
    ) {
      debug("run already started, not queueing its first message again", {
        runId: (message as { runId: string }).runId,
      });
      return { messageId };
    }
    const delayMs = opts?.delaySeconds
      ? Math.max(0, opts.delaySeconds * 1000)
      : undefined;

    // Core treats queue() success as a durability guarantee, so add()
    // failures must propagate. BullMQ does NOT throw on dedup hits; the
    // addJob script returns the existing job id, so any rejection here is a
    // real failure (connection loss, OOM, ...) and swallowing it would strand
    // the run.
    const job = await bullQueue.add(
      queueName,
      {
        queueName,
        message: serializeQueueMessage(message),
        ...(opts?.headers && { headers: opts.headers }),
        ...(route && { route }),
      },
      {
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
      },
    );

    // A deduplicated add returns the job that is already queued: report its id,
    // not the one this call minted.
    return { messageId: MessageId.parse(job.id ?? messageId) };
  };

  /**
   * Extract a reschedule from a response body: `{ timeoutSeconds }` (answered
   * with a 200) asks for the same message to be delivered again after that
   * delay, without consuming an attempt.
   */
  function parseReschedule(text: string): number | undefined {
    try {
      const timeoutSeconds = Number(JSON.parse(text)?.timeoutSeconds);
      if (Number.isFinite(timeoutSeconds) && timeoutSeconds >= 0)
        return timeoutSeconds;
    } catch {
      // not a reschedule
    }
    return undefined;
  }

  async function processJob(
    job: Job<QueueJobData>,
    token?: string,
  ): Promise<void> {
    const { prefix: queuePrefix } = parseQueueName(job.data.queueName);
    const messageId = job.id ?? `msg_${generateMessageId()}`;

    const headers = new Headers(job.data.headers);
    headers.set("content-type", "application/json");
    headers.set("x-vqs-queue-name", job.data.queueName);
    headers.set("x-vqs-message-id", messageId);
    // Failed deliveries, plus those a crash cut short: a reschedule does not
    // consume an attempt, but a worker that died holding the job does. The runtime
    // treats attempt 1 as a first delivery with nothing yet in the log, so a job
    // that comes back after a crash must not report 1: the step it was running
    // would be started again even though its outcome is already recorded.
    headers.set(
      "x-vqs-message-attempt",
      String(job.attemptsMade + job.stalledCounter + 1),
    );
    // Every delivery that reached a handler, reschedules included.
    headers.set(
      "x-vqs-message-delivery-count",
      String(Math.max(1, job.attemptsStarted)),
    );
    headers.set(
      "x-vqs-message-created-at",
      new Date(job.timestamp).toISOString(),
    );

    const deliveryRoute = routes.get(queuePrefix) ?? job.data.route;
    const directHandler = directHandlers.get(queuePrefix);

    let response: Response;
    if (directHandler) {
      // In process: the request a route serving `createQueueHandler(prefix, ...)`
      // would receive, without the network hop.
      const localBase = createWorkflowBaseUrl("http://localhost");
      response = await directHandler(
        new Request(
          deliveryRoute
            ? createAppRouteUrl(localBase, deliveryRoute)
            : createWorkflowUrl(localBase, { type: "flow" }),
          { method: "POST", headers, body: job.data.message },
        ),
      );
    } else {
      const baseUrl = resolveBaseUrl(config);
      response = await fetch(
        deliveryRoute
          ? createAppRouteUrl(baseUrl, deliveryRoute)
          : createWorkflowUrl(baseUrl, { type: "flow" }),
        {
          method: "POST",
          headers,
          body: job.data.message,
          signal: AbortSignal.timeout(httpTimeoutMs),
        },
      );
    }

    const text = await response.text();

    if (response.ok) {
      const timeoutSeconds = parseReschedule(text);
      if (timeoutSeconds !== undefined) {
        // BullMQ requires throwing DelayedError after moveToDelayed so the worker
        // skips its completion/failure machinery for this invocation.
        await job.moveToDelayed(Date.now() + timeoutSeconds * 1000, token);
        throw new DelayedError();
      }
      return;
    }

    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const createQueueHandler: QueueInterface["createQueueHandler"] = (
    queueNamePrefix,
    handler,
  ) => {
    return async (req) => {
      const queueName = req.headers.get(
        "x-vqs-queue-name",
      ) as ValidQueueName | null;
      const messageId = req.headers.get("x-vqs-message-id") as MessageId | null;
      const attemptStr = req.headers.get("x-vqs-message-attempt");
      const deliveryCountStr = req.headers.get("x-vqs-message-delivery-count");
      const createdAtStr = req.headers.get("x-vqs-message-created-at");

      if (!queueName || !messageId || !attemptStr || !req.body) {
        return Response.json(
          { error: "Missing required headers or body" },
          { status: 400 },
        );
      }
      if (!queueName.startsWith(queueNamePrefix)) {
        return Response.json({ error: "Unhandled queue" }, { status: 400 });
      }

      const attempt = Number.parseInt(attemptStr, 10);
      const deliveryCount = deliveryCountStr
        ? Number.parseInt(deliveryCountStr, 10)
        : attempt;
      const createdAt = createdAtStr ? new Date(createdAtStr) : undefined;

      try {
        const body = deserializeQueueMessage(await req.text());
        const result = await handler(body, {
          attempt,
          deliveryCount,
          ...(createdAt && !Number.isNaN(createdAt.getTime()) && { createdAt }),
          queueName,
          messageId,
        });

        const timeoutSeconds = (
          result as { timeoutSeconds?: unknown } | null | undefined
        )?.timeoutSeconds;
        if (
          typeof timeoutSeconds === "number" &&
          Number.isFinite(timeoutSeconds)
        ) {
          return Response.json({ timeoutSeconds: Math.max(0, timeoutSeconds) });
        }
        return Response.json({ ok: true });
      } catch (error) {
        debug("queue handler error:", error);
        return Response.json({ error: String(error) }, { status: 500 });
      }
    };
  };

  const getDeploymentId: QueueInterface["getDeploymentId"] = async () =>
    "redis";

  async function startWorkers() {
    if (worker) return;
    worker = new Worker<QueueJobData>(flowQueueName, processJob, {
      connection: connectionOptions,
      concurrency: config.queueConcurrency || 10,
      stalledInterval,
      maxStalledCount,
      settings: {
        // The configured kind decides the curve; the cap keeps a late attempt from
        // waiting hours.
        backoffStrategy: (attemptsMade, _type, _err, job) => {
          const base = job?.opts.backoff
            ? ((job.opts.backoff as { delay?: number }).delay ?? backoffDelayMs)
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
    });

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

  async function getQueueStats(): Promise<QueueStats> {
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
  }

  return {
    createQueueHandler,
    getDeploymentId,
    queue,
    getQueueStats,
    registerHandler(handlerPrefix, handler) {
      directHandlers.set(handlerPrefix, handler);
    },
    registerRoute(routePrefix, path) {
      routes.set(routePrefix, parseQueueRoute(path));
    },
    async start() {
      await startWorkers();
    },
    async close() {
      await worker?.close();
      worker = undefined;
      await bullQueue.close();
    },
  };
}
