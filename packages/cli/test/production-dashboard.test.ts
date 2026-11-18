import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  defineAction,
  defineDatabase,
  defineSchedule,
  defineService,
  resetGlobalRegistry,
  scheduleTable,
  syncSchema,
  t,
  brick,
} from "@brickkit/core";
import { startDevDashboard } from "../src/dev-dashboard";
import { startInspector } from "../src/dev-inspector";
import { DevTelemetryStore } from "../src/dev-telemetry-store";
import { startProductionDashboard } from "../src/production-dashboard";
import { freePort, raw, resetTracing, waitFor } from "./helpers";

const token = "0123456789abcdef-secret";
const bearer = { authorization: `Bearer ${token}` };
beforeEach(() => {
  resetTracing();
  resetGlobalRegistry();
});
afterEach(resetTracing);

async function production(
  options: Partial<Parameters<typeof startDevDashboard>[0]> = {},
) {
  const store = new DevTelemetryStore();
  const dashboard = await startDevDashboard({
    port: 0,
    store,
    mode: "production",
    auth: { token },
    ...options,
  });
  return { store, dashboard, base: `http://127.0.0.1:${dashboard.port}` };
}

describe("the production dashboard server", () => {
  it("refuses everything but /_health without access", async () => {
    const { dashboard, base } = await production();
    try {
      for (const path of ["/", "/api/state", "/api/events", "/assets/app.js"]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status).toBe(401);
        expect(response.headers.get("www-authenticate")).toContain("Basic");
      }
      expect((await fetch(`${base}/_health`)).status).toBe(200);
      const signedIn = await fetch(`${base}/api/state`, { headers: bearer });
      expect(signedIn.status).toBe(200);
      expect((await signedIn.json()).mode).toBe("production");
    } finally {
      dashboard.stop();
    }
  });

  it("serves only what monitoring needs, even to someone signed in", async () => {
    const { dashboard, base } = await production();
    try {
      const answer = async (path: string, method = "GET") =>
        (
          await fetch(`${base}${path}`, {
            method,
            headers: { ...bearer, "x-brick-dashboard": "1" },
          })
        ).status;
      expect(await answer("/")).toBe(200);
      for (const path of [
        "/api/proxy?url=http://127.0.0.1:1/",
        "/api/openapi",
        "/api/docs",
        "/api/docs/search?q=x",
        "/workflows/",
        "/api/schedules",
      ])
        expect(await answer(path)).toBe(404);
      for (const path of [
        "/api/ingest",
        "/api/restart",
        "/api/proxy",
        "/workflows/api/rpc",
        "/api/schedules/backup",
      ])
        expect(await answer(path, "POST")).toBe(404);
      const state = await fetch(`${base}/api/state`, { headers: bearer });
      expect((await state.json()).hiddenViews.sort()).toEqual([
        "apis",
        "docs",
        "schedules",
        "workflows",
      ]);
    } finally {
      dashboard.stop();
    }
  });

  it("sends headers that keep the page framed by nobody and out of caches", async () => {
    const { dashboard, base } = await production();
    try {
      const response = await fetch(`${base}/`, { headers: bearer });
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("frame-ancestors 'none'");
      // The sign-in answer is covered too.
      const refused = await fetch(`${base}/api/state`);
      expect(refused.headers.get("x-frame-options")).toBe("DENY");
    } finally {
      dashboard.stop();
    }
  });

  it("reports in /_health whether the app answers, for uptime monitors", async () => {
    let up = true;
    const { dashboard, base } = await production({ probe: async () => up });
    try {
      const ok = await fetch(`${base}/_health`);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ status: "ok", app: "up" });
      up = false;
      const down = await fetch(`${base}/_health`);
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual({ status: "degraded", app: "down" });
      expect(down.headers.get("cache-control")).toBe("no-store");
    } finally {
      dashboard.stop();
    }
  });

  it("counts an app that cannot answer, or that hangs, as down", async () => {
    const { dashboard, base } = await production({
      probe: () => Promise.reject(new Error("refused")),
    });
    try {
      expect((await fetch(`${base}/_health`)).status).toBe(503);
    } finally {
      dashboard.stop();
    }
  });

  it("will not listen beyond loopback without access control", async () => {
    await expect(
      startDevDashboard({
        port: 0,
        host: "0.0.0.0",
        store: new DevTelemetryStore(),
        mode: "production",
      }),
    ).rejects.toThrow(/needs access control/);
    // Loopback is as private as the machine, so it may go without.
    const { dashboard, base } = await production({ auth: undefined });
    try {
      expect((await fetch(`${base}/api/state`)).status).toBe(200);
    } finally {
      dashboard.stop();
    }
  });

  it("answers any host name when it listens beyond loopback, and only local ones on it", async () => {
    const open = await production({ host: "0.0.0.0" });
    try {
      // The host is whatever the reverse proxy forwards.
      expect(
        await raw(
          open.dashboard.port,
          "monitor.example.com",
          `Authorization: Bearer ${token}\r\n`,
        ),
      ).toBe("HTTP/1.1 200 OK");
      expect(await raw(open.dashboard.port, "monitor.example.com")).toBe(
        "HTTP/1.1 401 Unauthorized",
      );
    } finally {
      open.dashboard.stop();
    }
    const local = await production();
    try {
      expect(
        await raw(
          local.dashboard.port,
          "evil.example",
          `Authorization: Bearer ${token}\r\n`,
        ),
      ).toBe("HTTP/1.1 403 Forbidden");
    } finally {
      local.dashboard.stop();
    }
  });

  it("lets the app's own check decide, and passes its redirect on", async () => {
    const { dashboard, base } = await production({
      auth: {
        authorize: (request) =>
          request.headers.get("cookie")?.includes("session=ok")
            ? true
            : new Response(null, {
                status: 302,
                headers: { location: "https://app.example.com/login" },
              }),
      },
    });
    try {
      const signedIn = await fetch(`${base}/api/state`, {
        headers: { cookie: "session=ok" },
      });
      expect(signedIn.status).toBe(200);
      const out = await fetch(`${base}/api/state`, { redirect: "manual" });
      expect(out.status).toBe(302);
      expect(out.headers.get("location")).toBe("https://app.example.com/login");
    } finally {
      dashboard.stop();
    }
  });
});

