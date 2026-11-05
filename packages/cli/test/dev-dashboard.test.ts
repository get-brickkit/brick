import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDevDashboard } from "../src/dev-dashboard";
import { openHistory } from "../src/dev-history";
import { DevTelemetryStore } from "../src/dev-telemetry-store";
import { historyUrl, type TraceSummary } from "../src/dashboard-protocol";

async function setup(restart?: () => void) {
  const store = new DevTelemetryStore();
  const dashboard = await startDevDashboard({ port: 0, store, restart });
  return { store, dashboard, base: `http://localhost:${dashboard.port}` };
}

function rawStatusLine(port: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET /api/state HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
      );
    });
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("end", () => resolve(data.split("\r\n")[0]));
    socket.on("error", reject);
  });
}

describe("startDevDashboard", () => {
  it("serves the page and a JSON snapshot of recorded telemetry", async () => {
    const { store, dashboard, base } = await setup(() => {});
    try {
      store.recordReload({ kind: "started", generation: 1 });

      const page = await fetch(`${base}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("Brick dev");

      const state = await fetch(`${base}/api/state`);
      const snapshot = await state.json();
      expect(snapshot.reloads[0]).toMatchObject({
        kind: "started",
        generation: 1,
      });
      expect(snapshot.traces).toEqual([]);
      expect(snapshot.canRestart).toBe(true);
    } finally {
      dashboard.stop();
    }
  });

  it("rejects requests that do not name a local host", async () => {
    const { dashboard } = await setup();
    try {
      expect(await rawStatusLine(dashboard.port, "evil.example")).toBe(
        "HTTP/1.1 403 Forbidden",
      );
      expect(
        await rawStatusLine(dashboard.port, `localhost:${dashboard.port}`),
      ).toBe("HTTP/1.1 200 OK");
    } finally {
      dashboard.stop();
    }
  });

  it("restarts only when the request carries the dashboard header", async () => {
    let restarts = 0;
    const { dashboard, base } = await setup(() => {
      restarts++;
    });
    try {
      const rejected = await fetch(`${base}/api/restart`, { method: "POST" });
      expect(rejected.status).toBe(403);
      expect(restarts).toBe(0);

      const accepted = await fetch(`${base}/api/restart`, {
        method: "POST",
        headers: { "x-brick-dashboard": "1" },
      });
      expect(accepted.status).toBe(202);
      expect(restarts).toBe(1);
    } finally {
      dashboard.stop();
    }
  });

  it("hides restart when the host cannot restart the application", async () => {
    const { dashboard, base } = await setup();
    try {
      const snapshot = await (await fetch(`${base}/api/state`)).json();
      expect(snapshot.canRestart).toBe(false);

      const response = await fetch(`${base}/api/restart`, {
        method: "POST",
        headers: { "x-brick-dashboard": "1" },
      });
      expect(response.status).toBe(404);
    } finally {
      dashboard.stop();
    }
  });

  it("streams a snapshot, then live events as they are recorded", async () => {
    const { store, dashboard, base } = await setup();
    const response = await fetch(`${base}/api/events`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (marker: string) => {
      while (!buffer.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`Stream ended before ${marker}`);
        buffer += decoder.decode(value);
      }
    };
    try {
      await readUntil("event: snapshot");
      store.recordReload({ kind: "restarting", generation: 1 });
      await readUntil("event: reload");
      expect(buffer).toContain('"kind":"restarting"');
    } finally {
      await reader.cancel();
      dashboard.stop();
    }
  });

  it("accepts span batches and worker notices from an application process", async () => {
    const { store, dashboard, base } = await setup();
    try {
      const body = JSON.stringify({
        worker: "application loaded",
        records: [
          {
            phase: "start",
            traceId: "worker-trace",
            spanId: "root",
            name: "GET /api/worker",
            startMs: 1000,
            attributes: { "http.route": "/api/worker" },
          },
          {
            phase: "end",
            traceId: "worker-trace",
            spanId: "root",
            name: "GET /api/worker",
            endMs: 1004,
            status: "ok",
            attributes: { "http.response.status_code": 200 },
            events: [],
          },
        ],
      });
      const rejected = await fetch(`${base}/api/ingest`, {
        method: "POST",
        body,
      });
      expect(rejected.status).toBe(403);

      const accepted = await fetch(`${base}/api/ingest`, {
        method: "POST",
        headers: { "x-brick-dashboard": "1" },
        body,
      });
      expect(accepted.status).toBe(204);

      const snapshot = store.snapshot();
      expect(snapshot.traces[0]).toMatchObject({
        route: "/api/worker",
        status: "ok",
        durationMs: 4,
      });
      expect(snapshot.reloads[0]).toMatchObject({
        kind: "started",
        generation: 1,
        detail: "application loaded",
      });
    } finally {
      dashboard.stop();
    }
  });

  it("serves the built React app and its fonts from /assets", async () => {
    const { dashboard, base } = await setup();
    try {
      const page = await (await fetch(`${base}/`)).text();
      expect(page).toContain('<div id="root"></div>');
      expect(page).toContain("/assets/app.js");

      const script = await fetch(`${base}/assets/app.js`);
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("text/javascript");
      expect((await script.text()).length).toBeGreaterThan(10_000);

      const styles = await fetch(`${base}/assets/app.css`);
      expect(styles.headers.get("content-type")).toContain("text/css");
      // Every font the stylesheet points at must be served from /assets.
      const fonts = [
        ...(await styles.text()).matchAll(/url\(([^)]+\.woff2)\)/g),
      ].map((match) => match[1].replace(/["']/g, ""));
      expect(fonts.length).toBeGreaterThan(0);
      for (const font of fonts) {
        expect(font.startsWith("/assets/")).toBe(true);
        const response = await fetch(`${base}${font}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("font/woff2");
      }

      const font = await fetch(`${base}/assets/Geist-Variable.woff2`);
      expect(font.headers.get("content-type")).toBe("font/woff2");
    } finally {
      dashboard.stop();
    }
  });

  it("refuses asset paths that could leave the assets folder", async () => {
    const { dashboard, base } = await setup();
    try {
      for (const path of [
        "..%2Fpackage.json",
        "..%2F..%2Fsrc%2Fdev-dashboard.ts",
        ".hidden",
        "missing.js",
      ]) {
        const response = await fetch(`${base}/assets/${path}`);
        expect(response.status).toBe(404);
      }
    } finally {
      dashboard.stop();
    }
  });

  it("serves request history from disk only when history is on", async () => {
    const off = await setup();
    try {
      const state = await (await fetch(`${off.base}/api/state`)).json();
      expect(state.historyDays).toBe(0);
      expect((await fetch(`${off.base}${historyUrl("summary")}`)).status).toBe(
        404,
      );
    } finally {
      off.dashboard.stop();
    }

    const directory = mkdtempSync(join(tmpdir(), "brick-dashboard-history-"));
    const history = (await openHistory({ directory, days: 90 }))!;
    const store = new DevTelemetryStore({ history });
    const dashboard = await startDevDashboard({ port: 0, store, history });
    const base = `http://localhost:${dashboard.port}`;
    try {
      const now = Date.now();
      const saved = (id: string, httpStatus: number, durationMs: number) =>
        history.saveTrace({
          traceId: id,
          name: "GET /api/pages",
          method: "GET",
          route: "/api/pages",
          path: "/api/pages",
          httpStatus,
          generation: 1,
          startMs: now - durationMs,
          endMs: now,
          durationMs,
          status: "ok",
          truncated: false,
          spans: [],
        } satisfies TraceSummary);
      saved("fast", 200, 5);
      saved("slow", 200, 500);
      saved("missing", 404, 8);
      const window = `from=${now - 60_000}&to=${now + 1_000}`;

      expect(
        (await (await fetch(`${base}/api/state`)).json()).historyDays,
      ).toBe(90);
      const info = await (await fetch(`${base}/api/history`)).json();
      expect(info).toMatchObject({ days: 90, count: 3 });

      const summary = await (
        await fetch(`${base}/api/history/summary?${window}`)
      ).json();
      expect(summary).toMatchObject({
        total: 3,
        clientErrors: 1,
        serverErrors: 0,
      });
      const filtered = await (
        await fetch(`${base}/api/history/summary?${window}&outcome=ok`)
      ).json();
      expect(filtered.total).toBe(2);

      const slowest = await (
        await fetch(
          `${base}/api/history/traces?${window}&sort=slowest&limit=1&outcome=ok`,
        )
      ).json();
      expect(slowest.total).toBe(2);
      expect(
        slowest.traces.map((trace: { traceId: string }) => trace.traceId),
      ).toEqual(["slow"]);

      const facets = await (
        await fetch(`${base}/api/history/facets?${window}&outcome=ok`)
      ).json();
      expect(facets.method).toEqual([{ value: "GET", count: 2 }]);
      // The outcome counts ignore the outcome choice itself.
      expect(facets.outcome).toEqual([
        { value: "ok", count: 2 },
        { value: "client", count: 1 },
      ]);

      const volume = await (
        await fetch(`${base}/api/history/volume?${window}`)
      ).json();
      const counted = volume.reduce(
        (sum: number, bucket: { ok: number; client: number; server: number }) =>
          sum + bucket.ok + bucket.client + bucket.server,
        0,
      );
      expect(counted).toBe(3);

      const exported = await fetch(
        `${base}/api/history/export?${window}&outcome=client`,
      );
      expect(exported.headers.get("content-type")).toContain("text/csv");
      expect(exported.headers.get("content-disposition")).toContain(
        "brick-requests.csv",
      );
      const csv = (await exported.text()).trim().split("\n");
      expect(csv).toHaveLength(2);
      expect(csv[1]).toContain("404,client");

      const detail = await fetch(`${base}/api/history/traces/missing`);
      expect(detail.status).toBe(200);
      expect((await detail.json()).httpStatus).toBe(404);
      expect((await fetch(`${base}/api/history/traces/nope`)).status).toBe(404);
      // A malformed escape is the caller's mistake, not a failed query.
      expect((await fetch(`${base}/api/history/traces/%E0%A4%A`)).status).toBe(
        400,
      );

      // A query that fails is logged, not swallowed.
      const { Database } = (await import("bun:sqlite")) as {
        Database: new (file: string) => {
          exec(sql: string): void;
          close(): void;
        };
      };
      const raw = new Database(join(directory, ".brick", "telemetry.sqlite"));
      raw.exec("DROP TABLE traces");
      raw.close();
      const logged = spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(
          (await fetch(`${base}/api/history/summary?${window}`)).status,
        ).toBe(500);
        expect(String(logged.mock.calls[0]?.[0])).toContain(
          "history query failed",
        );
      } finally {
        logged.mockRestore();
      }
    } finally {
      dashboard.stop();
      history.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("serves the app's OpenAPI documents to the APIs view", async () => {
    const { store, dashboard, base } = await setup();
    try {
      expect(await (await fetch(`${base}/api/openapi`)).json()).toEqual([]);
      store.setApiDocuments(
        [{ title: "Orders API", document: { openapi: "3.1.0", paths: {} } }],
        "http://localhost:4000",
      );
      const response = await fetch(`${base}/api/openapi`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual([
        { title: "Orders API", document: { openapi: "3.1.0", paths: {} } },
      ]);
      // The live snapshot carries only the names, so it stays small.
      const snapshot = await (await fetch(`${base}/api/state`)).json();
      expect(snapshot.api).toEqual({
        revision: 1,
        appUrl: "http://localhost:4000",
        titles: ["Orders API"],
      });
    } finally {
      dashboard.stop();
    }
  });

  describe("proxy for the APIs view", () => {
    async function withApp<T>(
      run: (context: {
        store: DevTelemetryStore;
        base: string;
        app: string;
        send: (target: string, init?: RequestInit) => Promise<Response>;
      }) => Promise<T>,
    ): Promise<T> {
      const target = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/gone") {
            return new Response(null, {
              status: 302,
              headers: { location: "/elsewhere" },
            });
          }
          return Response.json(
            {
              method: request.method,
              path: url.pathname + url.search,
              body: await request.text(),
              authorization: request.headers.get("authorization"),
              origin: request.headers.get("origin"),
              cookie: request.headers.get("cookie"),
              secFetch: request.headers.get("sec-fetch-mode"),
            },
            { status: 201, headers: { "x-from-app": "yes" } },
          );
        },
      });
      const { store, dashboard, base } = await setup();
      const app = `http://localhost:${target.port}`;
      store.setApiDocuments([], app);
      try {
        return await run({
          store,
          base,
          app,
          send: (address, init) =>
            fetch(`${base}/api/proxy?url=${encodeURIComponent(address)}`, init),
        });
      } finally {
        dashboard.stop();
        target.stop(true);
      }
    }

    it("sends a request on to the app and returns what the app answers", async () => {
      await withApp(async ({ app, send }) => {
        const response = await send(`${app}/api/echo?x=1`, {
          method: "POST",
          headers: {
            authorization: "Bearer token",
            "content-type": "application/json",
            cookie: "dashboard=1",
          },
          body: JSON.stringify({ text: "hi" }),
        });
        expect(response.status).toBe(201);
        expect(response.headers.get("x-from-app")).toBe("yes");
        expect(await response.json()).toEqual({
          method: "POST",
          path: "/api/echo?x=1",
          body: '{"text":"hi"}',
          authorization: "Bearer token",
          // What belongs to the dashboard's page does not reach the app.
          origin: null,
          cookie: null,
          secFetch: null,
        });
      });
    });

    it("sends only the cookies typed into Try it, as ?cookie=", async () => {
      await withApp(async ({ app, base }) => {
        const response = await fetch(
          `${base}/api/proxy?url=${encodeURIComponent(`${app}/api/me`)}&cookie=${encodeURIComponent("session=abc; theme=dark")}`,
          // The dashboard page's own cookie is not what the app is sent.
          { headers: { cookie: "dashboard=1" } },
        );
        expect((await response.json()).cookie).toBe("session=abc; theme=dark");
      });
    });

    it("hands back redirects instead of following them", async () => {
      await withApp(async ({ app, send }) => {
        // The test client must not follow it either, or it would leave the app.
        const response = await send(`${app}/gone`, { redirect: "manual" });
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/elsewhere");
      });
    });

    it("forwards only to the app being shown", async () => {
      await withApp(async ({ app, send, store }) => {
        expect((await send("http://example.com/")).status).toBe(403);
        // Another port on the same machine is another origin.
        expect((await send("http://localhost:1/")).status).toBe(403);
        expect((await send("not an address")).status).toBe(403);
        // Until the app has said where it listens, nothing is forwarded.
        store.setApiDocuments([]);
        expect((await send(`${app}/api/echo`)).status).toBe(403);
      });
    });

    it("refuses requests from other sites", async () => {
      await withApp(async ({ app, send }) => {
        expect(
          (
            await send(`${app}/api/echo`, {
              headers: { "sec-fetch-site": "cross-site" },
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await send(`${app}/api/echo`, {
              headers: { origin: "https://evil.example" },
            })
          ).status,
        ).toBe(403);
      });
    });

    it("says so when the app cannot be reached", async () => {
      const { store, dashboard, base } = await setup();
      try {
        const closed = Bun.serve({ port: 0, fetch: () => new Response() });
        const address = `http://localhost:${closed.port}`;
        closed.stop(true);
        store.setApiDocuments([], address);
        const response = await fetch(
          `${base}/api/proxy?url=${encodeURIComponent(`${address}/x`)}`,
        );
        expect(response.status).toBe(502);
      } finally {
        dashboard.stop();
      }
    });
  });

  describe("workflow inspector", () => {
    async function withInspector<T>(
      run: (context: {
        store: DevTelemetryStore;
        base: string;
        /** Lets the stream write its second piece. */
        release: () => void;
      }) => Promise<T>,
    ): Promise<T> {
      const token = "secret-token";
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const inspector = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname === "/workflows/stream") {
            // Written in pieces, as a run's output is.
            return new Response(
              new ReadableStream({
                async start(controller) {
                  controller.enqueue(new TextEncoder().encode("one,"));
                  await released;
                  controller.enqueue(new TextEncoder().encode("two"));
                  controller.close();
                },
              }),
            );
          }
          return Response.json(
            {
              method: request.method,
              path: url.pathname + url.search,
              body: await request.text(),
              token: request.headers.get("x-brick-inspector"),
              cookie: request.headers.get("cookie"),
            },
            { status: 201, headers: { "x-from-inspector": "yes" } },
          );
        },
      });
      const { store, dashboard, base } = await setup();
      store.setInspector({ port: inspector.port!, token });
      try {
        return await run({ store, base, release });
      } finally {
        dashboard.stop();
        inspector.stop(true);
      }
    }

    it("tells the page whether an inspector is running", async () => {
      await withInspector(async ({ store, base }) => {
        const state = async () =>
          (
            (await (await fetch(`${base}/api/state`)).json()) as {
              inspector: boolean;
            }
          ).inspector;
        expect(await state()).toBe(true);
        const events = store.subscribe(() => {});
        store.setInspector(undefined);
        events();
        expect(await state()).toBe(false);
      });
    });

    it("passes requests on with the token the dashboard holds, and never the page's cookies", async () => {
      await withInspector(async ({ base }) => {
        const answer = await fetch(`${base}/workflows/run/abc?tab=events`, {
          headers: { cookie: "session=mine", "x-brick-inspector": "guess" },
        });
        expect(answer.status).toBe(201);
        expect(answer.headers.get("x-from-inspector")).toBe("yes");
        expect(await answer.json()).toEqual({
          method: "GET",
          path: "/workflows/run/abc?tab=events",
          body: "",
          token: "secret-token",
          cookie: null,
        });
      });
    });

    it("lets only the dashboard frame it, and leaves the dashboard's own page as it was", async () => {
      await withInspector(async ({ base }) => {
        for (const path of ["/workflows/", "/workflows/run/abc"]) {
          const answer = await fetch(`${base}${path}`);
          expect(answer.headers.get("content-security-policy")).toBe(
            "frame-ancestors 'self'",
          );
          expect(answer.headers.get("x-frame-options")).toBe("SAMEORIGIN");
        }
        const page = await fetch(`${base}/`);
        expect(page.status).toBe(200);
        expect(page.headers.get("content-security-policy")).toBeNull();
        expect(page.headers.get("x-frame-options")).toBeNull();
      });
    });

    it("streams what the inspector writes without waiting for the end", async () => {
      await withInspector(async ({ base, release }) => {
        const answer = await fetch(`${base}/workflows/stream`);
        const reader = answer.body!.getReader();
        // The rest is written only once the first piece came through.
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toBe("one,");
        release();
        const second = await reader.read();
        expect(new TextDecoder().decode(second.value)).toBe("two");
      });
    });

    it("sends the body of a change that comes from the dashboard's own page", async () => {
      await withInspector(async ({ base }) => {
        const answer = await fetch(`${base}/workflows/api/rpc`, {
          method: "POST",
          body: '{"method":"cancelRun"}',
          headers: {
            origin: base,
            "sec-fetch-site": "same-origin",
          },
        });
        expect(answer.status).toBe(201);
        expect(await answer.json()).toMatchObject({
          method: "POST",
          body: '{"method":"cancelRun"}',
        });
      });
    });

    it("takes the page's own changes behind a proxy that terminates TLS", async () => {
      await withInspector(async ({ base }) => {
        const post = (headers: Record<string, string>) =>
          fetch(`${base}/workflows/api/rpc`, {
            method: "POST",
            body: '{"method":"cancelRun"}',
            headers: { origin: base.replace(/^http:/, "https:"), ...headers },
          });
        expect((await post({ "x-forwarded-proto": "https" })).status).toBe(201);
        // Without the proxy's word, an https page is another origin.
        expect((await post({})).status).toBe(403);
      });
    });

    it("refuses a change from another site, but lets it look", async () => {
      await withInspector(async ({ base }) => {
        for (const headers of [
          { origin: "https://evil.example" },
          { "sec-fetch-site": "cross-site" },
          { origin: "null" },
        ])
          expect(
            (
              await fetch(`${base}/workflows/api/rpc`, {
                method: "POST",
                body: '{"method":"cancelRun"}',
                headers,
              })
            ).status,
          ).toBe(403);
        expect(
          (
            await fetch(`${base}/workflows/`, {
              headers: { "sec-fetch-site": "cross-site" },
            })
          ).status,
        ).toBe(201);
      });
    });

    it("says so when there is no inspector, or it cannot be reached", async () => {
      const { store, dashboard, base } = await setup();
      try {
        const none = await fetch(`${base}/workflows/`);
        expect(none.status).toBe(503);
        expect(await none.text()).toContain("inspector is not running");

        const closed = Bun.serve({ port: 0, fetch: () => new Response() });
        const port = closed.port!;
        closed.stop(true);
        store.setInspector({ port, token: "t" });
        expect((await fetch(`${base}/workflows/`)).status).toBe(502);
      } finally {
        dashboard.stop();
      }
    });
  });

  it("explains a port conflict and how to resolve it", async () => {
    const first = await setup();
    try {
      await expect(
        startDevDashboard({
          port: first.dashboard.port,
          store: new DevTelemetryStore(),
        }),
      ).rejects.toThrow(/dashboard port .* is unavailable/);
    } finally {
      first.dashboard.stop();
    }
  });
});
