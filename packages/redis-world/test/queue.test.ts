import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { RedisContainer } from "@testcontainers/redis";
import { getQueueTopicPrefix } from "@workflow/world";
import { Redis } from "ioredis";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { createQueue } from "../src/queue.js";
import { resolveConfig, type RedisWorldConfig } from "../src/config.js";
import { keys } from "../src/keys.js";

const prefix = getQueueTopicPrefix("workflow");
const queueName = `${prefix}list-tests`;
let container: Awaited<ReturnType<RedisContainer["start"]>> | undefined;
let url: string;
let redis: Redis;
const queues: ReturnType<typeof createQueue>[] = [];
const children: ChildProcess[] = [];
const namespaces: string[] = [];
const releases: (() => void)[] = [];

beforeAll(async () => {
  url =
    process.env.REDIS_TEST_URL ??
    (container = await new RedisContainer(
      "redis:7-alpine",
    ).start()).getConnectionUrl();
  redis = new Redis(url);
}, 120_000);
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0)) release();
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  await Promise.all(queues.splice(0).map((q) => q.close()));
  for (const ns of namespaces.splice(0)) {
    const keys = await redis.keys(`${ns}*`);
    if (keys.length) await redis.del(...keys);
  }
});
afterAll(async () => {
  await redis.quit();
  await container?.stop();
});

function setup(extra: Partial<RedisWorldConfig> = {}) {
  const keyPrefix = `list:${randomUUID()}:`;
  namespaces.push(keyPrefix);
  const config = {
    redis: url,
    keyPrefix,
    heartbeatTtlMs: 600,
    queueConcurrency: 1,
    backoffDelayMs: 0,
    maxBackoffMs: 10,
    ...extra,
  };
  const q = createQueue(redis, resolveConfig(config));
  queues.push(q);
  return { q, config, root: keys(config.keyPrefix).queue };
}
function held() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return { promise, release };
}
const wait = (check: () => unknown) =>
  vi.waitFor(check, { timeout: 10_000, interval: 25 });

