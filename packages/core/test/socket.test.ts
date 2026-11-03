import { afterEach, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  brick,
  defineService,
  resetGlobalRegistry,
  runInTransaction,
  t,
} from "../src";
import { defineElsewhere } from "./fixtures/define-elsewhere";
import {
  createBrickClient,
  BrickSocketError,
  type BrickClientSocket,
} from "../src/client";
import { serializeSocketSchema } from "../src/socket-schema";
import { restoreSocketSchema } from "../src/socket-schema";
import { Check } from "@sinclair/typebox/value";
import { replayScenario } from "./socket-replay";

const apps: ReturnType<typeof brick>[] = [];
const peers: WebSocket[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.close();
  for (const app of apps.splice(0)) await app.stop(true);
  resetGlobalRegistry();
});

function start(service: ReturnType<typeof defineService>, compiler = true) {
  const app = brick({
    services: [service],
    prefix: "/v2",
    compiler,
    docs: false,
    requestLogging: false,
  }).listen(0);
  apps.push(app);
  return `http://localhost:${app.server!.port}`;
}
function open(url: string, headers?: Record<string, string>) {
  const ws = new WebSocket(
    url.replace(/^http/, "ws"),
    headers ? { headers } : undefined,
  );
  peers.push(ws);
  return new Promise<WebSocket>((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
  });
}
function message(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) =>
    ws.addEventListener(
      "message",
      ({ data }) => resolve(JSON.parse(String(data))),
      { once: true },
    ),
  );
}
function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) =>
    ws.addEventListener("close", ({ code }) => resolve(code), { once: true }),
  );
}
function echo(compiler = true) {
  const service = defineService("chat");
  service.socket({
    name: "live",
    input: { say: t.String() },
    output: { message: t.String() },
    allowMissingOrigin: true,
    handlers: { say: ({ input, socket }) => socket.send("message", input) },
  });
  return start(service, compiler);
}
const contract: {
  chat: { live: BrickClientSocket<{ say: string }, { message: string }> };
} = {
  chat: {
    live: {
      kind: "socket",
      name: "live",
      serviceName: "chat",
      config: { path: "/v2/chat/live" },
      output: { message: serializeSocketSchema(t.String()) },
    },
  },
};

for (const compiler of [true, false])
  it(`round trips through a real listener with compiler=${compiler}`, async () => {
    const api = createBrickClient({ baseUrl: echo(compiler), contract });
    const live = api.chat.live.connect();
    const received = new Promise<string>((resolve) =>
      live.on("message", resolve),
    );
    await live.ready;
    live.send("say", "hello");
    expect(await received).toBe("hello");
    live.close();
    expect(() => live.send("say", "again")).toThrow(BrickSocketError);
  });

it("sends a declared handler error to the client and keeps the connection open", async () => {
  const service = defineService("chat");
  service.socket({
    name: "live",
    input: { say: t.String() },
    output: { message: t.String() },
    allowMissingOrigin: true,
    errors: {
      TOO_LONG: {
        message: "Too long",
        status: 422,
        details: t.Object({ max: t.Number() }),
      },
    },
    handlers: {
      say: ({ input, socket, error }) => {
        if (input === "crash") throw new Error("private failure");
        if (input.length > 3) error.TOO_LONG(undefined, { max: 3 });
        socket.send("message", input);
      },
    },
  });
  const api = createBrickClient({
    baseUrl: start(service),
    contract: contract as unknown as {
      chat: {
        live: BrickClientSocket<
          { say: string },
          { message: string },
          Record<"TOO_LONG", { message: string }>
        >;
      };
    },
  });
  const live = api.chat.live.connect({ reconnect: false });
  const failed = new Promise<any>((resolve) => live.onHandlerError(resolve));
  const received = new Promise((resolve) => live.on("message", resolve));
  const closed = new Promise((resolve) =>
    live.onClose(({ code }) => resolve(code)),
  );
  await live.ready;
  live.send("say", "too long");
  expect(await failed).toMatchObject({
    name: "ActionExecutionError",
    event: "say",
    code: "TOO_LONG",
    message: "Too long",
    status: 422,
    details: { max: 3 },
  });
  live.send("say", "ok");
  expect(await received).toBe("ok");
  expect(live.status).toBe("open");
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    live.send("say", "crash");
    expect(await closed).toBe(1011);
  } finally {
    log.mockRestore();
  }
});

