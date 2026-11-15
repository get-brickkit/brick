import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
  spyOn,
} from "bun:test";
import {
  ActionExecutionError,
  brick,
  clientAddress,
  compileBrickApplication,
  createMcpHandler,
  createMcpRegistry,
  defineAction,
  defineDatabase,
  definePlugin,
  defineService,
  defineStorage,
  memory,
  redis,
  resetGlobalRegistry,
  StorageUnavailableError,
  syncSchema,
  t,
  useService,
  type BrickApp,
  type KeyValueDriver,
  type RateLimit,
} from "../src";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createTestApp } from "../src/testing";
import { postJson, redisReachable, requireService } from "./helpers";

const url = requireService("REDIS_URL", "redis rate limits");
if (url && !(await redisReachable(url)))
  throw new Error(`REDIS_URL is set, but no Redis answers at ${url}`);

beforeEach(resetGlobalRegistry);

const cache = () => defineStorage({ driver: memory() });

function limited(
  rateLimit: RateLimit | RateLimit[],
  options: { storage?: ReturnType<typeof cache>; extra?: object } = {},
) {
  const service = defineService("auth", {
    deps: { cache: options.storage ?? cache() },
  });
  const action = service.action({
    name: "login",
    input: t.Object({ email: t.String() }),
    rateLimit,
    execute: () => ({ ok: true }),
    ...options.extra,
  });
  return { service, action };
}

const login = (app: BrickApp, email = "a@b.c", headers = {}) =>
  postJson(app, "/api/auth/login", { email }, headers);

function suite(name: string, driver: () => KeyValueDriver, skip = false) {
  describe.skipIf(skip)(`rate limits on ${name}`, () => {
    let storage: ReturnType<typeof cache>;
    beforeEach(() => {
      storage = defineStorage({ driver: driver() });
    });
    afterEach(() => storage.close());

    it("refuses the call after max with 429, Retry-After and the error envelope", async () => {
      const { service } = limited(
        { per: () => "k", max: 3, windowMs: 60_000 },
        { storage },
      );
      const app = brick({ services: [service], requestLogging: false });
      for (let i = 0; i < 3; i++) expect((await login(app)).status).toBe(200);
      const refused = await login(app);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("60");
      expect(await refused.json()).toMatchObject({
        name: "ActionExecutionError",
        code: "RATE_LIMITED",
        status: 429,
        details: { retryAfterSeconds: 60 },
        requestId: expect.any(String),
      });
    });

    it("lets calls through again once the window ends", async () => {
      const { service } = limited(
        { per: () => "k", max: 1, windowMs: 200 },
        { storage },
      );
      const app = brick({ services: [service], requestLogging: false });
      expect((await login(app)).status).toBe(200);
      const refused = await login(app);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("1");
      await Bun.sleep(250);
      expect((await login(app)).status).toBe(200);
    });

    it("refuses at the first entry over its max", async () => {
      const { service } = limited(
        [
          { per: () => "k", max: 1, windowMs: 60_000 },
          { per: () => "k", max: 1, windowMs: 3_600_000 },
        ],
        { storage },
      );
      const app = brick({ services: [service], requestLogging: false });
      expect((await login(app)).status).toBe(200);
      const refused = await login(app);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("retry-after")).toBe("60");
    });

    it("lets exactly max of many concurrent calls through", async () => {
      const { service } = limited(
        { per: () => "k", max: 5, windowMs: 60_000 },
        { storage },
      );
      const app = brick({ services: [service], requestLogging: false });
      const statuses = await Promise.all(
        Array.from({ length: 40 }, () => login(app).then((r) => r.status)),
      );
      expect(statuses.filter((status) => status === 200)).toHaveLength(5);
      expect(statuses.filter((status) => status === 429)).toHaveLength(35);
    });

    it("hashes a key part longer than 128 characters", async () => {
      const raw = driver() as KeyValueDriver;
      const keys: string[] = [];
      const recorded = defineStorage({
        driver: {
          ...raw,
          increment: (key, ttlMs) => (
            keys.push(key),
            raw.increment(key, ttlMs)
          ),
        },
      });
      try {
        const { service } = limited(
          [
            { per: ({ input }) => input.email, max: 1, windowMs: 60_000 },
            { per: "ip", max: 5, windowMs: 60_000 },
          ],
          { storage: recorded },
        );
        const app = brick({
          services: [service],
          requestLogging: false,
          clientIp: ({ request }) => request.headers.get("x-ip") ?? undefined,
        });
        const huge = "a".repeat(1_000_000);
        const via = { "x-ip": `not-an-address-${"b".repeat(1000)}` };
        expect((await login(app, huge, via)).status).toBe(200);
        expect((await login(app, huge, via)).status).toBe(429);
        expect((await login(app, `${huge}b`, via)).status).toBe(200);
        expect(keys).toHaveLength(5);
        for (const key of keys) expect(key.length).toBeLessThan(200);
      } finally {
        await recorded.close();
      }
    });
  });
}

