import { randomUUID } from "node:crypto";
import { RedisContainer } from "@testcontainers/redis";
import { getQueueTopicPrefix, type QueuePrefix } from "@workflow/world";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { createWorld } from "../src/index.js";

// The queue contract end to end: a real Redis queue queue on a real Redis, delivering
// to an in-process handler. What it pins is what the v5 runtime reads off a
// delivery: the headers, how a reschedule counts, and that restart recovery
// puts in-flight runs back.
describe("world queue and recovery (Redis integration)", () => {
  if (process.platform === "win32") {
    test.skip("skipped on Windows since it relies on a docker container", () => {});
    return;
  }

  // Each wait below allows 10s, so the test timeout must be longer: at vitest's
  // 5s default a stalled Redis or a starved CPU fails the test with a timeout
  // even though the queue delivers correctly afterwards.
  vi.setConfig({ testTimeout: 30_000 });

  const prefix: QueuePrefix = getQueueTopicPrefix("workflow");
  let container: Awaited<ReturnType<RedisContainer["start"]>> | undefined;
  let redisUrl: string;
  const worlds: ReturnType<typeof createWorld>[] = [];

  beforeAll(async () => {
    // REDIS_TEST_URL points the suite at an existing Redis instead of a container.
    redisUrl =
      process.env.REDIS_TEST_URL ??
      (container = await new RedisContainer(
        "redis:7-alpine",
      ).start()).getConnectionUrl();
  }, 120_000);

  afterEach(async () => {
    await Promise.all(worlds.splice(0).map((world) => world.close?.()));
  });

  afterAll(async () => {
    await container?.stop();
  });

  /** A world with queue names and keys of its own, retrying quickly. */
  function newWorld(extra: Partial<Parameters<typeof createWorld>[0]> = {}) {
    const id = randomUUID();
    const world = createWorld({
      redis: redisUrl,
      keyPrefix: `world:${id}:`,

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
    world: ReturnType<typeof createWorld>,
    respond: (
      delivery: Delivery,
      index: number,
    ) => Response | Promise<Response>,
  ) {
    const deliveries: Delivery[] = [];
    world.registerHandler?.(prefix, async (request) => {
      const delivery = { headers: request.headers, body: await request.json() };
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
    expect(second.get("x-vqs-message-id")).toBe(first.get("x-vqs-message-id"));
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
    expect(deliveries[1].headers.get("x-vqs-message-delivery-count")).toBe("2");
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
    const options = { runKey: "evt_1:welcome", runKeyTime: 1_760_000_000_000 };
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
    await world.queue(queueName, { runId: "wrun_delay" }, { delaySeconds: 1 });
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
    const shared = { keyPrefix: `world:${id}:` };
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
    // worker picks it up (the fix bullmq-world's copy of this test got in 3960b81).
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
        () => expect(firstDeliveries.length + secondDeliveries.length).toBe(1),
        { timeout: 10_000 },
      );
      expect(await first.getQueueStats()).toMatchObject({
        waiting: 0,
        active: 1,
      });
    } finally {
      finishDelivery?.();
    }
  });
});