it("resolves fresh context and rechecks authorization before every message", async () => {
  let active = true;
  let handled = 0;
  const service = defineService("chat", {
    context: ({ request }) => ({
      user:
        active && request.headers.get("cookie") === "session=yes"
          ? { id: "a" }
          : null,
    }),
  });
  service.socket({
    name: "live",
    input: { say: t.String() },
    output: { message: t.String() },
    allowMissingOrigin: true,
    authorize: ({ ctx }) => ctx.user != null,
    handlers: {
      say: ({ input, socket }) => {
        handled++;
        socket.send("message", input);
      },
    },
  });
  const url = start(service) + "/v2/chat/live";
  await expect(open(url)).rejects.toBeDefined();
  const ws = await open(url, { cookie: "session=yes" });
  const response = message(ws);
  ws.send(JSON.stringify({ event: "say", data: "allowed" }));
  expect(await response).toEqual({ event: "message", data: "allowed" });
  active = false;
  const ended = closed(ws);
  ws.send(JSON.stringify({ event: "say", data: "refused" }));
  expect(await ended).toBe(1008);
  expect(handled).toBe(1);
});

it("checks same-origin, configured origins, and missing origins separately", async () => {
  const service = defineService("chat");
  service.socket({
    name: "live",
    input: {},
    output: {},
    allowedOrigins: ["https://frontend.test"],
    handlers: {},
  });
  const url = start(service) + "/v2/chat/live";
  await expect(open(url)).rejects.toBeDefined();
  await expect(
    open(url, { origin: "https://attacker.test" }),
  ).rejects.toBeDefined();
  const ws = await open(url, { origin: "https://frontend.test" });
  expect(ws.readyState).toBe(1);
});

it("accepts same-origin browsers behind a TLS-terminating proxy", async () => {
  const url = echoSameOrigin() + "/v2/chat/live";
  await expect(
    open(url, { origin: "https://chat.example.com" }),
  ).rejects.toBeDefined();
  const ws = await open(url, {
    origin: "https://chat.example.com",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "chat.example.com",
  });
  expect(ws.readyState).toBe(1);
  await expect(
    open(url, {
      origin: "https://attacker.test",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "chat.example.com",
    }),
  ).rejects.toBeDefined();
});

function echoSameOrigin() {
  const service = defineService("chat");
  service.socket({
    name: "live",
    input: {},
    output: {},
    handlers: {},
  });
  return start(service);
}

for (const [payload, code] of [
  ["not json", 1007],
  [JSON.stringify({ event: "missing", data: "no" }), 1008],
  [JSON.stringify({ event: "say", data: 42 }), 1008],
  [JSON.stringify({ event: "say", data: "no", extra: true }), 1008],
  [new Uint8Array([1, 2]), 1003],
] as const)
  it(`rejects invalid frame ${String(payload)} before dispatch`, async () => {
    const ws = await open(echo() + "/v2/chat/live");
    const ended = closed(ws);
    ws.send(payload);
    expect(await ended).toBe(code);
  });

it("serializes async handlers and cleans up once", async () => {
  const seen: number[] = [];
  let cleanups = 0;
  const service = defineService("chat");
  service.socket({
    name: "live",
    input: { say: t.Number() },
    output: { message: t.Array(t.Number()) },
    allowMissingOrigin: true,
    handlers: {
      say: async ({ input, socket }) => {
        await Bun.sleep(input === 1 ? 20 : 0);
        seen.push(input);
        if (input === 2) socket.send("message", [...seen]);
      },
    },
    close: () => {
      cleanups++;
    },
  });
  const ws = await open(start(service) + "/v2/chat/live");
  const result = message(ws);
  ws.send(JSON.stringify({ event: "say", data: 1 }));
  ws.send(JSON.stringify({ event: "say", data: 2 }));
  expect(await result).toEqual({ event: "message", data: [1, 2] });
  const ended = closed(ws);
  ws.close();
  await ended;
  await apps[0]!.stop(true);
  apps.length = 0;
  expect(cleanups).toBe(1);
});