suite("memory", memory);
const runPrefix = `brick-test-rate-limit-${crypto.randomUUID()}-`;
suite(
  "redis",
  () => redis({ url, prefix: `${runPrefix}${crypto.randomUUID()}:` }),
  !url,
);
if (url)
  afterAll(async () => {
    const client = new Bun.RedisClient(url);
    const keys: string[] = await client.send("KEYS", [`${runPrefix}*`]);
    if (keys.length) await client.send("DEL", keys);
    client.close();
  });

describe("rate limits", () => {
  it("does not count a malformed call, and counts one authorize refuses", async () => {
    const { service } = limited(
      { per: () => "k", max: 2, windowMs: 60_000 },
      { extra: { authorize: () => false } },
    );
    const app = brick({ services: [service], requestLogging: false });
    for (let i = 0; i < 5; i++)
      expect((await postJson(app, "/api/auth/login", {})).status).toBe(400);
    expect((await login(app)).status).toBe(401);
    expect((await login(app)).status).toBe(401);
    expect((await login(app)).status).toBe(429);
  });

  it("keys by the custom function, and skips the limit when it returns null or undefined", async () => {
    const { service } = limited({
      per: ({ input }) =>
        input.email === "skip"
          ? null
          : input.email === "none"
            ? undefined
            : input.email,
      max: 1,
      windowMs: 60_000,
    });
    const app = brick({ services: [service], requestLogging: false });
    expect((await login(app, "a")).status).toBe(200);
    expect((await login(app, "b")).status).toBe(200);
    expect((await login(app, "a")).status).toBe(429);
    for (let i = 0; i < 3; i++) {
      expect((await login(app, "skip")).status).toBe(200);
      expect((await login(app, "none")).status).toBe(200);
    }
  });

  it("keeps keys with separators and newlines apart, and each action and entry apart", async () => {
    const storage = cache();
    const service = defineService("auth", { deps: { cache: storage } });
    const per = ({ input }: { input: { email: string } }) => input.email;
    for (const name of ["login", "login:0"])
      service.action({
        name,
        input: t.Object({ email: t.String() }),
        rateLimit: [
          { per, max: 1, windowMs: 60_000 },
          { per, max: 1, windowMs: 60_000 },
        ],
        execute: () => ({ ok: true }),
      });
    const app = brick({ services: [service], requestLogging: false });
    for (const email of ["a:b", "a", "b", "a\nb", 'a","b', "a\\", "0"])
      expect((await login(app, email)).status).toBe(200);
    expect((await login(app, "1:x")).status).toBe(200);
    expect(
      (await postJson(app, "/api/auth/login:0", { email: "x" })).status,
    ).toBe(200);
    expect(
      (await postJson(app, "/api/auth/login:0", { email: "a:b" })).status,
    ).toBe(200);
    expect((await login(app, "a:b")).status).toBe(429);
  });

  it("an app can refuse a call itself with error.RATE_LIMITED", async () => {
    const service = defineService("auth");
    service.action({
      name: "login",
      execute: ({ error }) =>
        error.RATE_LIMITED(undefined, { retryAfterSeconds: 7 }),
    });
    const app = brick({ services: [service], requestLogging: false });
    const refused = await postJson(app, "/api/auth/login");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("7");
    expect((await refused.json()).message).toBe("Too Many Requests");
  });
});

describe('per: "ip"', () => {
  let app: BrickApp | undefined;
  afterEach(async () => {
    await app?.stop(true);
    app = undefined;
  });
  const listen = (options: Parameters<typeof brick>[0]) => {
    app = brick({ requestLogging: false, ...options });
    app.listen(0);
    const base = `http://localhost:${app.server!.port}`;
    return (headers: Record<string, string> = {}) =>
      fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email: "a@b.c" }),
      });
  };

  it("counts by the socket peer, and never by X-Forwarded-For", async () => {
    const { service } = limited({ per: "ip", max: 2, windowMs: 60_000 });
    const call = listen({ services: [service] });
    expect((await call({ "x-forwarded-for": "1.1.1.1" })).status).toBe(200);
    expect((await call({ "x-forwarded-for": "2.2.2.2" })).status).toBe(200);
    expect((await call({ "x-forwarded-for": "3.3.3.3" })).status).toBe(429);
  });

  it("counts by the address clientIp returns", async () => {
    const { service } = limited({ per: "ip", max: 1, windowMs: 60_000 });
    const peers: (string | undefined)[] = [];
    const call = listen({
      services: [service],
      clientIp: ({ request, peer }) => {
        peers.push(peer);
        return request.headers.get("fly-client-ip") ?? peer;
      },
    });
    expect((await call({ "fly-client-ip": "1.1.1.1" })).status).toBe(200);
    expect((await call({ "fly-client-ip": "2.2.2.2" })).status).toBe(200);
    expect((await call({ "fly-client-ip": "1.1.1.1" })).status).toBe(429);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
    expect(peers[0]).toMatch(/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/);
  });

  it("counts by clientIp through app.handle, where there is no peer", async () => {
    const { service } = limited({ per: "ip", max: 1, windowMs: 60_000 });
    const peers: (string | undefined)[] = [];
    const handled = brick({
      services: [service],
      requestLogging: false,
      clientIp: ({ request, peer }) => {
        peers.push(peer);
        return request.headers.get("fly-client-ip") ?? undefined;
      },
    });
    const via = { "fly-client-ip": "1.1.1.1" };
    expect((await login(handled, "a", via)).status).toBe(200);
    expect((await login(handled, "a", via)).status).toBe(429);
    expect((await login(handled)).status).toBe(200);
    expect((await login(handled)).status).toBe(200);
    expect(peers).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("is skipped without an address: in-process, and through app.handle", async () => {
    const { service, action } = limited({
      per: "ip",
      max: 1,
      windowMs: 60_000,
    });
    const handled = brick({ services: [service], requestLogging: false });
    for (let i = 0; i < 3; i++) {
      expect((await login(handled)).status).toBe(200);
      expect(await action.run({ email: "a" })).toEqual({ ok: true });
    }
  });
});

