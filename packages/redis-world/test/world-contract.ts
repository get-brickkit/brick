import { randomUUID } from "node:crypto";
import { getQueueTopicPrefix, type QueuePrefix } from "@workflow/world";
import { createTestSuite } from "@workflow/world-testing";
// Opt-in suite: `createTestSuite` does not include it in 4.1.20, so it has to
// be deep-imported. It asserts the world honours WORKFLOW_MAX_EVENTS via
// EventResult.maxEvents.
import { eventLimit } from "@workflow/world-testing/dist/src/event-limit.mjs";
import { Redis } from "ioredis";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  RedisBackedWorld,
  RedisBackedWorldConfig,
  RunRetention,
} from "../src/internal.js";

/** A Redis-backed world package, as the contract below drives it. */
export interface WorldUnderTest {
  /** The package name, which the upstream spec suite loads. */
  packageName: string;
  createWorld(config: Partial<RedisBackedWorldConfig>): RedisBackedWorld;
  /** Config, beyond `keyPrefix`, that gives a world a queue of its own. */
  isolate(id: string): object;
}

/**
 * The behaviour every Redis-backed world shares, whatever its queue. Each world
 * package runs it against its own `createWorld`. Needs `REDIS_TEST_URL`
 * (test/global-setup.ts starts a container when it is unset).
 */
