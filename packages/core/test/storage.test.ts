import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  brick,
  definePlugin,
  defineService,
  defineStorage,
  memory,
  redis,
  resetGlobalRegistry,
  StorageUnavailableError,
  t,
  type KeyValueDriver,
  type StorageDriver,
} from "../src";
import { serviceStorage } from "../src/storage";
import { redisReachable, requireService, waitFor } from "./helpers";

const url = requireService("REDIS_URL", "redis storage");
if (url && !(await redisReachable(url)))
  throw new Error(`REDIS_URL is set, but no Redis answers at ${url}`);

beforeEach(resetGlobalRegistry);

function suite(name: string, driver: () => KeyValueDriver, skip = false) {
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

    it("putIfAbsent keeps the stored value and says whether this call stored it", async () => {
      const k = key("once");
      expect(await storage.putIfAbsent(k, "first", 1000)).toEqual({
        stored: true,
        value: "first",
      });
      expect(await storage.putIfAbsent(k, "second", 1000)).toEqual({
        stored: false,
        value: "first",
      });
      expect(await storage.get(k)).toBe("first");
      const racers = await Promise.all(
        Array.from({ length: 20 }, () =>
          storage.putIfAbsent(`${k}:race`, "pending", 1000),
        ),
      );
      expect(racers.filter((racer) => racer.stored)).toHaveLength(1);
      expect(racers.every((racer) => racer.value === "pending")).toBe(true);
      const short = key("once-ttl");
      await storage.putIfAbsent(short, "a", 30);
      await Bun.sleep(60);
      expect(await storage.putIfAbsent(short, "b", 1000)).toEqual({
        stored: true,
        value: "b",
      });
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

    it("refuses to count a value that is not an integer", async () => {
      for (const value of ["", " 5 ", "1e3", "0x10", "05", "1.5"]) {
        const k = key("not-counter");
        await storage.put(k, value, 1000);
        const error = await storage.increment(k, 1000).catch((e) => e);
        expect(error.constructor).toBe(Error);
        expect(error.message).toBe(
          `Storage: "app:${k}" does not hold a counter`,
        );
        expect(await storage.get(k)).toBe(value);
      }
      const k = key("counter");
      await storage.put(k, "-3", 1000);
      expect((await storage.increment(k, 1000)).count).toBe(-2);
    });

    it("refuses a ttlMs that is not a positive integer", async () => {
      await expect(storage.put(key("bad"), "v", 1e21)).rejects.toThrow(
        "ttlMs must be a positive integer",
      );
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

  it("counts one storage under two names once, and searches the deps it is given", async () => {
    const cache = defineStorage({ driver: memory() });
    const service = defineService("dup", { deps: { cache, sessions: cache } });
    const own = serviceStorage(service)!;
    expect(own).toBeDefined();
    const fake = defineStorage({ driver: memory() });
    expect(() =>
      serviceStorage(service, { cache: fake, sessions: cache }),
    ).toThrow('has two key-value storages in its deps, "cache" and "sessions"');
    const only = serviceStorage(service, { cache: fake })!;
    await only.put("k", "fake");
    await own.put("k", "real");
    expect(await only.get("k")).toBe("fake");
  });

  it("recognises a StorageUnavailableError thrown by another copy of core", async () => {
    const copy = "../src/storage?another-copy";
    const other: typeof import("../src/storage") = await import(copy);
    expect(other.StorageUnavailableError).not.toBe(StorageUnavailableError);
    expect(new other.StorageUnavailableError("x")).toBeInstanceOf(
      StorageUnavailableError,
    );
    expect(new Error("x")).not.toBeInstanceOf(StorageUnavailableError);
    class Narrower extends StorageUnavailableError {}
    expect(new StorageUnavailableError("x")).not.toBeInstanceOf(Narrower);
    expect(new Narrower("x")).toBeInstanceOf(Narrower);
    expect(new Narrower("x")).toBeInstanceOf(StorageUnavailableError);
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

  it("logs, and does not leave unhandled, a storage that fails to close after a plugin fails to start", async () => {
    const cache = defineStorage({
      driver: {
        ...memory(),
        close: async () => {
          throw new Error("close failed");
        },
      },
    });
    const broken = definePlugin({
      name: "@acme/broken",
      app: ({ on }) =>
        on("start", () => {
          throw new Error("no connection");
        }),
    });
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", record);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = brick({
        services: [defineService("failing", { deps: { cache } })],
        docs: false,
        requestLogging: false,
        plugins: [broken()],
      }).listen(0);
      await waitFor(() => !app.server);
      await waitFor(() => logged.mock.calls.length >= 2);
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
      logged.mockRestore();
    }
  });

  it("closes a storage two apps share when the last of them stops, after the plugins' stop handlers", async () => {
    let closed = 0;
    const counting = () => ({ ...memory(), close: async () => void closed++ });
    const cache = defineStorage({ driver: counting() });
    const outbox = defineStorage({ driver: counting() });
    let closedAtStop = -1;
    const flush = definePlugin({
      name: "@acme/flush",
      deps: { outbox },
      service: () => {},
      app: ({ on }) =>
        on("stop", () => {
          closedAtStop = closed;
        }),
    });
    const service = defineService("shared", { deps: { cache } });
    service.use(flush({}, { deps: { outbox } }));
    const count = service.action({
      name: "count",
      output: t.Number(),
      execute: async ({ ctx }) => {
        await Bun.sleep(20);
        return (await ctx.deps.cache.increment("hits", 60_000)).count;
      },
    });
    const options = { services: [service], docs: false, requestLogging: false };
    const a = brick(options).listen(0);
    const b = brick(options).listen(0);
    const calls = Array.from({ length: 20 }, () => count.execute({}));
    await a.stop();
    expect(await Promise.all(calls)).toHaveLength(20);
    expect(closed).toBe(0);
    await b.stop();
    expect(closedAtStop).toBe(0);
    expect(closed).toBe(2);
    await Promise.resolve(b.stop()).catch(() => undefined);
    expect(closed).toBe(2);
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
      expect(error.cause).toBeDefined();
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

describe("redis driver, failing", () => {
  it("rejects with StorageUnavailableError when closed while a call waits to connect", async () => {
    const storage = defineStorage({
      driver: redis({ url: "redis://127.0.0.1:1" }),
    });
    const pending = storage.get("k").catch((e) => e);
    await Bun.sleep(20);
    await storage.close();
    expect(await pending).toBeInstanceOf(StorageUnavailableError);
  });

  it("times out a command Redis doesn't answer, and reconnects for the next", async () => {
    let connections = 0;
    const frozen = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open: () => void connections++,
        data(socket, data) {
          if (data.toString().includes("HELLO"))
            socket.write("%1\r\n+server\r\n+redis\r\n");
        },
      },
    });
    const storage = defineStorage({
      driver: redis({ url: `redis://127.0.0.1:${frozen.port}` }),
    });
    try {
      const started = Date.now();
      const error = await storage.get("k").catch((e) => e);
      expect(error).toBeInstanceOf(StorageUnavailableError);
      expect(Date.now() - started).toBeLessThan(1500);
      await expect(storage.put("k", "v")).rejects.toBeInstanceOf(
        StorageUnavailableError,
      );
      expect(connections).toBe(2);
    } finally {
      await storage.close();
      frozen.stop(true);
    }
  });
});

describe.skipIf(!url)("redis driver, prefix", () => {
  it("keeps two prefixes on one database apart, Brick's keys included", async () => {
    const a = defineStorage({ driver: redis({ url, prefix: "a:" }) });
    const b = defineStorage({ driver: redis({ url, prefix: "b:" }) });
    const k = `prefixed:${crypto.randomUUID()}`;
    const brickSide = (storage: typeof a) =>
      serviceStorage(
        defineService(`p_${crypto.randomUUID().slice(0, 8)}`, {
          deps: { storage },
        }),
      )!;
    try {
      await a.put(k, "a", 5000);
      await brickSide(a).put(k, "brick-a", 5000);
      expect(await b.get(k)).toBeNull();
      expect(await brickSide(b).get(k)).toBeNull();
      expect(await a.get(k)).toBe("a");
      expect(await brickSide(a).get(k)).toBe("brick-a");
      const raw = new Bun.RedisClient(url);
      expect(await raw.get(`a:app:${k}`)).toBe("a");
      expect(await raw.get(`a:brick:storage:${k}`)).toBe("brick-a");
      raw.close();
    } finally {
      await a.delete(k);
      await brickSide(a).delete(k);
      await a.close();
      await b.close();
    }
  });
});
