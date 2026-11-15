import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import {
  ActionExecutionError,
  brick,
  compileBrickApplication,
  defineAction,
  defineDatabase,
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
  type StorageDriver,
} from "../src";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createTestApp } from "../src/testing";
import { postJson, redisReachable, requireService } from "./helpers";

const url = requireService("REDIS_URL", "redis rate limits");
if (url && !(await redisReachable(url)))
  throw new Error(`REDIS_URL is set, but no Redis answers at ${url}`);

beforeEach(resetGlobalRegistry);

const cache = () => defineStorage({ driver: memory() });

/** A service with one action, limited as given, on its own storage. */
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

/** The HTTP behaviour on every driver; Redis only when REDIS_URL is set. */
function suite(name: string, driver: () => StorageDriver, skip = false) {
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
      // Never 0: a client that retries at once would be refused again.
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
  });
}

suite("memory", memory);
suite(
  "redis",
  () => redis({ url, prefix: `brick-test-rate-limit-${crypto.randomUUID()}:` }),
  !url,
);
if (url)
  afterAll(async () => {
    // Every key this file wrote, whatever the run's prefix.
    const client = new Bun.RedisClient(url);
    const keys: string[] = await client.send("KEYS", [
      "brick-test-rate-limit-*",
    ]);
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
    // Joined with ":", login's entry 0 for "1:x" would be login:0's entry 1 for "x".
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
        return request.headers.get("fly-client-ip");
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
      // Anonymous: one IP budget, apart from an actor whose id is the same address.
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
    brick({ services: [service], requestLogging: false });
    const ctx = {
      request: new Request("http://x", { headers: { "x-user": "u1" } }),
    };
    expect(await exportAll.run(undefined, ctx)).toBe("ok");
    expect(await exportAll.run(undefined, ctx)).toBe("ok");
    const refused = await exportAll.run(undefined, ctx).catch((error) => error);
    expect(refused).toBeInstanceOf(ActionExecutionError);
    expect(refused).toMatchObject({ code: "RATE_LIMITED", status: 429 });
    // Anonymous and in-process: no IP, so not counted.
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
  it("counts in process memory, and warns once when it starts and once when the storage is back", async () => {
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
      { per: () => "k", max: 2, windowMs: 60_000 },
      { storage: defineStorage({ driver: flaky }) },
    );
    const app = brick({ services: [service], requestLogging: false });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await login(app)).status).toBe(200);
      down = true;
      // A fresh count in memory: two more pass, then the limit holds.
      expect((await login(app)).status).toBe(200);
      expect((await login(app)).status).toBe(200);
      expect((await login(app)).status).toBe(429);
      expect((await login(app)).status).toBe(429);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(
        "counting in this process's memory",
      );
      down = false;
      // Back on the storage, whose count is 2 (one before, this one).
      expect((await login(app)).status).toBe(200);
      expect((await login(app)).status).toBe(429);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(String(warn.mock.calls[1]![0])).toContain("storage is back");
    } finally {
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
