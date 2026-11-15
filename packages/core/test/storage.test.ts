import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  brick,
  defineService,
  defineStorage,
  memory,
  redis,
  resetGlobalRegistry,
  StorageUnavailableError,
  t,
  type StorageDriver,
} from "../src";
import { serviceStorage } from "../src/storage";
import { redisReachable, requireService } from "./helpers";

const url = requireService("REDIS_URL", "redis storage");
if (url && !(await redisReachable(url)))
  throw new Error(`REDIS_URL is set, but no Redis answers at ${url}`);

beforeEach(resetGlobalRegistry);

/** The same behaviour from every key-value driver. */
function suite(name: string, driver: () => StorageDriver, skip = false) {
  describe.skipIf(skip)(`${name} storage`, () => {
    const storage = defineStorage({ driver: driver() });
    const key = (label: string) => `${label}:${crypto.randomUUID()}`;
    afterAll(() => storage.close());

    it("puts, gets and deletes", async () => {
      const k = key("plain");
      expect(await storage.get(k)).toBeNull();
      await storage.put(k, "v1");
      expect(await storage.get(k)).toBe("v1");
      await storage.put(k, "v2");
      expect(await storage.get(k)).toBe("v2");
      await storage.delete(k);
      expect(await storage.get(k)).toBeNull();
    });

    it("expires a value after ttlMs", async () => {
      const k = key("ttl");
      await storage.put(k, "v", 30);
      expect(await storage.get(k)).toBe("v");
      await Bun.sleep(60);
      expect(await storage.get(k)).toBeNull();
    });

    it("putIfAbsent keeps the stored value and returns it", async () => {
      const k = key("once");
      expect(await storage.putIfAbsent(k, "first", 1000)).toBe("first");
      expect(await storage.putIfAbsent(k, "second", 1000)).toBe("first");
      expect(await storage.get(k)).toBe("first");
      const racers = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          storage.putIfAbsent(`${k}:race`, `v${i}`, 1000),
        ),
      );
      expect(new Set(racers).size).toBe(1);
      const short = key("once-ttl");
      await storage.putIfAbsent(short, "a", 30);
      await Bun.sleep(60);
      expect(await storage.putIfAbsent(short, "b", 1000)).toBe("b");
    });

    it("increments atomically and expires ttlMs after the first hit", async () => {
      const k = key("count");
      const counts = await Promise.all(
        Array.from({ length: 50 }, () => storage.increment(k, 1000)),
      );
      expect(counts.map((c) => c.count).toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: 50 }, (_, i) => i + 1),
      );
      for (const { expiresInMs } of counts) {
        expect(expiresInMs).toBeGreaterThan(0);
        expect(expiresInMs).toBeLessThanOrEqual(1000);
      }
      const short = key("count-ttl");
      await storage.increment(short, 30);
      await Bun.sleep(60);
      expect((await storage.increment(short, 30)).count).toBe(1);
    });

    it("gives a counter an expiry even when its key had none", async () => {
      const k = key("no-ttl");
      await storage.put(k, "5");
      const counter = await storage.increment(k, 1000);
      expect(counter.count).toBe(6);
      expect(counter.expiresInMs).toBeGreaterThan(0);
      expect(counter.expiresInMs).toBeLessThanOrEqual(1000);
    });

    it("refuses a ttlMs that is not a positive integer", async () => {
      await expect(storage.increment(key("bad"), 0)).rejects.toThrow(
        "ttlMs must be a positive integer",
      );
      await expect(storage.put(key("bad"), "v", 1.5)).rejects.toThrow(
        "ttlMs must be a positive integer",
      );
    });

    it("keeps Brick's keys and the app's keys apart", async () => {
      const service = defineService(`kv_${crypto.randomUUID().slice(0, 8)}`, {
        deps: { storage },
      });
      const brickSide = serviceStorage(service)!;
      const k = key("shared");
      await storage.put(k, "app");
      await brickSide.put(k, "brick");
      expect(await storage.get(k)).toBe("app");
      expect(await brickSide.get(k)).toBe("brick");
      // No app key reaches Brick's, whatever it is called.
      expect(await storage.get(`../brick:storage:${k}`)).toBeNull();
      await storage.delete(k);
      expect(await brickSide.get(k)).toBe("brick");
      await brickSide.delete(k);
    });
  });
}

suite("memory", memory);
suite("redis", () => redis({ url }), !url);

describe("defineStorage", () => {
  it("is a dep, typed as ctx.deps.<name>", async () => {
    const cache = defineStorage({ driver: memory() });
    const auth = defineService("auth", { deps: { cache } });
    const send = auth.action({
      name: "send",
      input: t.Object({ email: t.String() }),
      output: t.String(),
      execute: async ({ input, ctx }) => {
        await ctx.deps.cache.put(`otp:${input.email}`, "123456", 60_000);
        return (await ctx.deps.cache.get(`otp:${input.email}`)) ?? "";
      },
    });
    expect(await send.execute({ input: { email: "a@b.c" } })).toBe("123456");
    // Deps stay out of the service schema.
    expect(auth.introspect().options).toEqual({});
  });

  it("refuses something that is not a driver", () => {
    expect(() => defineStorage({ driver: {} as StorageDriver })).toThrow(
      "defineStorage needs a driver",
    );
  });

  it("names the service and both deps when a service has two key-value storages", () => {
    const one = defineStorage({ driver: memory() });
    const two = defineStorage({ driver: memory() });
    const service = defineService("twice", { deps: { one, two } });
    expect(() => serviceStorage(service)).toThrow(
      'Service "twice" has two key-value storages in its deps, "one" and "two"',
    );
    expect(serviceStorage(defineService("none"))).toBeUndefined();
  });

  it("closes storages when the app stops", async () => {
    let closed = 0;
    const driver = { ...memory(), close: async () => void closed++ };
    const cache = defineStorage({ driver });
    const app = brick({
      services: [defineService("closing", { deps: { cache } })],
      docs: false,
      requestLogging: false,
    }).listen(0);
    await app.stop();
    expect(closed).toBe(1);
  });
});

describe("redis driver", () => {
  it("does not connect when defined, only on first use", async () => {
    const original = Bun.RedisClient;
    let made = 0;
    (Bun as any).RedisClient = class extends original {
      constructor(...args: ConstructorParameters<typeof original>) {
        super(...args);
        made++;
      }
    };
    try {
      const storage = defineStorage({
        driver: redis({ url: "redis://127.0.0.1:1" }),
      });
      defineService("lazy", { deps: { storage } });
      expect(made).toBe(0);
      await storage.get("k").catch(() => undefined);
      expect(made).toBeGreaterThan(0);
      await storage.close();
    } finally {
      (Bun as any).RedisClient = original;
    }
  });

  it("rejects with StorageUnavailableError when Redis is unreachable, then at once", async () => {
    const storage = defineStorage({
      driver: redis({ url: "redis://127.0.0.1:1" }),
    });
    try {
      const first = Date.now();
      const error = await storage.increment("k", 1000).catch((e) => e);
      expect(error).toBeInstanceOf(StorageUnavailableError);
      expect(Date.now() - first).toBeLessThan(1500);
      const second = Date.now();
      await expect(storage.get("k")).rejects.toBeInstanceOf(
        StorageUnavailableError,
      );
      expect(Date.now() - second).toBeLessThan(50);
    } finally {
      await storage.close();
    }
  });
});