it("bounds pending messages while a handler is blocked", async () => {
  const gate = Promise.withResolvers<void>();
  const service = defineService("chat");
  service.socket({
    name: "live",
    input: { say: t.Number() },
    output: {},
    allowMissingOrigin: true,
    handlers: { say: () => gate.promise },
  });
  const ws = await open(start(service) + "/v2/chat/live");
  const ended = closed(ws);
  for (let i = 0; i < 40; i++)
    ws.send(JSON.stringify({ event: "say", data: i }));
  expect(await ended).toBe(1013);
  gate.resolve();
});

it("rejects conflicting routes and declarations after build", () => {
  const service = defineService("chat");
  const config = {
    name: "live",
    input: {},
    output: {},
    handlers: {},
  };
  service.socket(config);
  expect(() => defineElsewhere(service, "socket", config)).toThrow(
    `duplicate socket "live" in service "chat"`,
  );
  // An explicit path is relative to the service: `/api/chat/live` again.
  service.socket({ ...config, name: "other", path: "/live" });
  expect(() => brick({ services: [service] })).toThrow(
    "duplicate socket route",
  );
  expect(() => service.socket({ ...config, name: "third" })).toThrow(
    "before service build",
  );
});

it("rejects nonportable schemas at declaration", () => {
  const service = defineService("chat");
  expect(() =>
    service.socket({
      name: "live",
      input: { say: t.Date() },
      output: {},
      handlers: { say() {} },
    }),
  ).toThrow("JSON values");
});

it("rejects invalid server output in the browser client", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("bad", { status: 400 });
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ event: "message", data: 42 }));
      },
      message() {},
    },
  });
  try {
    const live = createBrickClient({
      baseUrl: `http://localhost:${server.port}`,
      contract,
    }).chat.live.connect();
    const failed = new Promise<BrickSocketError>((resolve) =>
      live.onError(resolve),
    );
    await live.ready;
    expect((await failed).kind).toBe("protocol");
  } finally {
    await server.stop(true);
  }
});

it("handles already aborted connections and unsubscribes listeners", async () => {
  const api = createBrickClient({ baseUrl: echo(), contract });
  const controller = new AbortController();
  controller.abort();
  const aborted = api.chat.live.connect({ signal: controller.signal });
  await expect(aborted.ready).rejects.toHaveProperty("name", "AbortError");
  const live = api.chat.live.connect();
  let calls = 0;
  const off = live.on("message", () => {
    calls++;
  });
  off();
  const response = new Promise<string>((resolve) =>
    live.on("message", resolve),
  );
  await live.ready;
  live.send("say", "hello");
  expect(await response).toBe("hello");
  expect(calls).toBe(0);
  live.close();
});

it("validates recursive and record schemas after contract serialization", () => {
  const schema = t.Recursive((Self) =>
    t.Object({
      name: t.String(),
      labels: t.Record(t.String(), t.Number()),
      children: t.Array(Self),
    }),
  );
  const restored = restoreSocketSchema(
    JSON.parse(JSON.stringify(serializeSocketSchema(schema))),
  );
  expect(
    Check(restored, {
      name: "root",
      labels: { count: 1 },
      children: [{ name: "child", labels: {}, children: [] }],
    }),
  ).toBe(true);
  expect(
    Check(restored, {
      name: "root",
      labels: {},
      children: [{ name: 42, labels: {}, children: [] }],
    }),
  ).toBe(false);
});

it("does not start a handler when context resolves after closure", async () => {
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const cleaned = Promise.withResolvers<void>();
  let resolutions = 0;
  let handled = 0;
  let cleanups = 0;
  const service = defineService("chat", {
    context: async () => {
      if (++resolutions === 2) {
        entered.resolve();
        await resume.promise;
      }
      return {};
    },
  });
  service.socket({
    name: "live",
    allowMissingOrigin: true,
    input: { say: t.String() },
    output: {},
    handlers: {
      say() {
        handled++;
      },
    },
    close() {
      cleanups++;
      cleaned.resolve();
    },
  });
  const ws = await open(start(service) + "/v2/chat/live");
  ws.send(JSON.stringify({ event: "say", data: "hello" }));
  await entered.promise;
  const ended = closed(ws);
  ws.close();
  await ended;
  await cleaned.promise;
  resume.resolve();
  await Bun.sleep(0);
  expect(handled).toBe(0);
  expect(cleanups).toBe(1);
});

