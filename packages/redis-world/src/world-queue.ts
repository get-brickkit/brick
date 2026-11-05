import {
  MessageId,
  parseQueueName,
  parseQueueRoute,
  type Queue,
  type QueuePrefix,
  type ValidQueueName,
} from "@workflow/world";
import {
  createAppRouteUrl,
  createWorkflowBaseUrl,
  createWorkflowUrl,
} from "@workflow/utils";
import { monotonicFactory } from "ulid";
import type { RedisBackedWorldConfig } from "./config.js";
import { parseQueueMessage, stringify } from "./internal/serialization.js";
import { initialMessageKey } from "./run-id.js";

export interface QueueStats {
  waiting: number;
  active: number;
  delayed: number;
  /** Finished delivery records the queue still holds; redis-world keeps none. */
  completed: number;
  failed: number;
}

/** A message as a queue backend stores it. */
export interface QueuedMessage {
  messageId: MessageId;
  queueName: ValidQueueName;
  /** The payload, already serialized; forwarded verbatim as the request body. */
  message: string;
  /** Extra headers the producer asked to forward; the `x-vqs-*` ones override them. */
  headers?: Record<string, string>;
  /** The route registered for this prefix when it was queued (`registerRoute`). */
  route?: string;
}

/** One delivery of a stored message, with the counters the backend keeps. */
export interface Delivery extends QueuedMessage {
  /** Failed deliveries plus this one, crashes included; reschedules don't count. */
  attempt: number;
  /** Every delivery that reached a handler, reschedules included. */
  deliveryCount: number;
  /** When the message was first queued (epoch ms). */
  createdAt: number;
}

/**
 * Delivers a message to its handler. Resolves to the seconds after which the
 * same message is to be delivered again without consuming an attempt, or
 * `undefined` to acknowledge it. Throws when the delivery failed and must be
 * retried.
 */
export type Deliver = (delivery: Delivery) => Promise<number | undefined>;

/** The part of a world's queue that differs between Redis queue implementations. */
export interface QueueBackend {
  /** Store a message. Resolves to the id of the queued message: on an
   * `idempotencyKey` hit, the one already queued. */
  enqueue(
    message: QueuedMessage,
    opts: { idempotencyKey?: string; delaySeconds?: number },
  ): Promise<MessageId>;
  /** Start delivering stored messages through `deliver`. */
  start(deliver: Deliver): Promise<void>;
  close(): Promise<void>;
  getQueueStats(): Promise<QueueStats>;
}

export type WorldQueue = Queue & {
  start(): Promise<void>;
  close(): Promise<void>;
  getQueueStats(): Promise<QueueStats>;
};

export interface WorldQueueOptions {
  /**
   * Whether a run has moved past `pending`. The first message of a run is not
   * queued again once it has, see `initialMessageKey`.
   */
  runHasStarted?: (runId: string) => Promise<boolean>;
}

/** A response without a valid `{ timeoutSeconds }` acknowledges the message. */
function parseReschedule(text: string): number | undefined {
  try {
    const seconds: unknown = JSON.parse(text)?.timeoutSeconds;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0)
      return seconds;
  } catch {
    /* not a reschedule */
  }
  return undefined;
}

/**
 * The Workflow SDK `Queue` on top of a backend: message ids, the first-message
 * guard, the payload transport, HTTP or in-process delivery with the `x-vqs-*`
 * headers, and the handler that answers those deliveries.
 */
export function createWorldQueue(
  backend: QueueBackend,
  config: Pick<RedisBackedWorldConfig, "baseUrl" | "httpTimeoutMs">,
  options: WorldQueueOptions & { debug: (...args: unknown[]) => void },
): WorldQueue {
  const { debug } = options;
  const generateMessageId = monotonicFactory();
  const httpTimeoutMs = config.httpTimeoutMs ?? 300_000;
  const directHandlers = new Map<
    QueuePrefix,
    (req: Request) => Promise<Response>
  >();
  const routes = new Map<QueuePrefix, string>();
  let closed = false;

  const queue: Queue["queue"] = async (queueName, message, opts) => {
    if (closed) throw new Error("Queue is closed");
    const { prefix } = parseQueueName(queueName);
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
    const route = routes.get(prefix);
    return {
      messageId: await backend.enqueue(
        {
          messageId,
          queueName,
          // Tagged JSON keeps Uint8Array values (e.g. the resilient-start
          // runInput.input) intact through the backend's own JSON.
          message: stringify(message),
          ...(opts?.headers && { headers: opts.headers }),
          ...(route && { route }),
        },
        { idempotencyKey, delaySeconds: opts?.delaySeconds },
      ),
    };
  };

  const deliver: Deliver = async (job) => {
    const { prefix } = parseQueueName(job.queueName);
    const headers = new Headers(job.headers);
    headers.set("content-type", "application/json");
    headers.set("x-vqs-queue-name", job.queueName);
    headers.set("x-vqs-message-id", job.messageId);
    headers.set("x-vqs-message-attempt", String(job.attempt));
    headers.set("x-vqs-message-delivery-count", String(job.deliveryCount));
    headers.set(
      "x-vqs-message-created-at",
      new Date(job.createdAt).toISOString(),
    );

    const deliveryRoute = routes.get(prefix) ?? job.route;
    const directHandler = directHandlers.get(prefix);

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
          { method: "POST", headers, body: job.message },
        ),
      );
    } else {
      const baseUrl =
        config.baseUrl ||
        process.env.WORKFLOW_BASE_URL ||
        `http://localhost:${process.env.PORT ?? "3000"}`;
      response = await fetch(
        deliveryRoute
          ? createAppRouteUrl(baseUrl, deliveryRoute)
          : createWorkflowUrl(baseUrl, { type: "flow" }),
        {
          method: "POST",
          headers,
          body: job.message,
          signal: AbortSignal.timeout(httpTimeoutMs),
        },
      );
    }

    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
    return parseReschedule(text);
  };

  const createQueueHandler: Queue["createQueueHandler"] = (
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
        const body = parseQueueMessage(await req.text());
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

  return {
    queue,
    createQueueHandler,
    getDeploymentId: async () => "redis",
    registerHandler(prefix, handler) {
      directHandlers.set(prefix, handler);
    },
    registerRoute(prefix, path) {
      routes.set(prefix, parseQueueRoute(path));
    },
    getQueueStats: () => backend.getQueueStats(),
    start: () => backend.start(deliver),
    async close() {
      closed = true;
      await backend.close();
    },
  };
}
