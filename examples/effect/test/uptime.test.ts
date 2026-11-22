import { afterEach, describe, expect, it } from "bun:test";
import { Effect, Layer } from "effect";
import { createMonitorApp } from "../src/create-app";
import { Probe, ProbeFailed } from "../src/probe";

let serial = 0;
const apps: { app: { stop?: () => unknown } }[] = [];
afterEach(async () => {
  for (const { app } of apps.splice(0)) await app.stop?.();
});

/** A fake target: `down` URLs fail, the rest answer 200 in 12 ms. */
const fakeProbe = Layer.succeed(Probe, {
  get: (url) =>
    url.includes("down")
      ? Effect.fail(new ProbeFailed({ reason: "connection refused" }))
      : Effect.succeed({ status: 200, latencyMs: 12 }),
});

function setup() {
  const made = createMonitorApp({
    path: ":memory:",
    probe: fakeProbe,
    serviceName: `uptime_${++serial}`,
    dispatch: { timer: false },
  });
  apps.push(made as never);
  const base = `/api/uptime_${serial}`;
  const call = async (path: string, body?: unknown, headers = {}) => {
    const res = await made.app.handle(
      new Request(`http://localhost${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as any };
  };
  const add = async (url: string) =>
    (await call("/monitor", { name: "site", url })).body as {
      id: string;
      url: string;
    };
  return { ...made, call, add };
}

describe("uptime example", () => {
  it("records an up check from an Effect execute", async () => {
    const { call, add } = setup();
    const monitor = await add("https://example.com/");
    const res = await call("/check", { id: monitor.id });
    expect(res).toEqual({
      status: 200,
      body: { ok: true, status: 200, latencyMs: 12, error: null },
    });
    const last = await call(`/status?id=${monitor.id}`);
    expect(last.body).toMatchObject({ ok: true, status: 200 });
  });

  it("records a failed probe as a down check, not an error", async () => {
    const { call, add } = setup();
    const monitor = await add("https://down.example.com/");
    const res = await call("/check", { id: monitor.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: false,
      status: null,
      latencyMs: null,
      error: "connection refused",
    });
  });

  it("answers 404 for an unknown monitor", async () => {
    const { call } = setup();
    const res = await call("/check", { id: "nope" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("scrubs credentials, query string and fragment on read", async () => {
    const { call, add } = setup();
    const monitor = await add(
      "https://user:secret@example.com/health?token=abc#top",
    );
    expect(monitor.url).toBe("https://example.com/health");
    const list = await call("/monitor/query", {});
    expect(list.body.items[0].url).toBe("https://example.com/health");
  });

  it("reads a stored invalid URL as empty instead of failing the list", async () => {
    const { call, add } = setup();
    await add("not a url");
    const list = await call("/monitor/query", {});
    expect(list.status).toBe(200);
    expect(list.body.items[0].url).toBe("");
  });

  it("lets only an admin clear checks, through an Effect context and authorize", async () => {
    const { call } = setup();
    expect((await call("/clear-checks", {})).status).toBe(401);
    const res = await call("/clear-checks", {}, { "x-admin": "1" });
    expect(res).toEqual({ status: 200, body: { cleared: true } });
  });

  it("checks every monitor from a schedule that returns an Effect", async () => {
    const { app, call, add } = setup();
    const up = await add("https://example.com/");
    const down = await add("https://down.example.com/");
    expect(await app.events!.schedules!.drain()).toBe(1);
    expect((await call(`/status?id=${up.id}`)).body.ok).toBe(true);
    expect((await call(`/status?id=${down.id}`)).body.ok).toBe(false);
  });
});