async function deadWorker(config: RedisWorldConfig) {
  const child = spawn(process.execPath, ["test/fixtures/queue-worker.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, QUEUE_CONFIG: JSON.stringify(config) },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  const errors: string[] = [];
  child.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  const reserved = new Promise<Headers>((resolve, reject) => {
    child.once("message", (message) => {
      if (
        message !== null &&
        typeof message === "object" &&
        "headers" in message &&
        Array.isArray(message.headers)
      )
        resolve(new Headers(message.headers));
      else
        reject(new Error(`Invalid child message ${JSON.stringify(message)}`));
    });
    child.once("exit", () =>
      reject(new Error(`Worker exited before reservation: ${errors.join("")}`)),
    );
  });
  return { child, reserved };
}

describe("reliable Redis list queue", () => {
  test("start is idempotent and uses one shared flow queue", async () => {
    const { q, root } = setup();
    await Promise.all([q.start(), q.start()]);
    await q.start();
    expect(await redis.scard(root.workers)).toBe(1);
  });

  test.each([
    0,
    -1,
    299,
    1.5,
    2_147_483_648,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects heartbeatTtlMs %s", (heartbeatTtlMs) => {
    expect(() => setup({ heartbeatTtlMs })).toThrow(RangeError);
  });
  test.each([0, 48, 1.5, Number.NaN])(
    "rejects unsafe retry budget %s",
    (maxAttempts) => {
      expect(() => setup({ maxAttempts })).toThrow(RangeError);
    },
  );

  test("SIGKILL leaves a claim that expires and redelivers with attempt > 1", async () => {
    const { q, config, root } = setup();
    const first = await q.queue(
      queueName,
      { runId: "wrun_crash" },
      { idempotencyKey: "crash" },
    );
    const { child, reserved } = await deadWorker(config);
    const initial = await reserved;
    expect(initial.get("x-vqs-message-attempt")).toBe("1");
    expect(await q.getQueueStats()).toMatchObject({ active: 1 });
    child.kill("SIGKILL");
    await once(child, "exit");
    const deliveries: Headers[] = [];
    q.registerHandler?.(prefix, async (req) => {
      deliveries.push(req.headers);
      return Response.json({ ok: true });
    });
    await q.start();
    await wait(() => expect(deliveries).toHaveLength(1));
    expect(deliveries[0].get("x-vqs-message-id")).toBe(first.messageId);
    expect(deliveries[0].get("x-vqs-message-attempt")).toBe("2");
    expect(deliveries[0].get("x-vqs-message-delivery-count")).toBe("2");
    await wait(async () =>
      expect(await redis.exists(root.idempotent("crash"))).toBe(0),
    );
  });

  test("a delayed enqueue survives closing and creating a worker", async () => {
    const { q, config } = setup();
    const id = await q.queue(
      queueName,
      { runId: "wrun_delay" },
      { delaySeconds: 0.5 },
    );
    await q.close();
    await sleep(600);
    const next = setup(config).q;
    let delivered: string | null = null;
    next.registerHandler?.(prefix, async (req) => {
      delivered = req.headers.get("x-vqs-message-id");
      return Response.json({ ok: true });
    });
    expect(await next.getQueueStats()).toMatchObject({
      delayed: 1,
      waiting: 0,
    });
    await next.start();
    await wait(() => expect(delivered).toBe(id.messageId));
  });

  test("a handler's reschedule survives worker restart without consuming an attempt", async () => {
    const { q, config } = setup();
    q.registerHandler?.(prefix, async () =>
      Response.json({ timeoutSeconds: 0.5 }),
    );
    await q.start();
    await q.queue(queueName, { runId: "wrun_reschedule" });
    await wait(async () => expect((await q.getQueueStats()).delayed).toBe(1));
    await q.close();
    const next = setup(config).q;
    const headers: Headers[] = [];
    next.registerHandler?.(prefix, async (req) => {
      headers.push(req.headers);
      return Response.json({ ok: true });
    });
    await next.start();
    await wait(() => expect(headers).toHaveLength(1));
    expect(headers[0].get("x-vqs-message-attempt")).toBe("1");
    expect(headers[0].get("x-vqs-message-delivery-count")).toBe("2");
  });

  test("dedup returns the same ID while ready, active and delayed, then releases on ack", async () => {
    const { q } = setup();
    const gate = held();
    const enqueue = () =>
      q.queue(queueName, { runId: "wrun_dedup" }, { idempotencyKey: "shared" });
    const first = await enqueue();
    expect(await enqueue()).toEqual(first);
    let calls = 0;
    q.registerHandler?.(prefix, async () => {
      calls++;
      if (calls === 1) {
        await gate.promise;
        return Response.json({ timeoutSeconds: 0.4 });
      }
      return Response.json({ ok: true });
    });
    await q.start();
    await wait(() => expect(calls).toBe(1));
    expect(await enqueue()).toEqual(first);
    gate.release();
    await wait(async () => expect((await q.getQueueStats()).delayed).toBe(1));
    expect(await enqueue()).toEqual(first);
    await wait(async () =>
      expect(await q.getQueueStats()).toMatchObject({
        waiting: 0,
        active: 0,
        delayed: 0,
      }),
    );
    expect((await enqueue()).messageId).not.toBe(first.messageId);
  });

  test("an old ack cannot release a dedup key that expired and was acquired by a new message", async () => {
    const { q } = setup({ idempotencyTtlMs: 150 });
    const gate = held();
    let calls = 0;
    q.registerHandler?.(prefix, async () => {
      calls++;
      await gate.promise;
      return Response.json({ ok: true });
    });
    await q.start();
    await q.queue(queueName, { runId: "wrun_old" }, { idempotencyKey: "ttl" });
    await wait(() => expect(calls).toBe(1));
    await sleep(160);
    const next = await q.queue(
      queueName,
      { runId: "wrun_new" },
      { idempotencyKey: "ttl", delaySeconds: 5 },
    );
    gate.release();
    await wait(async () => expect((await q.getQueueStats()).active).toBe(0));
    expect(
      await q.queue(
        queueName,
        { runId: "wrun_dup" },
        { idempotencyKey: "ttl" },
      ),
    ).toEqual(next);
  });

  test.each([false, true])(
    "settlement after reclaim is fenced (defer=%s)",
    async (defer) => {
      const { q, config, root } = setup();
      const old = held();
      const replacement = held();
      let started = false;
      let recovered = false;
      q.registerHandler?.(prefix, async () => {
        started = true;
        await old.promise;
        return Response.json(defer ? { timeoutSeconds: 0 } : { ok: true });
      });
      const id = await q.queue(
        queueName,
        { runId: "wrun_fence" },
        { idempotencyKey: "fence" },
      );
      await q.start();
      await wait(() => expect(started).toBe(true));
      const [owner] = await redis.smembers(root.workers);
      await redis.del(root.heartbeat(owner!));
      const second = setup(config).q;
      second.registerHandler?.(prefix, async () => {
        recovered = true;
        await replacement.promise;
        return Response.json({ ok: true });
      });
      await second.start();
      await wait(() => expect(recovered).toBe(true));
      old.release();
      await sleep(150);
      expect(await redis.get(root.idempotent("fence"))).toBe(id.messageId);
      expect(await q.getQueueStats()).toMatchObject({
        active: 1,
        waiting: 0,
        delayed: 0,
      });
      expect(
        await q.queue(
          queueName,
          { runId: "wrun_dup" },
          { idempotencyKey: "fence" },
        ),
      ).toEqual(id);
      replacement.release();
      await wait(async () =>
        expect(await redis.exists(root.idempotent("fence"))).toBe(0),
      );
    },
  );

  test("two workers deliver each message once with no overlapping execution", async () => {
    const { q, config } = setup({ queueConcurrency: 4 });
    const second = setup(config).q;
    const seen = new Map<string, number>();
    const active = new Set<string>();
    let overlaps = 0;
    for (const worker of [q, second])
      worker.registerHandler?.(prefix, async (req) => {
        const id = req.headers.get("x-vqs-message-id")!;
        if (active.has(id)) overlaps++;
        active.add(id);
        seen.set(id, (seen.get(id) ?? 0) + 1);
        await sleep(15);
        active.delete(id);
        return Response.json({ ok: true });
      });
    await Promise.all([q.start(), second.start()]);
    await Promise.all(
      Array.from({ length: 80 }, (_, i) =>
        q.queue(queueName, { runId: `wrun_${i}` }),
      ),
    );
    await wait(() => expect(seen.size).toBe(80));
    await wait(async () => expect((await q.getQueueStats()).active).toBe(0));
    expect(overlaps).toBe(0);
    expect([...seen.values()]).toEqual(Array(80).fill(1));
  });

  test("continues beyond maxAttempts, succeeds, and releases dedup", async () => {
    const { q, root } = setup({ maxAttempts: 49 });
    let count = 0;
    q.registerHandler?.(prefix, async () =>
      Response.json({}, { status: ++count <= 52 ? 500 : 200 }),
    );
    await q.start();
    await q.queue(
      queueName,
      { runId: "wrun_budget" },
      { idempotencyKey: "budget" },
    );
    await wait(() => expect(count).toBe(53));
    await wait(async () =>
      expect(await redis.exists(root.idempotent("budget"))).toBe(0),
    );
    expect(await q.getQueueStats()).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
      completed: 0,
      failed: 0,
    });
  }, 15_000);

  test("tagged JSON preserves nested Uint8Array payloads through createQueueHandler", async () => {
    const { q } = setup();
    let body: unknown;
    q.registerHandler?.(
      prefix,
      q.createQueueHandler(prefix, async (message) => {
        body = message;
      }),
    );
    await q.start();
    const message = {
      runId: "wrun_binary",
      runInput: {
        input: new Uint8Array([0, 128, 255]),
        deploymentId: "d",
        workflowName: "binary",
        specVersion: 2,
      },
    };
    await q.queue(queueName, message);
    await wait(() => expect(body).toEqual(message));
  });

  test("HTTP fallback posts to the registered route with delivery headers", async () => {
    let request: { url?: string; attempt?: string; body: string } | undefined;
    const server = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      request = {
        url: req.url,
        attempt: String(req.headers["x-vqs-message-attempt"]),
        body,
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No address");
      const { q } = setup({ baseUrl: `http://127.0.0.1:${address.port}` });
      q.registerRoute?.(prefix, "/custom-flow");
      await q.start();
      await q.queue(queueName, { runId: "wrun_http" });
      await wait(() =>
        expect(request).toEqual({
          url: "/custom-flow",
          attempt: "1",
          body: '{"runId":"wrun_http"}',
        }),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("graceful close renews its heartbeat until the handler finishes", async () => {
    const { q, config } = setup();
    const gate = held();
    let deliveries = 0;
    q.registerHandler?.(prefix, async () => {
      deliveries++;
      await gate.promise;
      return Response.json({ ok: true });
    });
    await q.start();
    await q.queue(queueName, { runId: "wrun_drain" });
    await wait(() => expect(deliveries).toBe(1));
    let closed = false;
    const closing = q.close().then(() => {
      closed = true;
    });
    const second = setup(config).q;
    second.registerHandler?.(prefix, async () => {
      deliveries++;
      return Response.json({ ok: true });
    });
    await second.start();
    await sleep(1500);
    expect(closed).toBe(false);
    expect(deliveries).toBe(1);
    gate.release();
    await closing;
    expect(await second.getQueueStats()).toMatchObject({
      waiting: 0,
      active: 0,
      delayed: 0,
    });
  });

  test("a failed acknowledgement retires the lease and recovers the claim", async () => {
    const { q } = setup();
    const attempts: string[] = [];
    q.registerHandler?.(prefix, async (req) => {
      attempts.push(req.headers.get("x-vqs-message-attempt")!);
      if (attempts.length === 1)
        vi.spyOn(redis, "eval").mockRejectedValueOnce(
          new Error("injected ACK connection failure"),
        );
      return Response.json({ ok: true });
    });
    await q.start();
    await q.queue(queueName, { runId: "wrun_ack_retry" });
    await wait(() => expect(attempts).toEqual(["1", "2"]));
    await wait(async () =>
      expect(await q.getQueueStats()).toMatchObject({
        waiting: 0,
        active: 0,
        delayed: 0,
      }),
    );
  });

  test("enqueue failures propagate instead of claiming durability", async () => {
    const bad = new Redis(url, { lazyConnect: true });
    bad.disconnect();
    const q = createQueue(bad, resolveConfig({ redis: url }));
    await expect(q.queue(queueName, { runId: "wrun_error" })).rejects.toThrow();
    await q.close();
  });
});