describe('per: "actor"', () => {
  const crm = (storage = cache()) =>
    defineService("crm", {
      deps: { cache: storage },
      context: ({ request }) => ({
        user: request?.headers.get("x-user") ?? undefined,
      }),
      identity: (ctx) => (ctx.user ? { id: ctx.user } : null),
    });

  it("counts each actor apart, and an anonymous caller by IP", async () => {
    const service = crm();
    service.action({
      name: "export",
      rateLimit: { per: "actor", max: 1, windowMs: 60_000 },
      execute: () => "ok",
    });
    const app = brick({ services: [service], requestLogging: false });
    app.listen(0);
    try {
      const call = (user?: string) =>
        fetch(`http://localhost:${app.server!.port}/api/crm/export`, {
          method: "POST",
          headers: user ? { "x-user": user } : {},
        });
      expect((await call("u1")).status).toBe(200);
      expect((await call("u2")).status).toBe(200);
      expect((await call("u1")).status).toBe(429);
      expect((await call()).status).toBe(200);
      expect((await call()).status).toBe(429);
      expect((await call("::1")).status).toBe(200);
      expect((await call("127.0.0.1")).status).toBe(200);
    } finally {
      await app.stop(true);
    }
  });

  it("counts in-process calls", async () => {
    const service = crm();
    const exportAll = service.action({
      name: "export",
      rateLimit: { per: "actor", max: 2, windowMs: 60_000 },
      execute: () => "ok",
    });
    service.action({
      name: "relay",
      execute: ({ ctx }) => exportAll.run(undefined, ctx),
    });
    const app = brick({
      services: [service],
      requestLogging: false,
      clientIp: ({ request }) => request.headers.get("x-ip") ?? undefined,
    });
    const ctx = {
      request: new Request("http://x", { headers: { "x-user": "u1" } }),
    };
    expect(await exportAll.run(undefined, ctx)).toBe("ok");
    expect(await exportAll.run(undefined, ctx)).toBe("ok");
    const refused = await exportAll.run(undefined, ctx).catch((error) => error);
    expect(refused).toBeInstanceOf(ActionExecutionError);
    expect(refused).toMatchObject({ code: "RATE_LIMITED", status: 429 });
    const relay = () =>
      postJson(app, "/api/crm/relay", {}, { "x-ip": "1.1.1.1" });
    expect((await relay()).status).toBe(200);
    expect((await relay()).status).toBe(200);
    expect((await relay()).status).toBe(429);
    for (let i = 0; i < 3; i++) expect(await exportAll.run()).toBe("ok");
  });
});

