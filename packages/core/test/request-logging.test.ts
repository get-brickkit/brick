import { describe, it, expect, beforeEach } from "bun:test";
import {
  defineService,
  defineAction,
  resetGlobalRegistry,
  t,
  ActionExecutionError,
  brick,
} from "@brickkit/core";

function makeService() {
  const svc = defineService("items");

  const listItems = defineAction({
    name: "listItems",
    method: "GET",
    output: t.Object({ items: t.Array(t.String()) }),
    execute: async () => ({ items: ["a"] }),
  });

  const boom = defineAction({
    name: "boom",
    output: t.Object({ ok: t.Boolean() }),
    execute: async () => {
      throw new ActionExecutionError("BOOM", "kaput", 422);
    },
  });

  svc.action(listItems);
  svc.action(boom);
  return svc;
}

describe("request logging & reference docs", () => {
  beforeEach(() => {
    resetGlobalRegistry();
  });

  it("keeps normal GET at 200 and logs `METHOD path → status`", async () => {
    const lines: string[] = [];
    const app = brick({
      services: [makeService()],
      requestLogging: { logger: (msg) => lines.push(msg) },
    });

    const res = await app.handle(
      new Request("http://localhost/api/items/list-items"),
    );
    expect(res.status).toBe(200);

    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^GET \/api\/items\/list-items → 200 \(\d+ms\)$/);
  });

  it("preserves mapped error responses while logging them", async () => {
    const lines: string[] = [];
    const app = brick({
      services: [makeService()],
      requestLogging: { logger: (msg) => lines.push(msg) },
    });

    const res = await app.handle(
      new Request("http://localhost/api/items/boom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("BOOM");

    expect(
      lines.some((l) => /^POST \/api\/items\/boom → 422 \(\d+ms\)$/.test(l)),
    ).toBe(true);
  });

  it("logs the status of a Response returned by a raw route", async () => {
    const lines: string[] = [];
    const app = brick({
      services: [makeService()],
      requestLogging: { logger: (msg) => lines.push(msg) },
    });
    app.post("/raw", () => Response.json({ error: "nope" }, { status: 403 }));

    const res = await app.handle(
      new Request("http://localhost/raw", { method: "POST" }),
    );
    expect(res.status).toBe(403);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^POST \/raw → 403 \(\d+ms\)$/);
  });

  it("logs framework errors (404) without changing the response", async () => {
    const lines: string[] = [];
    const app = brick({
      services: [makeService()],
      requestLogging: { logger: (msg) => lines.push(msg) },
    });

    const res = await app.handle(new Request("http://localhost/nope"));
    expect(res.status).toBe(404);
    expect(lines.some((l) => /^GET \/nope → 404 \(\d+ms\)$/.test(l))).toBe(
      true,
    );
  });

  it("serves Scalar HTML on GET /reference when enabled", async () => {
    const app = brick({
      services: [],
      requestLogging: false,
      reference: { path: "/reference", title: "Test API" },
    });

    const res = await app.handle(new Request("http://localhost/reference"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("@scalar/api-reference");
    expect(html).toContain('data-url="/openapi.json"');
    expect(html).toContain("Test API — API Reference");
  });

  it("defaults reference specUrl to a custom openApiPath", async () => {
    const app = brick({
      services: [],
      requestLogging: false,
      openApiPath: "/spec.json",
      reference: true,
    });

    const res = await app.handle(new Request("http://localhost/reference"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('data-url="/spec.json"');
  });

  it("serves a reference page only for true or options with a path", async () => {
    const status = async (
      reference: NonNullable<Parameters<typeof brick>[0]>["reference"],
    ) =>
      (
        await brick({ services: [], requestLogging: false, reference }).handle(
          new Request("http://localhost/reference"),
        )
      ).status;
    expect(await status(true)).toBe(200);
    expect(await status({ path: "/reference" })).toBe(200);
    // Options without a path (a title, or extra documents for the dashboard)
    // do not add a page.
    expect(await status({ title: "Test API" })).toBe(404);
    expect(
      await status({
        documents: [{ title: "Auth", document: { openapi: "3.1.0" } }],
      }),
    ).toBe(404);
  });

  it("returns 404 for /reference when disabled (default)", async () => {
    const app = brick({
      services: [],
      requestLogging: false,
    });

    const res = await app.handle(new Request("http://localhost/reference"));
    expect(res.status).toBe(404);
  });

  it("emits nothing when requestLogging is false", async () => {
    const originalLog = console.log;
    const calls: string[] = [];
    console.log = (...args: unknown[]) => {
      calls.push(args.map(String).join(" "));
    };
    try {
      const app = brick({
        services: [makeService()],
        requestLogging: false,
      });
      const res = await app.handle(
        new Request("http://localhost/api/items/list-items"),
      );
      expect(res.status).toBe(200);
      expect(calls).toEqual([]);
    } finally {
      console.log = originalLog;
    }
  });

  it("emits nothing when requestLogging is disabled via options object", async () => {
    const lines: string[] = [];
    const app = brick({
      services: [makeService()],
      requestLogging: { enabled: false, logger: (msg) => lines.push(msg) },
    });

    const res = await app.handle(
      new Request("http://localhost/api/items/list-items"),
    );
    expect(res.status).toBe(200);
    expect(lines).toEqual([]);
  });
});
