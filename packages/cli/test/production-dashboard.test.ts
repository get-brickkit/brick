import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { connect } from "node:net";
import { context, propagation, trace } from "@opentelemetry/api";
import {
  defineAction,
  defineService,
  resetGlobalRegistry,
  t,
  brick,
} from "@brickkit/core";
import { startDevDashboard } from "../src/dev-dashboard";
import { captureConsole } from "../src/dev-telemetry";
import { DevTelemetryStore } from "../src/dev-telemetry-store";
import { startProductionDashboard } from "../src/production-dashboard";

const token = "0123456789abcdef-secret";
const bearer = { authorization: `Bearer ${token}` };
const CAPTURE = Symbol.for("brickkit.logs.capture");

/** Start with no tracing and an untouched console, and end the same way. */
function reset() {
  captureConsole()();
  (globalThis as Record<symbol, unknown>)[CAPTURE] = undefined;
  trace.disable();
  context.disable();
  propagation.disable();
}
beforeEach(() => {
  reset();
  resetGlobalRegistry();
});
afterEach(reset);

/** One raw request, so the Host header can be anything. */
function raw(port: number, host: string, extra = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET /api/state HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: close\r\n\r\n`,
      );
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => resolve(data.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

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
        // The workflow inspector can cancel runs: a developer's tool only.
        "/workflows/",
      ])
        expect(await answer(path)).toBe(404);
      for (const path of [
        "/api/ingest",
        "/api/restart",
        "/api/proxy",
        "/workflows/api/rpc",
      ])
        expect(await answer(path, "POST")).toBe(404);
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

/** A port nothing is listening on, for an app that asks for it by number. */
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const { port } = server;
  await server.stop(true);
  return port!;
}

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
      // Records are batched, and sent a moment after the spans end.
      await new Promise((resolve) => setTimeout(resolve, 120));

      const state = await (
        await fetch(`http://127.0.0.1:${port}/api/state`, { headers: bearer })
      ).json();
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