it("closes oversized native frames", async () => {
  const ws = await open(echo() + "/v2/chat/live");
  const ended = closed(ws);
  ws.send(JSON.stringify({ event: "say", data: "a".repeat(65536) }));
  expect([1006, 1009]).toContain(await ended);
});

it("rejects HTTP route conflicts and dynamic socket paths", () => {
  const service = defineService("chat");
  expect(() =>
    service.socket({
      name: "bad",
      path: "/room/:id",
      input: {},
      output: {},
      handlers: {},
    }),
  ).toThrow("static");
  service.socket({ name: "live", input: {}, output: {}, handlers: {} });
  service.action({
    name: "get",
    path: "/live",
    method: "GET",
    execute() {},
  });
  expect(() => brick({ services: [service], prefix: "/v2" })).toThrow(
    "conflicts with a socket",
  );
});

it("cancels an open connection once", async () => {
  const controller = new AbortController();
  const live = createBrickClient({
    baseUrl: echo(),
    contract,
  }).chat.live.connect({ signal: controller.signal });
  let cleanups = 0;
  live.onClose(() => {
    cleanups++;
  });
  await live.ready;
  controller.abort();
  live.close();
  expect(cleanups).toBe(1);
  expect(() => live.send("say", "after abort")).toThrow("not open");
});

it("times out a pending handshake", async () => {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      await Bun.sleep(50);
      return new Response("refused", { status: 403 });
    },
  });
  try {
    const live = createBrickClient({
      baseUrl: `http://localhost:${server.port}`,
      contract,
    }).chat.live.connect({ timeoutMs: 5, reconnect: false });
    await expect(live.ready).rejects.toThrow("timed out");
    live.close();
  } finally {
    await server.stop(true);
  }
});

function roomsApp(maxRooms?: number) {
  const service = defineService("chat", {
    context: ({ request }) => ({
      user: request.headers.get("x-user") ?? "anon",
    }),
  });
  const live = service.socket({
    name: "live",
    input: {},
    output: { message: t.String() },
    allowMissingOrigin: true,
    maxRooms,
    rooms: ({ ctx }) => [`user:${ctx.user}`],
    join: ({ room }) => room.startsWith("doc:"),
    handlers: {},
  });
  return { live, url: start(service) };
}
function next(ws: WebSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => {
    const listener = ({ data }: MessageEvent) => {
      const message = JSON.parse(String(data));
      if (message.event !== event) return;
      ws.removeEventListener("message", listener);
      resolve(message.data);
    };
    ws.addEventListener("message", listener);
  });
}
async function joinRaw(ws: WebSocket, room: string) {
  const ack = next(ws, "$join");
  ws.send(JSON.stringify({ event: "$join", data: { room } }));
  return ack;
}

it("joins, emits to, leaves and kicks rooms through the client", async () => {
  const { live, url } = roomsApp();
  const socket = createBrickClient({
    baseUrl: url,
    contract,
  }).chat.live.connect();
  const received: string[] = [];
  socket.on("message", (text) => received.push(text));
  const left = new Promise<[string, string | undefined]>((resolve) =>
    socket.onLeave((room, reason) => resolve([room, reason])),
  );
  await socket.ready;
  await socket.join("doc:Sales Invoice/SINV-1");
  await expect(socket.join("secret:1")).rejects.toHaveProperty(
    "kind",
    "refused",
  );
  await expect(socket.join("no-prefix")).rejects.toHaveProperty(
    "kind",
    "protocol",
  );
  live.emit("doc:Sales Invoice/SINV-1", "message", "doc");
  live.emit(["user:anon", "team:none"], "message", "user");
  socket.leave("doc:Sales Invoice/SINV-1");
  await socket.join("doc:2");
  live.emit("doc:Sales Invoice/SINV-1", "message", "after leave");
  live.kick("doc:2", { reason: "removed" });
  expect(await left).toEqual(["doc:2", "removed"]);
  live.emit("doc:2", "message", "after kick");
  live.emit("user:anon", "message", "end");
  await Bun.sleep(20);
  expect(received).toEqual(["doc", "user", "end"]);
  socket.close();
});

