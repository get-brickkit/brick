import { describe, it, expect, beforeEach } from "bun:test";
import {
  defineService,
  defineDatabase,
  sqliteTable,
  text,
  resetGlobalRegistry,
  ActionExecutionError,
  brick,
} from "@brickkit/core";

describe("@brickkit/cli app.endpoint()", () => {
  beforeEach(() => {
    resetGlobalRegistry();
  });

  it("accepts a database handle without applying schema at startup or on requests", async () => {
    const table = sqliteTable("runtime_untouched", {
      id: text("id").primaryKey(),
    });
    const database = defineDatabase({ tables: { table } });
    const service = defineService("runtime_untouched", { database });
    service.resource({ name: "untouched", table });
    const app = brick({ services: [service], secrets: { validate: false } });
    app.endpoint({
      database,
      method: "GET",
      path: "/database",
      handler: ({ db }) => ({
        same: db === database.getDb(),
      }),
    });
    const response = await app.handle(new Request("http://localhost/database"));
    expect(await response.json()).toEqual({ same: true });
    expect(
      database
        .getDb()
        .all(
          "SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')",
        ),
    ).toEqual([]);
    const architecture = await app.handle(
      new Request("http://localhost/_brick/services"),
    );
    expect(architecture.status).toBe(200);
    expect(await architecture.json()).toBeDefined();
  });

  it("serves a raw HTML endpoint with status and headers", async () => {
    const app = brick({ services: [] });
    app.endpoint({
      handler: ({ params, set }) => {
        set.headers["content-type"] = "text/html; charset=utf-8";
        if (params.slug !== "hello") {
          set.status = 404;
          return "<h1>404</h1>";
        }
        set.status = 200;
        return "<h1>hello</h1>";
      },
      method: "GET",
      path: "/p/:slug",
      summary: "Public page viewer",
    });

    const ok = await app.handle(new Request("http://localhost/p/hello"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/html");
    expect(await ok.text()).toBe("<h1>hello</h1>");
    expect(ok.headers.get("x-trace-id")).toBeDefined();
    expect(ok.headers.get("x-request-id")).toBeDefined();

    const missing = await app.handle(new Request("http://localhost/p/nope"));
    expect(missing.status).toBe(404);
  });

  it("injects the service db into the handler", async () => {
    const svc = defineService("ep_svc", { database: defineDatabase() });
    const app = brick({ services: [svc] });

    // Note: like raw app.get, endpoints must be registered before the first
    // request (Elysia compiles routes ahead-of-time).
    app.endpoint({
      handler: ({ db }) => ({ hasDb: Boolean(db) }),
      method: "GET",
      path: "/db-check",
    });
    app.endpoint({
      handler: ({ db }) => ({ hasDb: Boolean(db) }),
      method: "GET",
      path: "/db-named",
      service: "ep_svc",
    });
    app.endpoint({
      handler: ({ db }) => ({ hasDb: Boolean(db) }),
      method: "GET",
      path: "/db-missing",
      service: "nope",
    });

    const byDefault = await app.handle(
      new Request("http://localhost/db-check"),
    );
    expect(await byDefault.json()).toEqual({ hasDb: true });

    const byName = await app.handle(new Request("http://localhost/db-named"));
    expect(await byName.json()).toEqual({ hasDb: true });

    const missing = await app.handle(
      new Request("http://localhost/db-missing"),
    );
    expect(await missing.json()).toEqual({ hasDb: false });
  });

  it("mounts startup endpoints from options and lists them", async () => {
    const app = brick({
      endpoints: [{ handler: () => "ok", method: "GET", path: "/ready" }],
      services: [],
    });
    expect(app.listEndpoints()).toHaveLength(1);
    const res = await app.handle(new Request("http://localhost/ready"));
    expect(await res.text()).toBe("ok");
  });

  it("dedupes double registration through the shared mountRoute", async () => {
    const app = brick({ services: [] });
    const def = {
      handler: () => "once",
      method: "GET" as const,
      path: "/once",
    };
    app.endpoint(def);
    app.endpoint(def);
    expect(app.listEndpoints()).toHaveLength(2);
    const res = await app.handle(new Request("http://localhost/once"));
    expect(await res.text()).toBe("once");
  });

  it("maps handler errors to mesh-consistent JSON", async () => {
    const app = brick({ services: [] });
    app.endpoint({
      handler: () => {
        throw new ActionExecutionError("GONE", "nope", 410);
      },
      method: "GET",
      path: "/fail-known",
    });
    app.endpoint({
      handler: () => {
        throw new Error("kaput");
      },
      method: "GET",
      path: "/fail-unknown",
    });

    const known = await app.handle(new Request("http://localhost/fail-known"));
    expect(known.status).toBe(410);
    const unknown = await app.handle(
      new Request("http://localhost/fail-unknown"),
    );
    expect(unknown.status).toBe(500);
    expect(await unknown.json()).toMatchObject({
      name: "InternalServerError",
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal Server Error",
      status: 500,
      requestId: expect.any(String),
    });
  });

  it("lists raw endpoints in the OpenAPI spec with {param} paths", async () => {
    const app = brick({
      endpoints: [
        {
          description: "Raw HTML page viewer",
          handler: () => "html",
          method: "GET",
          path: "/p/:slug",
          summary: "Public page viewer",
        },
      ],
      services: [],
    });
    const res = await app.handle(new Request("http://localhost/openapi.json"));
    const spec = await res.json();
    const op = spec.paths["/p/{slug}"]?.get;
    expect(op?.summary).toBe("Public page viewer");
    expect(op?.parameters).toEqual([
      { in: "path", name: "slug", required: true, schema: { type: "string" } },
    ]);
  });
});