describe("the production dashboard with the inspector", () => {
  const staff = { cookie: "session=staff" };
  const ownPage = (base: string) => ({
    origin: base,
    "sec-fetch-site": "same-origin",
  });

  async function withInspector(
    run: (context: {
      base: string;
      triggered: string[];
      cancelled: unknown[];
    }) => Promise<void>,
  ) {
    const triggered: string[] = [];
    const cancelled: unknown[] = [];
    const inspector = await startInspector({
      events: {
        workflows: {
          world: {
            runs: {
              list: async () => ({ data: [], cursor: null, hasMore: false }),
              get: async () => ({ runId: "run_1", status: "running" }),
            },
            events: {
              create: async (...event: unknown[]) => {
                cancelled.push(event);
                return {};
              },
            },
          },
        },
        schedules: {
          list: async () => [{ name: "backup" }],
          trigger: async (name: string) => {
            triggered.push(name);
            return true;
          },
        },
        describe: () => ({ schedules: [{ name: "backup" }] }),
      },
    } as never);
    const { store, dashboard, base } = await production({
      inspector: true,
      auth: {
        token,
        authorize: (request) => {
          const cookie = request.headers.get("cookie") ?? "";
          if (cookie.includes("session=staff")) return { user: { id: "u1" } };
          return cookie.includes("session=anonymous");
        },
      },
    });
    store.setInspector(inspector!);
    try {
      await run({ base, triggered, cancelled });
    } finally {
      dashboard.stop();
      inspector!.stop();
    }
  }

  const rpc = (base: string, method: string, headers: object) =>
    fetch(`${base}/workflows/api/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...ownPage(base),
        ...headers,
      },
      body: JSON.stringify({ method, params: { runId: "run_1" } }),
    });

  it("shows the two views and lists the schedules to anyone it lets in, and to nobody else", async () => {
    await withInspector(async ({ base }) => {
      expect((await fetch(`${base}/api/schedules`)).status).toBe(401);
      expect((await fetch(`${base}/workflows/`)).status).toBe(401);
      for (const headers of [bearer, staff]) {
        const list = await fetch(`${base}/api/schedules`, { headers });
        expect(await list.json()).toEqual([{ name: "backup" }]);
        const state = await fetch(`${base}/api/state`, { headers });
        expect(await state.json()).toMatchObject({
          inspector: true,
          hiddenViews: ["docs", "apis"],
        });
      }
    });
  });

  it("lets the dashboard, and nothing else, frame the inspector", async () => {
    await withInspector(async ({ base }) => {
      for (const path of ["/workflows/", "/workflows/run/run_1"]) {
        const frame = await fetch(`${base}${path}`, { headers: bearer });
        expect(frame.status).toBe(200);
        expect(frame.headers.get("content-type")).toContain("text/html");
        expect(frame.headers.get("x-frame-options")).toBe("SAMEORIGIN");
        const policy = frame.headers.get("content-security-policy") ?? "";
        expect(policy).toContain("frame-ancestors 'self'");
        expect(policy).toContain("default-src 'self'");
        expect(policy).toContain("connect-src 'self'");
        expect(policy).toContain(
          "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';",
        );
        expect(frame.headers.get("x-content-type-options")).toBe("nosniff");
        expect(frame.headers.get("cache-control")).toBe("no-store");
      }
      for (const path of ["/", "/api/state", "/api/schedules"]) {
        const other = await fetch(`${base}${path}`, { headers: bearer });
        expect(other.headers.get("x-frame-options")).toBe("DENY");
        const policy = other.headers.get("content-security-policy") ?? "";
        expect(policy).toContain("frame-ancestors 'none'");
        expect(policy).not.toContain("wasm-unsafe-eval");
      }
    });
  });

  it("runs a schedule for a signed-in user on the dashboard's own page, and for nobody else", async () => {
    await withInspector(async ({ base, triggered }) => {
      const run = (headers: object) =>
        fetch(`${base}/api/schedules/backup`, { method: "POST", headers });

      expect((await run(ownPage(base))).status).toBe(401);
      for (const headers of [bearer, { cookie: "session=anonymous" }]) {
        const refused = await run({ ...ownPage(base), ...headers });
        expect(refused.status).toBe(403);
        expect(await refused.text()).toContain("sign in as a user");
      }
      for (const headers of [
        { origin: "https://evil.example" },
        { "sec-fetch-site": "cross-site" },
      ])
        expect((await run({ ...staff, ...headers })).status).toBe(403);
      expect(triggered).toEqual([]);

      const started = await run({ ...staff, ...ownPage(base) });
      expect(await started.json()).toEqual({ started: true });
      expect(triggered).toEqual(["backup"]);
    });
  });

  it("lets a token read runs, and only a signed-in user change one", async () => {
    await withInspector(async ({ base, cancelled }) => {
      expect((await rpc(base, "fetchRuns", bearer)).status).toBe(200);
      for (const method of ["cancelRun", "recreateRun", "resumeHook"])
        expect((await rpc(base, method, bearer)).status).toBe(403);
      expect(cancelled).toEqual([]);
      expect((await rpc(base, "cancelRun", staff)).status).toBe(200);
      expect(cancelled).toHaveLength(1);
      const foreign = await rpc(base, "cancelRun", {
        ...staff,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      });
      expect(foreign.status).toBe(403);
      expect(cancelled).toHaveLength(1);
    });
  });
});

describe("startProductionDashboard", () => {
  function appWith(dashboard: object) {
    const service = defineService("pages", {});
    service.action(
      defineAction({
        name: "echo",
        input: t.Object({ message: t.String() }),
        output: t.Object({ message: t.String() }),
        execute: async ({ input, ctx }) => {
          ctx.logger.info("echoing", { length: input.message.length });
          console.log("also with console", input.message);
          return { message: input.message };
        },
      }),
    );
    return brick({ services: [service], requestLogging: false, dashboard });
  }

  it("does nothing for an app that asks for no dashboard", async () => {
    const app = brick({ services: [defineService("pages", {})] });
    expect(await startProductionDashboard(app, { appPort: 1 })).toBeUndefined();
  });

  it("refuses to start for an address others can reach, with no access control", async () => {
    const app = appWith({ port: await freePort(), host: "0.0.0.0" });
    await expect(startProductionDashboard(app, { appPort: 1 })).rejects.toThrow(
      /needs access control/,
    );
  });

  it("carries what ctx.logger and console write during a request to the dashboard, not the console", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const port = await freePort();
    const app = appWith({ port, auth: { token } });
    const dashboard = await startProductionDashboard(app, { appPort: 1 });
    try {
      expect(dashboard).toMatchObject({ host: "127.0.0.1", port });
      const response = await app.handle(
        new Request("http://localhost/api/pages/echo", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: "hello" }),
        }),
      );
      expect(response.status).toBe(200);
      let state: any;
      await waitFor(
        async () =>
          (state = await (
            await fetch(`http://127.0.0.1:${port}/api/state`, {
              headers: bearer,
            })
          ).json()).traces.length > 0,
      );
      expect(state.mode).toBe("production");
      expect(state.reloads[0]).toMatchObject({
        kind: "started",
        detail: "application started",
      });
      expect(state.architecture.schema.services[0].name).toBe("pages");
      const lines = state.traces
        .flatMap((summary: { spans: { events: unknown[] }[] }) =>
          summary.spans.flatMap((span) => span.events),
        )
        .filter((event: { name: string }) => event.name === "log")
        .map(
          (event: { attributes: Record<string, string> }) =>
            event.attributes["log.message"],
        );
      expect(lines).toEqual([
        "echoing { length: 5 }",
        "also with console hello",
      ]);
      expect(log).not.toHaveBeenCalled();
    } finally {
      dashboard?.stop();
      log.mockRestore();
    }
  });

  it("serves the schedules of an app that asks for the inspector, until it stops", async () => {
    const schedules = scheduleTable("sqlite");
    const database = defineDatabase({ tables: { schedules } });
    syncSchema([schedules], database.getDb());
    const port = await freePort();
    const serve = spyOn(Bun, "serve");
    const app = brick({
      services: [defineService("reports", { database })],
      events: {
        schedules: [
          defineSchedule({ name: "nightly", every: "6h", run: () => {} }),
        ],
      },
      requestLogging: false,
      docs: false,
      dashboard: { port, auth: { token }, inspector: true },
    });
    const warnings: string[] = [];
    const dashboard = await startProductionDashboard(app, {
      appPort: 1,
      warn: (message) => warnings.push(message),
    });
    const inspector = serve.mock.results
      .map((result) => result.value as { port: number; hostname: string })
      .find((server) => server.port !== port)!;
    serve.mockRestore();
    try {
      expect(warnings).toEqual([]);
      expect(inspector.hostname).toBe("127.0.0.1");
      const base = `http://127.0.0.1:${port}`;
      const list = await fetch(`${base}/api/schedules`, { headers: bearer });
      expect(await list.json()).toMatchObject([{ name: "nightly" }]);
      const state = await (
        await fetch(`${base}/api/state`, { headers: bearer })
      ).json();
      expect(state.inspector).toBe(false);
      expect(state.hiddenViews).not.toContain("schedules");
      const direct = `http://127.0.0.1:${inspector.port}/api/schedules`;
      expect((await fetch(direct)).status).toBe(403);
      dashboard?.stop();
      await expect(fetch(direct)).rejects.toThrow();
    } finally {
      dashboard?.stop();
    }
  });

  it("starts without the two views, and says why once, when the app has nothing for them", async () => {
    const port = await freePort();
    const warnings: string[] = [];
    const dashboard = await startProductionDashboard(
      appWith({ port, auth: { token }, inspector: true }),
      { appPort: 1, warn: (message) => warnings.push(message) },
    );
    try {
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("no workflows and no schedules");
      const base = `http://127.0.0.1:${port}`;
      const state = await (
        await fetch(`${base}/api/state`, { headers: bearer })
      ).json();
      expect(state.hiddenViews).toEqual(
        expect.arrayContaining(["schedules", "workflows"]),
      );
      const list = await fetch(`${base}/api/schedules`, { headers: bearer });
      expect(list.status).toBe(404);
    } finally {
      dashboard?.stop();
    }
  });

  it("keeps running without a dashboard when its port is taken, and says so", async () => {
    // On the same address as the dashboard would use: a wildcard listener does
    // not stop a specific address on every platform.
    const taken = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(),
    });
    const warnings: string[] = [];
    try {
      const app = appWith({ port: taken.port, auth: { token } });
      const dashboard = await startProductionDashboard(app, {
        appPort: 1,
        warn: (message) => warnings.push(message),
      });
      expect(dashboard).toBeUndefined();
      expect(warnings.join("\n")).toMatch(/Continuing without the dashboard/);
    } finally {
      await taken.stop(true);
    }
  });
});
