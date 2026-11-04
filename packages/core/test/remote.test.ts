import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  ActionExecutionError,
  brick,
  defineService,
  internalToken,
  remoteService,
  resetGlobalRegistry,
  t,
  useService,
} from "../src";

// A tiny fake child: echoes what the gateway sent, or fails like a Go/Rust service.
const seen: { path: string; headers: Record<string, string>; body: string }[] =
  [];
const child = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.text();
    const headers = Object.fromEntries(request.headers);
    seen.push({ path: url.pathname + url.search, headers, body });
    if (url.pathname === "/fail")
      return Response.json(
        {
          name: "ActionExecutionError",
          code: "INSUFFICIENT_FUNDS",
          message: "Not enough money",
          status: 402,
          details: { missing: 5 },
          requestId: headers["x-request-id"],
        },
        { status: 402 },
      );
    return Response.json({
      path: url.pathname,
      body: JSON.parse(body || "{}"),
    });
  },
});
afterAll(() => child.stop(true));

const billing = remoteService({
  name: "billing",
  dir: ".",
  dev: "true",
  port: child.port,
  context: ({ request }) => {
    const auth = request.headers.get("authorization");
    return auth ? { user: { id: auth.slice(7) }, tenantId: "t1" } : undefined;
  },
});

beforeEach(() => {
  resetGlobalRegistry();
  seen.length = 0;
});

function app() {
  const orders = defineService("orders");
  orders.action({
    name: "whoami",
    input: t.Object({ n: t.Number() }),
    execute: ({ input, ctx }) => ({
      n: input.n,
      user: ctx.user,
      caller: ctx.caller,
      tenantId: ctx.tenantId,
      requestId: ctx.requestId,
    }),
  });
  return brick({
    services: [orders],
    remote: [billing],
    docs: false,
    requestLogging: false,
    cors: { origin: "https://app.example.com" },
  });
}

const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
  app().handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );

describe("remote services", () => {
  it("proxies /api/<service>/* to the child with the trusted envelope", async () => {
    const response = await post(
      "/api/billing/charge?x=1",
      { amount: 3 },
      {
        authorization: "Bearer alice",
        origin: "https://app.example.com",
        "x-request-id": "req-1",
        traceparent: "00-abc-def-01",
        // Spoofed by the client: must never reach the child.
        "x-brick-user": btoa('{"id":"mallory"}'),
        "x-brick-caller": "admin",
        "x-brick-internal": "guess",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/charge",
      body: { amount: 3 },
    });
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    const [request] = seen;
    expect(request!.path).toBe("/charge?x=1");
    expect(request!.headers["x-brick-internal"]).toBe(internalToken());
    expect(
      JSON.parse(atob(request!.headers["x-brick-user"]!)) as unknown,
    ).toEqual({ id: "alice" });
    expect(request!.headers["x-brick-tenant"]).toBe("t1");
    expect(request!.headers["x-brick-caller"]).toBeUndefined();
    expect(request!.headers["x-request-id"]).toBe("req-1");
    expect(request!.headers.traceparent).toBe("00-abc-def-01");
    expect(request!.headers["x-trace-id"]).toBeTruthy();
  });

  it("strips spoofed x-brick-* headers when there is no user", async () => {
    await post("/api/billing/charge", {}, { "x-brick-user": "e30=" });
    expect(seen[0]!.headers["x-brick-user"]).toBeUndefined();
  });

  it("passes the child's error envelope through unchanged", async () => {
    const response = await post(
      "/api/billing/fail",
      {},
      { "x-request-id": "r9" },
    );
    expect(response.status).toBe(402);
    expect(await response.text()).toBe(
      '{"name":"ActionExecutionError","code":"INSUFFICIENT_FUNDS","message":"Not enough money","status":402,"details":{"missing":5},"requestId":"r9"}',
    );
  });

  it("answers 503 with an envelope when the child is down", async () => {
    const down = remoteService({
      name: "down",
      dir: ".",
      dev: "true",
      port: 1,
    });
    const response = await brick({
      services: [],
      remote: [down],
      docs: false,
      requestLogging: false,
    }).handle(new Request("http://localhost/api/down/x", { method: "POST" }));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("SERVICE_UNAVAILABLE");
  });

  it("useService calls the child directly and maps its errors", async () => {
    const client = useService(billing, { from: "orders" });
    expect(
      await client.chargeCard(
        { amount: 1 },
        { user: { id: "u" }, requestId: "r2" },
      ),
    ).toEqual({ path: "/charge-card", body: { amount: 1 } });
    expect(seen[0]!.headers["x-brick-caller"]).toBe("orders");
    expect(seen[0]!.headers["x-request-id"]).toBe("r2");
    const error = await client.fail({}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionExecutionError);
    expect(error).toMatchObject({
      code: "INSUFFICIENT_FUNDS",
      status: 402,
      details: { missing: 5 },
    });
  });

  it("serves TS actions to children only with the internal token", async () => {
    const denied = await post("/_brick/call/orders/whoami", { n: 1 });
    expect(denied.status).toBe(401);
    const ok = await post(
      "/_brick/call/orders/whoami",
      { n: 1 },
      {
        "x-brick-internal": internalToken(),
        "x-brick-user": btoa('{"id":"alice"}'),
        "x-brick-caller": "billing",
        "x-brick-tenant": "t1",
        "x-request-id": "req-7",
      },
    );
    expect(await ok.json()).toEqual({
      n: 1,
      user: { id: "alice" },
      caller: "billing",
      tenantId: "t1",
      requestId: "req-7",
    });
    const invalid = await post(
      "/_brick/call/orders/whoami",
      { n: "x" },
      { "x-brick-internal": internalToken() },
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe("VALIDATION_FAILED");
  });

  it("never trusts x-brick-* on the public action routes", async () => {
    const response = await post(
      "/api/orders/whoami",
      { n: 1 },
      { "x-brick-user": btoa('{"id":"mallory"}'), "x-brick-caller": "billing" },
    );
    const body = await response.json();
    expect(body.user).toBeUndefined();
    expect(body.caller).toBeUndefined();
  });
});
