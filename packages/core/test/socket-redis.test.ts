import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  brick,
  defineService,
  redisBroker,
  resetGlobalRegistry,
  t,
} from "../src";
import { connection, reconnectDelay } from "../src/socket-redis";
import { replayScenario } from "./socket-replay";

const url = process.env.REDIS_URL ?? "redis://localhost:6379";
const probe = new Bun.RedisClient(url, {
  autoReconnect: false,
  connectionTimeout: 500,
});
const reachable = await probe.connect().then(
  () => true,
  () => false,
);
probe.close();

const apps: ReturnType<typeof brick>[] = [];
const peers: WebSocket[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  for (const app of apps.splice(0)) await app.stop(true);
  resetGlobalRegistry();
});

/** One app with its own broker, as a separate process would have. */
function process_() {
  const service = defineService("chat", {
    context: ({ request }) => ({ user: request.headers.get("x-user") ?? "" }),
  });
  const live = service.socket({
    name: "live",
    input: {},
    output: { message: t.String() },
    allowMissingOrigin: true,
    rooms: ({ ctx }) => [`user:${ctx.user}`],
    join: () => true,
    handlers: {},
  });
  const app = brick({
    services: [service],
    docs: false,
    requestLogging: false,
    sockets: { broker: redisBroker({ url }) },
  }).listen(0);
  apps.push(app);
  return { live, url: `ws://localhost:${app.server!.port}/api/chat/live` };
}
async function connect(address: string, user: string) {
  const ws = new WebSocket(address, { headers: { "x-user": user } });
  peers.push(ws);
  const received: unknown[] = [];
  ws.addEventListener("message", ({ data }) =>
    received.push(JSON.parse(String(data))),
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  return { ws, received };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
}

describe.skipIf(!reachable)("redis broker", () => {
  it("delivers emits and kicks from one app to clients of another, once each", async () => {
    const a = process_();
    const b = process_();
    const near = await connect(a.url, "a");
    const far = await connect(b.url, "b");
    const room = `doc:${crypto.randomUUID()}`;
    for (const { ws } of [near, far])
      ws.send(JSON.stringify({ event: "$join", data: { room } }));
    await until(() => near.received.length + far.received.length === 2);
    a.live.emit(room, "message", "hello");
    await until(() => near.received.length + far.received.length === 4);
    await Bun.sleep(50);
    for (const { received } of [near, far])
      expect(received).toEqual([
        { event: "$join", data: { room, ok: true } },
        { event: "message", data: "hello" },
      ]);

    a.live.kick(room, { also: "user:b", reason: "gone" });
    await until(() => far.received.length === 3);
    expect(far.received[2]).toEqual({
      event: "$left",
      data: { room, reason: "gone" },
    });
    b.live.emit(room, "message", "after kick");
    await until(() => near.received.length === 3);
    await Bun.sleep(50);
    expect(near.received[2]).toEqual({ event: "message", data: "after kick" });
    expect(far.received).toHaveLength(3);
  });

  it("resubscribes the rooms it holds after Redis drops the connection", async () => {
    const a = process_();
    const user = `user-${crypto.randomUUID()}`;
    const client = await connect(a.url, user);
    for (let i = 0; i < 40 && !client.received.length; i++) {
      a.live.emit(`user:${user}`, "message", "before");
      await Bun.sleep(25);
    }
    const admin = new Bun.RedisClient(url);
    try {
      expect(
        await admin.send("CLIENT", ["KILL", "TYPE", "pubsub"]),
      ).toBeGreaterThan(0);
    } finally {
      admin.close();
    }
    const back = { event: "message", data: "back" };
    for (
      let i = 0;
      i < 40 && !Bun.deepEquals(client.received.at(-1), back);
      i++
    ) {
      a.live.emit(`user:${user}`, "message", "back");
      await Bun.sleep(100);
    }
    expect(client.received.at(-1)).toEqual(back);
  });

  it("replays missed emits from the Redis stream", () =>
    replayScenario((app) => apps.push(app), redisBroker({ url })));
});

it("backs off Redis reconnects exponentially, capped at 30 s", () => {
  for (const [failures, low, high] of [
    [0, 250, 500],
    [3, 2000, 4000],
    [20, 15_000, 30_000],
  ])
    for (let i = 0; i < 20; i++) {
      const delay = reconnectDelay(failures!);
      expect(delay).toBeGreaterThanOrEqual(low!);
      expect(delay).toBeLessThanOrEqual(high!);
    }
});

it("waits out the backoff instead of dialing Redis on every get()", async () => {
  const bun = Bun as any;
  const original = bun.RedisClient;
  let dials = 0;
  bun.RedisClient = class extends original {
    constructor(...args: any[]) {
      super(...args);
      dials++;
    }
  };
  try {
    // Nothing listens on port 1, so every connection fails.
    const redis = connection("redis://127.0.0.1:1", () => {});
    redis.get();
    await Bun.sleep(50);
    for (let i = 0; i < 100; i++) redis.get();
    expect(dials).toBe(1);
    redis.close();
  } finally {
    bun.RedisClient = original;
  }
});

it("logs a failed publish once, and keeps going", async () => {
  const bun = Bun as any;
  const original = bun.RedisClient;
  bun.RedisClient = class {
    connected = false;
    onclose?: () => void;
    async connect() {
      this.connected = true;
    }
    async publish() {
      throw new Error("READONLY");
    }
    close() {}
  };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const broker = redisBroker({ url: "redis://fake" });
    await broker.head();
    for (let i = 0; i < 2; i++) {
      broker.publish({ type: "kick", topic: "room" } as any);
      await Bun.sleep(0);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("PUBLISH failed");
    broker.close();
  } finally {
    warn.mockRestore();
    bun.RedisClient = original;
  }
});