it("kicks only connections also in another room", async () => {
  const { live, url } = roomsApp();
  const a = await open(url + "/v2/chat/live", { "x-user": "a" });
  const b = await open(url + "/v2/chat/live", { "x-user": "b" });
  expect(await joinRaw(a, "doc:1")).toEqual({ room: "doc:1", ok: true });
  expect(await joinRaw(b, "doc:1")).toEqual({ room: "doc:1", ok: true });
  const left = next(a, "$left");
  const fromB = next(b, "message");
  live.kick("doc:1", { also: "user:a" });
  expect(await left).toEqual({ room: "doc:1" });
  const fromA = next(a, "message");
  live.emit("doc:1", "message", "doc");
  live.emit("user:a", "message", "direct");
  expect(await fromB).toBe("doc");
  expect(await fromA).toBe("direct");
});

it("delivers once to connections on the current and v0.10 paths", async () => {
  const service = defineService("chat");
  const feed = service.socket({
    name: "liveFeed",
    input: {},
    output: { message: t.String() },
    allowMissingOrigin: true,
    rooms: () => ["user:anon"],
    handlers: {},
  });
  const app = brick({
    services: [service],
    prefix: "/v2",
    docs: false,
    requestLogging: false,
    legacyRoutes: true,
  }).listen(0);
  apps.push(app);
  const url = `http://localhost:${app.server!.port}/v2/chat`;
  const current = await open(`${url}/live-feed`);
  const legacy = await open(`${url}/liveFeed`);
  const received: string[] = [];
  for (const ws of [current, legacy])
    ws.addEventListener("message", ({ data }) =>
      received.push(JSON.parse(String(data)).data),
    );
  feed.emit("user:anon", "message", "once");
  await Bun.sleep(20);
  expect(received).toEqual(["once", "once"]);
});

it("refuses joins over the room cap and keeps server rooms", async () => {
  const { live, url } = roomsApp(2);
  const ws = await open(url + "/v2/chat/live");
  expect(await joinRaw(ws, "doc:1")).toEqual({ room: "doc:1", ok: true });
  expect(await joinRaw(ws, "doc:2")).toEqual({ room: "doc:2", ok: false });
  const ack = next(ws, "$leave");
  ws.send(JSON.stringify({ event: "$leave", data: { room: "user:anon" } }));
  expect(await ack).toEqual({ room: "user:anon" });
  const received = next(ws, "message");
  live.emit("user:anon", "message", "still here");
  expect(await received).toBe("still here");
  const ended = closed(ws);
  ws.send(JSON.stringify({ event: "$join", data: { room: 42 } }));
  expect(await ended).toBe(1008);
});

it("validates emits at the call site and reserves $ event names", () => {
  const { live } = roomsApp();
  expect(() => live.emit("bad room", "message", "x")).toThrow(
    "Invalid socket room",
  );
  // @ts-expect-error Payloads are checked.
  expect(() => live.emit("doc:1", "message", 42)).toThrow(
    "Invalid socket output",
  );
  expect(() => live.emit("doc:1", "message", "a".repeat(65536))).toThrow(
    "too large",
  );
  expect(() => live.kick("doc:1", { also: "nope" })).toThrow(
    "Invalid socket room",
  );
  const service = defineService("other");
  expect(() =>
    service.socket({
      name: "live",
      input: { $join: t.String() },
      output: {},
      handlers: { $join() {} },
    }),
  ).toThrow("reserved");
  expect(() =>
    service.socket({
      name: "x",
      input: {},
      output: {},
      maxRooms: 0,
      handlers: {},
    }),
  ).toThrow("maxRooms");
});