describe("rate limits in-process", () => {
  it("counts a custom key, through useService, and in the storage the call's deps swap in", async () => {
    const { service, action } = limited({
      per: () => "k",
      max: 1,
      windowMs: 60_000,
    });
    brick({ services: [service], requestLogging: false });
    expect(await useService(service).login({ email: "a" })).toEqual({
      ok: true,
    });
    await expect(action.run({ email: "a" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
    const fresh = cache();
    expect(
      await action.run({ email: "a" }, { deps: { cache: fresh } }),
    ).toEqual({
      ok: true,
    });
    await expect(
      action.run({ email: "a" }, { deps: { cache: fresh } }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("rate limits at startup", () => {
  it("refuses an action whose service has no key-value storage", () => {
    const service = defineService("auth");
    service.action({
      name: "login",
      rateLimit: { per: () => "k", max: 1, windowMs: 1000 },
      execute: () => "ok",
    });
    expect(() => brick({ services: [service] })).toThrow(
      `Service "auth": action 'login' declares rateLimit, but the service has no key-value storage to count in. Add one: defineService("auth", { deps: { cache: defineStorage({ driver: redis() }) } }).`,
    );
  });

  it('refuses per: "actor" on a service without identity', () => {
    const { service } = limited({ per: "actor", max: 1, windowMs: 1000 });
    expect(() => brick({ services: [service] })).toThrow(
      `Service "auth": action 'login' limits per "actor", but the service declares no identity.`,
    );
  });

  it("refuses a limit without a positive integer max and windowMs, or a known per", () => {
    for (const rateLimit of [
      { per: "ip", max: 0, windowMs: 1000 },
      { per: "ip", max: 1, windowMs: 1.5 },
      { per: "user", max: 1, windowMs: 1000 },
    ])
      expect(() =>
        defineAction({
          name: "a",
          rateLimit: rateLimit as RateLimit,
          execute: () => 1,
        }),
      ).toThrow("Action 'a': each rateLimit needs per");
  });
});

describe("rate limits while the storage is down", () => {
  it("counts in process memory, keeps those counts when the storage is back, and warns once each way", async () => {
    const real = memory();
    let down = false;
    const flaky: KeyValueDriver = {
      ...real,
      increment: async (key, ttlMs) => {
        if (down)
          throw new StorageUnavailableError("Storage: Redis is unreachable");
        return real.increment(key, ttlMs);
      },
    };
    const { service } = limited(
      { per: () => "k", max: 2, windowMs: 600_000 },
      { storage: defineStorage({ driver: flaky }) },
    );
    const app = brick({ services: [service], requestLogging: false });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    let now = Date.now();
    const after = (ms: number) => setSystemTime((now += ms));
    after(0);
    try {
      expect((await login(app)).status).toBe(200);
      down = true;
      expect((await login(app)).status).toBe(200);
      expect((await login(app)).status).toBe(200);
      expect((await login(app)).status).toBe(429);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(
        "counting in this process's memory",
      );
      down = false;
      after(1_000);
      expect((await login(app)).status).toBe(429);
      after(5_000);
      expect((await login(app)).status).toBe(429);
      expect(warn).toHaveBeenCalledTimes(1);
      after(5_000);
      expect((await login(app)).status).toBe(429);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]![0])).toContain("storage is back");
      down = true;
      expect((await login(app)).status).toBe(429);
      expect(warn).toHaveBeenCalledTimes(3);
    } finally {
      setSystemTime();
      warn.mockRestore();
    }
  });

  it("holds about twice max on a storage that flaps", async () => {
    const real = memory();
    let up = (_at: number) => true;
    const flapping: KeyValueDriver = {
      ...real,
      increment: async (key, ttlMs) => {
        if (!up(Date.now()))
          throw new StorageUnavailableError("Storage: Redis is unreachable");
        return real.increment(key, ttlMs);
      },
    };
    const { service, action } = limited(
      { per: () => "k", max: 5, windowMs: 3_600_000 },
      { storage: defineStorage({ driver: flapping }) },
    );
    brick({ services: [service], requestLogging: false });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const start = Date.now();
    up = (at) => {
      const t = (at - start) % 60_000;
      return t > 30_000 && t < 50_000 ? true : t % 3_000 < 1_000;
    };
    let passed = 0;
    try {
      for (let i = 0; i < 2_000; i++) {
        setSystemTime(start + i * 100);
        await action.run({ email: "a" }).then(
          () => passed++,
          (error) => expect(error.code).toBe("RATE_LIMITED"),
        );
      }
      expect(passed).toBeGreaterThanOrEqual(5);
      expect(passed).toBeLessThanOrEqual(10);
      expect(warn.mock.calls.length).toBe(7);
    } finally {
      setSystemTime();
      warn.mockRestore();
    }
  });

  it("fails the call on any other storage error", async () => {
    const flaky: KeyValueDriver = {
      ...memory(),
      increment: async () => {
        throw new Error("boom");
      },
    };
    const { service } = limited(
      { per: () => "k", max: 2, windowMs: 60_000 },
      { storage: defineStorage({ driver: flaky }) },
    );
    const app = brick({ services: [service], requestLogging: false });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await login(app)).status).toBe(500);
    } finally {
      error.mockRestore();
    }
  });
});

describe("rate limits elsewhere", () => {
  it("keeps an action without rateLimit on the synchronous path; one with it is asynchronous", () => {
    const service = defineService("s", { deps: { cache: cache() } });
    service.action({ name: "plain", execute: () => "ok" });
    service.action({
      name: "limited",
      rateLimit: { per: () => "k", max: 1, windowMs: 1000 },
      execute: () => "ok",
    });
    const { routes } = compileBrickApplication({ services: [service] });
    const call = (action: string) =>
      routes
        .find((route) => route.ir.action === action)!
        .handler({ set: { headers: {} }, headers: {} });
    expect(call("plain")).toBe("ok");
    expect(call("limited")).toBeInstanceOf(Promise);
  });

  it("is described in introspect() and OpenAPI, without its key", () => {
    const { service } = limited([
      { per: "ip", max: 20, windowMs: 60_000 },
      { per: () => "k", max: 5, windowMs: 900_000 },
    ]);
    const app = brick({ services: [service], requestLogging: false });
    expect(service.introspect().actions[0]!.rateLimit).toEqual([
      { max: 20, windowMs: 60_000 },
      { max: 5, windowMs: 900_000 },
    ]);
    const operation = (app.openApiDocument() as any).paths["/api/auth/login"]
      .post;
    expect(operation.responses["429"].headers["Retry-After"]).toBeDefined();
    expect(
      JSON.stringify(operation.responses["429"].content["application/json"]),
    ).toContain("RATE_LIMITED");
  });

  it("limits resource actions and commands", async () => {
    const things = sqliteTable("things", {
      id: text("id").primaryKey(),
      state: text("state").notNull(),
    });
    const database = defineDatabase({ tables: { things } });
    syncSchema([things], database.getDb() as any);
    (database.getDb() as any)
      .insert(things)
      .values({ id: "t1", state: "new" })
      .run();
    const service = defineService("s", { database, deps: { cache: cache() } });
    const thing = service.resource({ name: "thing", table: things });
    const limit = { per: () => "k", max: 1, windowMs: 60_000 };
    thing.action({ name: "count", rateLimit: limit, execute: () => 1 });
    thing.command("touch", {
      access: "public",
      rateLimit: { ...limit, per: ({ input }) => String(input.id) },
      decide: () => ({ set: { state: "touched" } }),
    });
    const app = brick({ services: [service], requestLogging: false });
    for (const path of ["/api/s/thing/count", "/api/s/thing/t1/touch"]) {
      expect((await postJson(app, path)).status).toBe(200);
      expect((await postJson(app, path)).status).toBe(429);
    }
  });

  it("limits tools, and the typed client sees RATE_LIMITED", async () => {
    const { client, cleanup } = createTestApp(() => {
      const service = defineService("s", { deps: { cache: cache() } });
      const ping = service.tool({
        name: "ping",
        http: true,
        rateLimit: { per: () => "k", max: 1, windowMs: 60_000 },
        execute: () => "pong",
      });
      return { services: [service], contract: { s: { ping } } };
    });
    try {
      expect(await client.s.ping()).toBe("pong");
      const refused = await client.s.ping().catch((error) => error);
      expect(refused).toBeInstanceOf(ActionExecutionError);
      expect(refused).toMatchObject({
        code: "RATE_LIMITED",
        status: 429,
        details: { retryAfterSeconds: 60 },
      });
    } finally {
      await cleanup();
    }
  });
});

describe("rate limits on a Redis that is down", () => {
  const quiet = () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    return () => warn.mockRestore();
  };

  function fakeRedis(reply?: string) {
    const fake = {
      commands: 0,
      reply,
      server: Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          data(socket, data) {
            if (data.toString().includes("HELLO"))
              socket.write("%1\r\n$6\r\nserver\r\n$5\r\nredis\r\n");
            else {
              fake.commands++;
              if (fake.reply) socket.write(`${fake.reply}\r\n`);
            }
          },
        },
      }),
    };
    return fake;
  }

  it("counts in memory while the real driver cannot connect", async () => {
    const restore = quiet();
    const storage = defineStorage({
      driver: redis({ url: "redis://127.0.0.1:1" }),
    });
    try {
      const { service } = limited(
        { per: () => "k", max: 2, windowMs: 60_000 },
        { storage },
      );
      const app = brick({ services: [service], requestLogging: false });
      expect((await login(app)).status).toBe(200);
      const started = performance.now();
      expect((await login(app)).status).toBe(200);
      expect((await login(app)).status).toBe(429);
      expect(performance.now() - started).toBeLessThan(200);
    } finally {
      await storage.close();
      restore();
    }
  });

  it("tries a Redis that stops answering at most once a second, and no call waits for it", async () => {
    const restore = quiet();
    const fake = fakeRedis();
    const storage = defineStorage({
      driver: redis({ url: `redis://127.0.0.1:${fake.server.port}` }),
    });
    try {
      const { service } = limited(
        [
          { per: () => "a", max: 50, windowMs: 60_000 },
          { per: ({ input }) => input.email, max: 50, windowMs: 60_000 },
        ],
        { storage },
      );
      const app = brick({ services: [service], requestLogging: false });
      expect((await login(app)).status).toBe(200);
      const commands = fake.commands;
      const started = performance.now();
      for (let i = 0; i < 20; i++)
        expect((await login(app, `${i}`)).status).toBe(200);
      expect(performance.now() - started).toBeLessThan(300);
      expect(fake.commands - commands).toBeLessThanOrEqual(1);
    } finally {
      await storage.close();
      fake.server.stop(true);
      restore();
    }
  });

  it("treats a reply that means Redis cannot serve right now as unavailable", async () => {
    const fake = fakeRedis();
    const storage = defineStorage({
      driver: redis({ url: `redis://127.0.0.1:${fake.server.port}` }),
    });
    try {
      for (const code of [
        "LOADING",
        "READONLY",
        "OOM",
        "BUSY",
        "MASTERDOWN",
        "CLUSTERDOWN",
        "NOREPLICAS",
        "MISCONF",
        "TRYAGAIN",
      ]) {
        fake.reply = `-${code} cannot serve`;
        const error = await storage.increment("k", 1000).catch((e) => e);
        expect(error).toBeInstanceOf(StorageUnavailableError);
        expect(String(error.cause?.message)).toContain(code);
      }
      fake.reply = "-ERR unknown command";
      const other = await storage.get("k").catch((e) => e);
      expect(other).not.toBeInstanceOf(StorageUnavailableError);
      expect(String(other.message)).toContain("ERR unknown command");

      fake.reply = "-READONLY You can't write against a read only replica.";
      const restore = quiet();
      try {
        const { service } = limited(
          { per: () => "k", max: 1, windowMs: 60_000 },
          { storage },
        );
        const app = brick({ services: [service], requestLogging: false });
        expect((await login(app)).status).toBe(200);
        expect((await login(app)).status).toBe(429);
      } finally {
        restore();
      }
    } finally {
      await storage.close();
      fake.server.stop(true);
    }
  });

  it("sweeps expired counts from memory", async () => {
    const restore = quiet();
    const down: KeyValueDriver = {
      ...memory(),
      increment: async () => {
        throw new StorageUnavailableError("Storage: Redis is unreachable");
      },
    };
    const { service, action } = limited(
      { per: ({ input }) => input.email, max: 5, windowMs: 1_000 },
      { storage: defineStorage({ driver: down }) },
    );
    brick({ services: [service], requestLogging: false });
    const start = Date.now();
    setSystemTime(start);
    try {
      const pad = "x".repeat(100);
      for (let i = 0; i < 50_000; i++)
        await action.run({ email: `${i}${pad}` });
      Bun.gc(true);
      const full = process.memoryUsage().heapUsed;
      setSystemTime(start + 5_000);
      await action.run({ email: "late" });
      Bun.gc(true);
      const swept = process.memoryUsage().heapUsed;
      expect(full - swept).toBeGreaterThan(5_000_000);
    } finally {
      setSystemTime();
      restore();
    }
  });
});