export function worldContract({
  packageName,
  createWorld,
  isolate,
}: WorldUnderTest): void {
  if (!process.env.REDIS_TEST_URL) {
    test.skip("needs REDIS_TEST_URL or Docker (see test/global-setup.ts)", () => {});
    return;
  }
  const redisUrl: string = process.env.REDIS_TEST_URL;

  describe("upstream world spec", () => {
    // The spec's server processes read the connection from the environment.
    process.env.WORKFLOW_REDIS_URL = redisUrl;
    process.env.REDIS_URL = redisUrl;
    createTestSuite(packageName);
    eventLimit(packageName);
  });

  describe("config from the environment", () => {
    afterEach(() => {
      delete process.env.WORKFLOW_REDIS_KEY_PREFIX;
    });

    test("env vars still apply when some config is passed", async () => {
      const keyPrefix = `env:${randomUUID()}:`;
      // WORKFLOW_REDIS_URL is set above for the spec suite.
      process.env.WORKFLOW_REDIS_KEY_PREFIX = keyPrefix;
      const world = createWorld({ ...isolate(randomUUID()), retention: {} });
      const redis = new Redis(redisUrl);
      try {
        await world.events.create(null, {
          eventType: "run_created",
          eventData: { deploymentId: "d", workflowName: "w", input: [] },
        });
        expect(await redis.keys(`${keyPrefix}*`)).not.toEqual([]);
      } finally {
        await world.close?.();
        await redis.quit();
      }
    });
  });

  // The queue contract end to end: the world's queue on a real Redis, delivering
  // to an in-process handler. What it pins is what the v5 runtime reads off a
  // delivery: the headers, how a reschedule counts, and that restart recovery
  // puts in-flight runs back.
  describe("world queue and recovery (Redis integration)", () => {
    // Each wait below allows 10s, so the test timeout must be longer: at vitest's
    // 5s default a stalled Redis or a starved CPU fails the test with a timeout
    // even though the queue delivers correctly afterwards.
    vi.setConfig({ testTimeout: 30_000 });

    const prefix: QueuePrefix = getQueueTopicPrefix("workflow");
    const worlds: RedisBackedWorld[] = [];

    afterEach(async () => {
      await Promise.all(worlds.splice(0).map((world) => world.close?.()));
    });

    /** A world with queue names and keys of its own, retrying quickly. */
    function newWorld(extra: Partial<RedisBackedWorldConfig> = {}) {
      const id = randomUUID();
      const world = createWorld({
        redis: redisUrl,
        keyPrefix: `world:${id}:`,
        ...isolate(id),
        backoffType: "fixed",
        backoffDelayMs: 20,
        queueConcurrency: 4,
        ...extra,
      });
      worlds.push(world);
      return world;
    }

    type Delivery = { headers: Headers; body: unknown };

    /** Registers a handler that records each delivery and answers from `respond`. */
    function recordDeliveries(
      world: RedisBackedWorld,
      respond: (
        delivery: Delivery,
        index: number,
      ) => Response | Promise<Response>,
    ) {
      const deliveries: Delivery[] = [];
      world.registerHandler?.(prefix, async (request) => {
        const delivery = {
          headers: request.headers,
          body: await request.json(),
        };
        deliveries.push(delivery);
        return respond(delivery, deliveries.length - 1);
      });
      return deliveries;
    }

    const queueName = `${prefix}test-workflow` as const;

    test("delivers a message with the headers the runtime reads", async () => {
      const world = newWorld();
      const deliveries = recordDeliveries(world, () =>
        Response.json({ ok: true }),
      );
      await world.start();

      const { messageId } = await world.queue(queueName, {
        runId: "wrun_headers",
      });
      await vi.waitFor(() => expect(deliveries).toHaveLength(1), {
        timeout: 10_000,
      });

      const { headers, body } = deliveries[0];
      expect(body).toEqual({ runId: "wrun_headers" });
      expect(headers.get("x-vqs-queue-name")).toBe(queueName);
      expect(headers.get("x-vqs-message-id")).toBe(messageId);
      expect(headers.get("x-vqs-message-attempt")).toBe("1");
      expect(headers.get("x-vqs-message-delivery-count")).toBe("1");
      expect(
        new Date(headers.get("x-vqs-message-created-at")!).getTime(),
      ).not.toBeNaN();
    });

    test("forwards headers the producer asked for, but not over the delivery headers", async () => {
      const world = newWorld();
      const deliveries = recordDeliveries(world, () =>
        Response.json({ ok: true }),
      );
      await world.start();

      await world.queue(
        queueName,
        { runId: "wrun_forward" },
        { headers: { "x-custom": "yes", "x-vqs-message-attempt": "99" } },
      );
      await vi.waitFor(() => expect(deliveries).toHaveLength(1), {
        timeout: 10_000,
      });
      expect(deliveries[0].headers.get("x-custom")).toBe("yes");
      expect(deliveries[0].headers.get("x-vqs-message-attempt")).toBe("1");
    });

    test("a reschedule keeps the message id and keeps counting deliveries", async () => {
      const world = newWorld();
      const deliveries = recordDeliveries(world, (_delivery, index) =>
        // The handler contract answers `{ timeoutSeconds }` with a 200.
        index === 0
          ? Response.json({ timeoutSeconds: 0 })
          : Response.json({ ok: true }),
      );
      await world.start();

      await world.queue(queueName, { runId: "wrun_reschedule" });
      await vi.waitFor(() => expect(deliveries).toHaveLength(2), {
        timeout: 10_000,
      });

      const [first, second] = deliveries.map((d) => d.headers);
      expect(second.get("x-vqs-message-id")).toBe(
        first.get("x-vqs-message-id"),
      );
      // A reschedule is not a failure, so the attempt starts over; the delivery count does not.
      expect(second.get("x-vqs-message-attempt")).toBe("1");
      expect(first.get("x-vqs-message-delivery-count")).toBe("1");
      expect(second.get("x-vqs-message-delivery-count")).toBe("2");
      expect(second.get("x-vqs-message-created-at")).toBe(
        first.get("x-vqs-message-created-at"),
      );
    });

    test("a rejected delivery is retried with an incremented attempt", async () => {
      const world = newWorld();
      const deliveries = recordDeliveries(world, (_delivery, index) =>
        index === 0
          ? Response.json({ error: "boom" }, { status: 500 })
          : Response.json({ ok: true }),
      );
      await world.start();

      await world.queue(queueName, { runId: "wrun_retry" });
      await vi.waitFor(() => expect(deliveries).toHaveLength(2), {
        timeout: 10_000,
      });
      expect(deliveries[1].headers.get("x-vqs-message-attempt")).toBe("2");
      expect(deliveries[1].headers.get("x-vqs-message-delivery-count")).toBe(
        "2",
      );
    });

    test("drops a duplicate enqueue that carries the same idempotency key", async () => {
      const world = newWorld();
      const deliveries = recordDeliveries(world, async () => {
        // Hold the first delivery open so the second enqueue arrives while it is pending.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return Response.json({ ok: true });
      });
      await world.queue(
        queueName,
        { runId: "wrun_dedup" },
        { idempotencyKey: "key-1" },
      );
      await world.queue(
        queueName,
        { runId: "wrun_dedup" },
        { idempotencyKey: "key-1" },
      );
      await world.start();

      await vi.waitFor(() => expect(deliveries).toHaveLength(1), {
        timeout: 10_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(deliveries).toHaveLength(1);
    });

    test("queues the first message of a run once, however often the run is started", async () => {
      const world = newWorld();
      const deliveries = recordDeliveries(world, async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return Response.json({ ok: true });
      });
      const message = {
        runId: "wrun_start_twice",
        runInput: {
          input: "x",
          deploymentId: "test",
          workflowName: "workflow//test.ts//start",
          specVersion: 5,
        },
      };
      const first = await world.queue(queueName, message);
      const second = await world.queue(queueName, message);
      await world.start();

      expect(second.messageId).toBe(first.messageId);
      await vi.waitFor(() => expect(deliveries).toHaveLength(1), {
        timeout: 10_000,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(deliveries).toHaveLength(1);
    });

    test("does not collapse later messages of a run, which carry no run input", async () => {
      const world = newWorld();
      const deliveries = recordDeliveries(world, () =>
        Response.json({ ok: true }),
      );
      await world.start();
      await world.queue(queueName, { runId: "wrun_later" });
      await world.queue(queueName, { runId: "wrun_later" });

      await vi.waitFor(() => expect(deliveries).toHaveLength(2), {
        timeout: 10_000,
      });
    });

    test("hands out a deterministic run id for a runKey", () => {
      const world = newWorld();
      const options = {
        runKey: "evt_1:welcome",
        runKeyTime: 1_760_000_000_000,
      };
      expect(world.createRunId?.(options)).toBe(
        world.createRunId?.({ ...options }),
      );
      expect(world.createRunId?.()).toHaveLength(26);
    });

    test("delays a message by delaySeconds", async () => {
      const world = newWorld();
      let deliveredAt = 0;
      const deliveries = recordDeliveries(world, () => {
        deliveredAt ||= Date.now();
        return Response.json({ ok: true });
      });
      await world.start();

      const startedAt = Date.now();
      await world.queue(
        queueName,
        { runId: "wrun_delay" },
        { delaySeconds: 1 },
      );
      await vi.waitFor(() => expect(deliveries).toHaveLength(1), {
        timeout: 10_000,
      });
      // Stamped by the handler, so polling and load can only make it later, and
      // startedAt precedes the enqueue: an early delivery cannot reach a full second.
      expect(deliveredAt - startedAt).toBeGreaterThanOrEqual(1000);
    });

    test("start() puts runs that were in flight back on the queue", async () => {
      const world = newWorld();
      const created = await world.events.create(null, {
        eventType: "run_created",
        eventData: {
          deploymentId: "d",
          workflowName: "recovered-workflow",
          input: [],
        },
      });
      const runId = created.run!.runId;
      // A finished run must not come back.
      const done = await world.events.create(null, {
        eventType: "run_created",
        eventData: {
          deploymentId: "d",
          workflowName: "finished-workflow",
          input: [],
        },
      });
      await world.events.create(done.run!.runId, { eventType: "run_started" });
      await world.events.create(done.run!.runId, {
        eventType: "run_completed",
        eventData: { output: new Uint8Array([1]) },
      });

      const deliveries = recordDeliveries(world, () =>
        Response.json({ ok: true }),
      );
      await world.start();

      await vi.waitFor(
        () => expect(deliveries.length).toBeGreaterThanOrEqual(1),
        {
          timeout: 10_000,
        },
      );
      const names = deliveries.map((d) => d.headers.get("x-vqs-queue-name"));
      expect(names).toContain(`${prefix}recovered-workflow`);
      expect(names).not.toContain(`${prefix}finished-workflow`);
      expect(
        deliveries.find((d) =>
          d.headers.get("x-vqs-queue-name")?.endsWith("recovered-workflow"),
        )?.body,
      ).toMatchObject({
        runId,
      });
    });

    test("two workers restarting together recover a run once", async () => {
      const id = randomUUID();
      const shared = { keyPrefix: `world:${id}:`, ...isolate(id) };
      const first = newWorld(shared);
      const second = newWorld(shared);
      await first.events.create(null, {
        eventType: "run_created",
        eventData: {
          deploymentId: "d",
          workflowName: "shared-workflow",
          input: [],
        },
      });

      // Deduplication lasts until the message is acknowledged. Keep the recovered
      // message active until both workers finish recovery, and handle it whichever
      // worker picks it up.
      let finishDelivery: (() => void) | undefined;
      const deliveryFinished = new Promise<void>((resolve) => {
        finishDelivery = resolve;
      });
      const respond = async () => {
        await deliveryFinished;
        return Response.json({ ok: true });
      };
      const firstDeliveries = recordDeliveries(first, respond);
      const secondDeliveries = recordDeliveries(second, respond);
      try {
        await Promise.all([first.start(), second.start()]);

        await vi.waitFor(
          () =>
            expect(firstDeliveries.length + secondDeliveries.length).toBe(1),
          { timeout: 10_000 },
        );
        expect(await first.getQueueStats()).toEqual({
          waiting: 0,
          active: 1,
          completed: 0,
          failed: 0,
          delayed: 0,
        });
      } finally {
        finishDelivery?.();
      }
    });
  });

  // Retention end to end: finished runs past their policy are deleted with every
  // key they own; live runs and runs inside the policy are not touched.
  describe("run retention (Redis integration)", () => {
    const worlds: RedisBackedWorld[] = [];
    const clients: Redis[] = [];

    afterEach(async () => {
      await Promise.all(worlds.splice(0).map((world) => world.close?.()));
      await Promise.all(clients.splice(0).map((client) => client.quit()));
    });

    function setup(retention: RunRetention) {
      const id = randomUUID();
      const keyPrefix = `world:${id}:`;
      const world = createWorld({
        redis: redisUrl,
        keyPrefix,
        ...isolate(id),
        retention,
      });
      worlds.push(world);
      const redis = new Redis(redisUrl);
      clients.push(redis);
      return { world, redis, keyPrefix };
    }

    async function startRun(world: RedisBackedWorld) {
      const created = await world.events.create(null, {
        eventType: "run_created",
        eventData: { deploymentId: "d", workflowName: "w", input: [] },
      });
      const runId = created.run!.runId;
      await world.events.create(runId, { eventType: "run_started" });
      await world.events.create(runId, {
        eventType: "step_created",
        correlationId: "step_1",
        eventData: { stepName: "s", input: [] },
      });
      return runId;
    }

    async function keysOf(redis: Redis, keyPrefix: string) {
      return (await redis.keys(`${keyPrefix}*`)).filter(
        (k) => !k.includes("reaper:lock"),
      );
    }

    test("deletes an expired run with everything it owns, and leaves a live run", async () => {
      const { world, redis, keyPrefix } = setup({ completed: { age: 0 } });
      const done = await startRun(world);
      await world.events.create(done, {
        eventType: "step_started",
        correlationId: "step_1",
      });
      await world.events.create(done, {
        eventType: "step_completed",
        correlationId: "step_1",
        eventData: { result: [] },
      });
      await world.events.create(done, {
        eventType: "run_completed",
        eventData: { output: [] },
      });
      const live = await startRun(world);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(await world.sweepRetention()).toBe(1);

      await expect(world.runs.get(done)).rejects.toMatchObject({
        name: "WorkflowRunNotFoundError",
      });
      expect((await world.runs.get(live)).status).toBe("running");
      const left = await keysOf(redis, keyPrefix);
      expect(left.filter((k) => k.includes(done))).toEqual([]);
      expect((await world.runs.list({})).data.map((r) => r.runId)).toEqual([
        live,
      ]);
    });

    test("count keeps the newest finished runs", async () => {
      const { world } = setup({ completed: { count: 2 } });
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const id = await startRun(world);
        await world.events.create(id, {
          eventType: "run_completed",
          eventData: { output: [] },
        });
        ids.push(id);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(await world.sweepRetention()).toBe(2);
      const left = (await world.runs.list({})).data.map((r) => r.runId).sort();
      expect(left).toEqual(ids.slice(2).sort());
    });

    test("a status without a policy is kept", async () => {
      const { world } = setup({ completed: { age: 0 } });
      const id = await startRun(world);
      await world.events.create(id, {
        eventType: "run_failed",
        eventData: { error: { message: "x" } },
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await world.sweepRetention()).toBe(0);
      expect((await world.runs.get(id)).status).toBe("failed");
    });

    test("rejects an invalid policy", () => {
      expect(() =>
        createWorld({ redis: redisUrl, retention: { completed: { age: -1 } } }),
      ).toThrow(/retention.completed.age/);
    });
  });

  // Review repro: the default retry budget retires a message long before the
  // runtime's own delivery ceiling (MAX_QUEUE_DELIVERIES = 48; core records
  // MAX_DELIVERIES_EXCEEDED on delivery 49). A retired message strands its run in
  // `running` with no terminal event; nothing re-enqueues it until a process calls
  // start() again.

  describe("review: queue retry budget", () => {
    const prefix: QueuePrefix = getQueueTopicPrefix("workflow");
    const worlds: RedisBackedWorld[] = [];

    afterEach(async () => {
      await Promise.all(worlds.splice(0).map((w) => w.close?.()));
    });

    test("keeps redelivering a failing message until core can fail the run (delivery 49)", async () => {
      const id = randomUUID();
      const world = createWorld({
        redis: redisUrl,
        keyPrefix: `review:${id}:`,
        ...isolate(id),
        // Only the backoff is shortened; the retry budgets keep their defaults.
        backoffType: "fixed",
        backoffDelayMs: 5,
      });
      worlds.push(world);
      let deliveries = 0;
      world.registerHandler?.(prefix, async () => {
        deliveries++;
        // A transient failure: the app server is restarting, storage blipped, ...
        return Response.json({ error: "transient" }, { status: 500 });
      });
      await world.start();
      await world.queue(`${prefix}review-wf` as const, { runId: `wrun_${id}` });

      await vi.waitFor(
        async () => {
          const stats = await world.getQueueStats();
          expect(deliveries >= 49 || stats.failed > 0).toBe(true);
        },
        { timeout: 15_000, interval: 50 },
      );
      const stats = await world.getQueueStats();
      expect(deliveries).toBeGreaterThanOrEqual(49);
      expect(stats.failed).toBe(0);
    }, 30_000);
  });
}
