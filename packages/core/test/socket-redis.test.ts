import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  brick,
  defineService,
  redisBroker,
  resetGlobalRegistry,
  t,
} from "../src";
import { connection, reconnectDelay } from "../src/socket-redis";
import {
  openSocket,
  redisReachable,
  requireService,
  track,
  waitFor,
} from "./helpers";
import { replayScenario } from "./socket-replay";

const url = requireService("REDIS_URL", "redis broker");
if (url && !(await redisReachable(url)))
  throw new Error(`REDIS_URL is set, but no Redis answers at ${url}`);

afterEach(resetGlobalRegistry);

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
  const app = track(
    brick({
      services: [service],
      docs: false,
      requestLogging: false,
      sockets: { broker: redisBroker({ url: url! }) },
    }).listen(0),
  );
  return { live, url: `ws://localhost:${app.server!.port}/api/chat/live` };
}
async function connect(address: string, user: string) {
  const ws = await openSocket(address, { "x-user": user });
  const received: unknown[] = [];
  ws.addEventListener("message", ({ data }) =>
    received.push(JSON.parse(String(data))),
  );
  return { ws, received };
}

describe.skipIf(!url)("redis broker", () => {
  it("delivers emits and kicks from one app to clients of another, once each", async () => {
    const a = process_();
    const b = process_();
    const near = await connect(a.url, "a");
    const far = await connect(b.url, "b");
    const room = `doc:${crypto.randomUUID()}`;
    for (const { ws } of [near, far])
      ws.send(JSON.stringify({ event: "$join", data: { room } }));
    await waitFor(() => near.received.length + far.received.length === 2);
    a.live.emit(room, "message", "hello");
    await waitFor(() => near.received.length + far.received.length === 4);
    // Asserts each client gets it once: give a duplicate time to arrive.
    await Bun.sleep(50);
    for (const { received } of [near, far])
      expect(received).toEqual([
        { event: "$join", data: { room, ok: true } },
        { event: "message", data: "hello" },
      ]);

    a.live.kick(room, { also: "user:b", reason: "gone" });
    await waitFor(() => far.received.length === 3);
    expect(far.received[2]).toEqual({
      event: "$left",
      data: { room, reason: "gone" },
    });
    b.live.emit(room, "message", "after kick");
    await waitFor(() => near.received.length === 3);
    // Asserts the kicked client gets nothing more: give a stray emit time to arrive.
    await Bun.sleep(50);
    expect(near.received[2]).toEqual({ event: "message", data: "after kick" });
    expect(far.received).toHaveLength(3);
  });

  it("resubscribes the rooms it holds after Redis drops the connection", async () => {
    const a = process_();
    const user = `user-${crypto.randomUUID()}`;
    const client = await connect(a.url, user);
    // Emits until one arrives: the subscription settles at an unknown time.
    for (let i = 0; i < 40 && !client.received.length; i++) {
      a.live.emit(`user:${user}`, "message", "before");
      await Bun.sleep(25);
    }
    expect(client.received).not.toHaveLength(0);
    const admin = new Bun.RedisClient(url!);
    try {
      expect(
        await admin.send("CLIENT", ["KILL", "TYPE", "pubsub"]),
      ).toBeGreaterThan(0);
    } finally {
      admin.close();
    }
    const back = { event: "message", data: "back" };
    // Likewise after the drop, while the broker reconnects and resubscribes.
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
    replayScenario(track, redisBroker({ url: url! })));
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
    // Let the first dial fail; the backoff (at least 250 ms) is still running.
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
    await broker.head!("room");
    for (let i = 0; i < 2; i++) {
      broker.publish({ type: "kick", topic: "room" } as any);
      // The publish fails asynchronously; one turn lets its rejection land.
      await Bun.sleep(0);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("PUBLISH failed");
    broker.close!();
  } finally {
    warn.mockRestore();
    bun.RedisClient = original;
  }
});