describe("rate limits reached through another action", () => {
  const ipFromHeader = {
    requestLogging: false,
    clientIp: ({ request }: { request: Request }) =>
      request.headers.get("x-ip") ?? undefined,
  };

  it("counts a nested call and a useService call by the request's address", async () => {
    const crm = defineService("crm", {
      deps: { cache: cache() },
      context: ({ request }) => ({
        user: request?.headers.get("x-user") ?? undefined,
      }),
      identity: (ctx) => (ctx.user ? { id: ctx.user } : null),
    });
    const inner = crm.action({
      name: "inner",
      rateLimit: { per: "ip", max: 2, windowMs: 60_000 },
      execute: () => "ok",
    });
    crm.action({
      name: "byActor",
      rateLimit: { per: "actor", max: 2, windowMs: 60_000 },
      execute: () => "ok",
    });
    crm.action({
      name: "outer",
      execute: ({ ctx }) => inner.run(undefined, ctx),
    });
    const web = defineService("web", {});
    web.action({
      name: "via",
      execute: ({ ctx }) =>
        useService(crm, { from: "web" }).byActor(undefined, ctx),
    });
    const app = brick({ services: [crm, web], ...ipFromHeader });
    const call = (path: string, ip: string, user?: string) =>
      postJson(
        app,
        path,
        {},
        { "x-ip": ip, ...(user && { "x-user": user }) },
      ).then((response) => response.status);
    for (const [path, user] of [
      ["/api/crm/outer", undefined],
      ["/api/web/via", "u9"],
    ] as const) {
      expect(await call(path, "1.1.1.1", user)).toBe(200);
      expect(await call(path, "1.1.1.1", user)).toBe(200);
      expect(await call(path, "1.1.1.1", user)).toBe(429);
      expect(await call(path, "2.2.2.2", user)).toBe(200);
    }
  });

  it("counts MCP tool calls by the client address, mounted on the app or alone", async () => {
    const service = defineService("s", { deps: { cache: cache() } });
    service.tool({
      name: "lookup",
      rateLimit: { per: "ip", max: 2, windowMs: 60_000 },
      execute: () => "x",
    });
    const registry = createMcpRegistry({ services: [service] });
    const serverInfo = { name: "t", version: "1" };
    const mounted = createMcpHandler({ registry, serverInfo });
    const app = brick({ services: [service], ...ipFromHeader });
    app.post("/mcp", ({ request }: { request: Request }) => mounted(request));
    const alone = createMcpHandler({
      registry,
      serverInfo,
      clientIp: ipFromHeader.clientIp,
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "lookup", arguments: {} },
    });
    const call = async (
      handle: (request: Request) => Response | Promise<Response>,
      ip: string,
    ) => {
      const response = await handle(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", "x-ip": ip },
          body,
        }),
      );
      return ((await response.json()) as any).result.isError === true;
    };
    for (const [handle, ip] of [
      [(request: Request) => app.handle(request), "1.1.1.1"],
      [alone, "2.2.2.2"],
    ] as const) {
      expect(await call(handle, ip)).toBe(false);
      expect(await call(handle, ip)).toBe(false);
      expect(await call(handle, ip)).toBe(true);
    }
  });
});