it("emits { after: tx } on commit and drops it on rollback", async () => {
  const { live, url } = roomsApp();
  const ws = await open(url + "/v2/chat/live");
  const received: unknown[] = [];
  ws.addEventListener("message", ({ data }) =>
    received.push(JSON.parse(String(data)).data),
  );
  const db = drizzle(new Database(":memory:"));
  await runInTransaction(db, async (tx) => {
    live.emit("user:anon", "message", "committed", { after: tx });
    await Bun.sleep(10);
    expect(received).toEqual([]);
  });
  await expect(
    runInTransaction(db, async (tx) => {
      live.emit("user:anon", "message", "rolled back", { after: tx });
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  await runInTransaction(db, async (tx) => {
    await expect(
      runInTransaction(tx, async (inner) => {
        live.emit("user:anon", "message", "savepoint", { after: inner });
        throw new Error("inner");
      }),
    ).rejects.toThrow("inner");
  });
  expect(() => live.emit("user:anon", "message", "x", { after: db })).toThrow(
    "runInTransaction",
  );
  live.emit("user:anon", "message", "last");
  await Bun.sleep(20);
  expect(received).toEqual(["committed", "last"]);
});

function tokenApp() {
  const seen: { auth: string | null; protocol: string | null }[] = [];
  const service = defineService("chat", {
    context: ({ request }) => {
      seen.push({
        auth: request.headers.get("authorization"),
        protocol: request.headers.get("sec-websocket-protocol"),
      });
      return { user: request.headers.get("authorization")?.slice(7) ?? null };
    },
  });
  const live = service.socket({
    name: "live",
    input: { say: t.String(), crash: t.Null() },
    output: { message: t.String() },
    authorize: ({ ctx }) => ctx.user != null,
    rooms: ({ ctx }) => [`user:${ctx.user}`],
    join: () => true,
    handlers: {
      say: ({ input, ctx, socket }) =>
        socket.send("message", `${ctx.user}:${input}`),
      crash: () => {
        throw new Error("crash");
      },
    },
  });
  const url = start(service);
  const api = createBrickClient({
    baseUrl: url,
    contract: {
      chat: {
        live: contract.chat.live as BrickClientSocket<
          { say: string; crash: null },
          { message: string }
        >,
      },
    },
  });
  return { live, seen, api, url };
}

it("moves a subprotocol token into a bearer header and echoes brick.v1", async () => {
  const { seen, api, url } = tokenApp();
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/v2/chat/live", [
    "brick.v1",
    "brick.token.abc",
  ]);
  peers.push(ws);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  expect(ws.protocol).toBe("brick.v1");
  expect(seen[0]).toEqual({ auth: "Bearer abc", protocol: "brick.v1" });
  // Without a token, a missing Origin keeps the strict default.
  await expect(open(url + "/v2/chat/live")).rejects.toBeDefined();

  const live = api.chat.live.connect({ token: () => "eyJ.part-1_x" });
  const reply = new Promise((resolve) => live.on("message", resolve));
  await live.ready;
  live.send("say", "hi");
  expect(await reply).toBe("eyJ.part-1_x:hi");
  live.close();

  const padded = api.chat.live.connect({ token: async () => "abc=" });
  await expect(padded.ready).rejects.toThrow("RFC 6455");
  expect(padded.status).toBe("closed");
});

it("reconnects with a fresh token, keeps listeners and rejoins requested rooms", async () => {
  const { live, api } = tokenApp();
  let tokens = 0;
  const socket = api.chat.live.connect({
    token: async () => {
      tokens++;
      return "u1";
    },
    reconnect: { minDelayMs: 5, maxDelayMs: 20 },
  });
  const statuses: string[] = [];
  let sendWhileReconnecting: unknown;
  socket.onStatus((status) => {
    statuses.push(status);
    if (status === "reconnecting")
      try {
        socket.send("say", "offline");
      } catch (error) {
        sendWhileReconnecting = error;
      }
  });
  const received: string[] = [];
  socket.on("message", (text) => received.push(text));
  await socket.ready;
  await socket.join("doc:1");
  await socket.join("doc:2");
  const left = new Promise((resolve) => socket.onLeave(resolve));
  live.kick("doc:2");
  expect(await left).toBe("doc:2");
  const reconnected = new Promise<void>((resolve) =>
    socket.onReconnect(resolve),
  );
  socket.send("crash", null);
  await reconnected;
  const replied = new Promise((resolve) => {
    const off = socket.on("message", (text) => {
      off();
      resolve(text);
    });
  });
  socket.send("say", "after");
  expect(await replied).toBe("u1:after");
  live.emit("doc:1", "message", "doc1");
  live.emit("doc:2", "message", "doc2");
  live.emit("user:u1", "message", "end");
  await Bun.sleep(30);
  expect(received).toEqual(["u1:after", "doc1", "end"]);
  expect(tokens).toBe(2);
  expect(statuses).toEqual(["open", "reconnecting", "open"]);
  expect(sendWhileReconnecting).toBeInstanceOf(BrickSocketError);
  socket.close();
  expect(socket.status).toBe("closed");
});

it("stops on policy closes and when reconnect is off", async () => {
  const { api } = tokenApp();
  const refused = api.chat.live.connect({ token: () => "u1" });
  const refusedClose = new Promise((resolve) =>
    refused.onClose(({ code }) => resolve(code)),
  );
  await refused.ready;
  refused.send("say", 42 as never);
  expect(await refusedClose).toBe(1008);
  expect(refused.status).toBe("closed");

  const once = api.chat.live.connect({ token: () => "u1", reconnect: false });
  const onceClose = new Promise((resolve) =>
    once.onClose(({ code }) => resolve(code)),
  );
  await once.ready;
  once.send("crash", null);
  expect(await onceClose).toBe(1011);
  expect(once.status).toBe("closed");
});

it("replays what a reconnecting client missed and reports gaps", () =>
  replayScenario((app) => apps.push(app)));

it("checks replay settings and broker support", () => {
  const service = defineService("chat");
  const config = { name: "live", input: {}, output: {}, handlers: {} };
  expect(() =>
    service.socket({ ...config, replay: { keep: 0, maxAgeMs: 1000 } }),
  ).toThrow("replay");
  service.socket({ ...config, replay: { keep: 10, maxAgeMs: 1000 } });
  expect(() =>
    brick({
      services: [service],
      sockets: { broker: { publish() {}, subscribe: () => () => {} } },
    }),
  ).toThrow("does not support replay");
});

it("doesn't replay a room's messages from before the client could join it", async () => {
  const service = defineService("chat");
  let allowed = false;
  const live = service.socket({
    name: "live",
    output: { message: t.String() },
    allowMissingOrigin: true,
    replay: { keep: 10, maxAgeMs: 60_000 },
    join: ({ room }) => room === "doc:public" || allowed,
    handlers: {},
  });
  const url = start(service);
  const ws = new WebSocket(url.replace(/^http/, "ws") + "/v2/chat/live", [
    "brick.v1",
    "brick.token.x",
  ]);
  peers.push(ws);
  const frames: any[] = [];
  ws.onmessage = ({ data }) => frames.push(JSON.parse(String(data)));
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const ack = async (room: string) => {
    for (let i = 0; i < 100; i++) {
      const found = frames.find(
        (f) => f.event === "$join" && f.data.room === room,
      );
      if (found) return found.data;
      await Bun.sleep(5);
    }
  };
  // Any room the client may join tells it the current sequence.
  ws.send(JSON.stringify({ event: "$join", data: { room: "doc:public" } }));
  const { seq } = await ack("doc:public");
  live.emit("doc:private", "message", "before you were allowed in");
  allowed = true;
  // Neither a sequence signed for another room nor an edited one replays.
  let since = seq;
  for (const attempt of ["other room", "edited"]) {
    if (attempt === "edited") {
      since = frames.find((f) => f.event === "$gap").data.seq;
      since = since.replace(/-\d+\./, "-0.");
    }
    frames.length = 0;
    ws.send(JSON.stringify({ event: "$leave", data: { room: "doc:private" } }));
    ws.send(
      JSON.stringify({ event: "$join", data: { room: "doc:private", since } }),
    );
    expect((await ack("doc:private")).ok).toBe(true);
    expect(frames.find((f) => f.event === "$gap")?.data.room).toBe(
      "doc:private",
    );
  }
  live.emit("doc:private", "message", "after");
  await Bun.sleep(30);
  expect(
    frames.filter((f) => f.event === "message").map((f) => f.data),
  ).toEqual(["after"]);
});