describe("rate limits, other cases", () => {
  it("refuses an empty list when the action is defined", () => {
    expect(() =>
      defineAction({ name: "a", rateLimit: [], execute: () => 1 }),
    ).toThrow("Action 'a': rateLimit is an empty list, which limits nothing");
    const service = defineService("s", { deps: { cache: cache() } });
    expect(() =>
      service.action({ name: "b", rateLimit: [], execute: () => 1 }),
    ).toThrow("limits nothing");
  });

  it("counts a plugin's action in its install's storage, else in the service's", async () => {
    const keysOf = () => {
      const raw = memory();
      const keys: string[] = [];
      const storage = defineStorage({
        driver: {
          ...raw,
          increment: (key, ttlMs) => (
            keys.push(key),
            raw.increment(key, ttlMs)
          ),
        },
      });
      return { storage, keys };
    };
    const limit = { per: () => "k", max: 1, windowMs: 60_000 };
    for (const own of [false, true]) {
      resetGlobalRegistry();
      const host = keysOf();
      const install = keysOf();
      let pluginAction: any;
      const plugin = definePlugin({
        name: "@acme/p",
        ...(own && { deps: { kv: null as any } }),
        service: ({ service }: any) => {
          pluginAction = service.action({
            name: "pluginAct",
            rateLimit: limit,
            execute: () => 1,
          });
        },
      } as any);
      const service = defineService("svc", { deps: { cache: host.storage } });
      service.use(
        own
          ? (plugin as any)({}, { deps: { kv: install.storage } })
          : (plugin as any)({}),
      );
      brick({ services: [service], requestLogging: false });
      expect(await pluginAction.run()).toBe(1);
      await expect(pluginAction.run()).rejects.toMatchObject({
        code: "RATE_LIMITED",
      });
      expect(install.keys).toHaveLength(own ? 2 : 0);
      expect(host.keys).toHaveLength(own ? 0 : 2);
    }
  });

  it("counts a tool and an action of the same name apart", async () => {
    const service = defineService("s", { deps: { cache: cache() } });
    const limit = { per: () => "k", max: 1, windowMs: 60_000 };
    const action = service.action({
      name: "same",
      rateLimit: limit,
      execute: () => 1,
    });
    const tool = service.tool({
      name: "same",
      rateLimit: limit,
      execute: () => "x",
    });
    brick({ services: [service], requestLogging: false });
    expect(await action.run()).toBe(1);
    expect(await tool.run({})).toBe("x");
    await expect(action.run()).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("fails the call when clientIp returns anything but a non-empty string or undefined", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const value of [null, "", 42, { ip: "1.1.1.1" }]) {
        resetGlobalRegistry();
        const { service } = limited({ per: "ip", max: 5, windowMs: 60_000 });
        const app = brick({
          services: [service],
          requestLogging: false,
          clientIp: () => value as any,
        });
        expect((await login(app)).status).toBe(500);
      }
      resetGlobalRegistry();
      const { service } = limited({ per: "ip", max: 5, windowMs: 60_000 });
      const app = brick({
        services: [service],
        requestLogging: false,
        clientIp: (async () => "1.1.1.1") as any,
      });
      expect((await login(app)).status).toBe(500);
      expect(Bun.inspect(error.mock.calls)).toContain(
        "clientIp must return a non-empty string, or undefined when there is no address; it returned a promise",
      );
      resetGlobalRegistry();
      const skipped = limited({ per: "ip", max: 1, windowMs: 60_000 });
      const none = brick({
        services: [skipped.service],
        requestLogging: false,
        clientIp: () => undefined,
      });
      for (let i = 0; i < 3; i++) expect((await login(none)).status).toBe(200);
    } finally {
      error.mockRestore();
    }
  });

  it("fails the call when a custom per returns a promise, instead of counting every caller together", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { service } = limited({
        per: (async ({ input }: { input: { email: string } }) =>
          input.email) as any,
        max: 1,
        windowMs: 60_000,
      });
      const app = brick({ services: [service], requestLogging: false });
      expect((await login(app, "a")).status).toBe(500);
      expect((await login(app, "b")).status).toBe(500);
      expect(Bun.inspect(error.mock.calls)).toContain(
        "rateLimit per must return a string, null or undefined; it returned a promise",
      );

      resetGlobalRegistry();
      let unhandled = 0;
      const count = () => unhandled++;
      process.on("unhandledRejection", count);
      try {
        const rejecting = limited({
          per: (async () => {
            throw new Error("lookup failed");
          }) as any,
          max: 1,
          windowMs: 60_000,
        });
        const failing = brick({
          services: [rejecting.service],
          requestLogging: false,
        });
        expect((await login(failing, "a")).status).toBe(500);
        await Bun.sleep(10);
        expect(unhandled).toBe(0);
      } finally {
        process.off("unhandledRejection", count);
      }
    } finally {
      error.mockRestore();
    }
  });

  it("counts every spelling of an address, an IPv6 /64 and a mapped or NAT64 IPv4 address as one", async () => {
    const { service } = limited({ per: "ip", max: 1, windowMs: 60_000 });
    const app = brick({
      services: [service],
      requestLogging: false,
      clientIp: ({ request }) => request.headers.get("x-ip") ?? undefined,
    });
    const status = async (ip: string) =>
      (await login(app, "a", { "x-ip": ip })).status;
    expect(await status("2001:db8::1")).toBe(200);
    for (const same of [
      "2001:DB8::1",
      "2001:db8:0:0:0:0:0:1",
      "2001:0db8::0001",
      " 2001:db8::1",
      "2001:db8::ffff:2",
    ])
      expect(await status(same)).toBe(429);
    expect(await status("2001:db8:0:1::1")).toBe(200);
    expect(await status("::ffff:1.2.3.4")).toBe(200);
    expect(await status("1.2.3.4")).toBe(429);
    expect(await status("::ffff:102:304")).toBe(429);
    expect(await status("64:ff9b::1.2.3.4")).toBe(429);
    expect(await status("64:ff9b::5.6.7.8")).toBe(200);
    expect(await status("127.0.0.1")).toBe(200);
    expect(await status("::1")).toBe(200);
    expect(await status("not an address")).toBe(200);
    expect(await status("not an address")).toBe(429);
  });

  it("keys the documented login example so a stranger cannot lock an email out", async () => {
    const { service } = limited([
      {
        per: ({ input, ctx }) => {
          const ip = clientAddress(ctx);
          return ip && `${ip} ${input.email}`;
        },
        max: 2,
        windowMs: 60_000,
      },
      { per: ({ input }) => input.email, max: 5, windowMs: 60_000 },
    ]);
    const app = brick({
      services: [service],
      requestLogging: false,
      clientIp: ({ request }) => request.headers.get("x-ip") ?? undefined,
    });
    const from = async (ip: string) =>
      (await login(app, "victim@x.io", { "x-ip": ip })).status;
    expect(await from("6.6.6.6")).toBe(200);
    expect(await from("6.6.6.6")).toBe(200);
    expect(await from("6.6.6.6")).toBe(429);
    expect(await from("1.1.1.1")).toBe(200);
  });

  it("leaves the documented login example's address key out for a call without an address", async () => {
    const { service, action } = limited([
      {
        per: ({ input, ctx }) => {
          const ip = clientAddress(ctx);
          return ip && `${ip} ${input.email}`;
        },
        max: 1,
        windowMs: 60_000,
      },
      { per: ({ input }) => input.email, max: 3, windowMs: 60_000 },
    ]);
    brick({ services: [service], requestLogging: false });
    for (let i = 0; i < 3; i++) await action.run({ email: "a@b.c" });
    await expect(action.run({ email: "a@b.c" })).rejects.toThrow(
      "Too many calls",
    );
  });

  it("sends Retry-After from an app's own RATE_LIMITED only as a whole number of at least 1", async () => {
    const service = defineService("s");
    service.action({
      name: "own",
      input: t.Object({ v: t.Any() }),
      execute: ({ input, error }) =>
        error.RATE_LIMITED("slow down", { retryAfterSeconds: input.v }),
    });
    const app = brick({ services: [service], requestLogging: false });
    for (const [v, header] of [
      [0.5, "1"],
      [-3, "1"],
      [0, "1"],
      [2.1, "3"],
      [1e21, "1000000000000000000000"],
      ["7", null],
      [null, null],
    ] as const) {
      const response = await postJson(app, "/api/s/own", { v });
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe(header);
    }
  });

  it("lets browser code read Retry-After when CORS is on", async () => {
    const { service } = limited({ per: () => "k", max: 1, windowMs: 60_000 });
    const app = brick({
      services: [service],
      requestLogging: false,
      cors: "https://app.example.com",
    });
    const origin = { origin: "https://app.example.com" };
    await login(app, "a", origin);
    const refused = await login(app, "a", origin);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("access-control-expose-headers")).toBe(
      "Retry-After",
    );
  });
});
