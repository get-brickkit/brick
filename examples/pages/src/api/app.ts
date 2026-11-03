import { and, brick, eq, traceRoute } from "@brickkit/core";

import { getAuth } from "./auth";
import { registerMcpRoutes } from "./mcp";
import { portSecret } from "./secrets";
import {
  pagesService,
  pagesTable,
  renderPageDocument,
} from "./services/pages/service";

export interface PagesEnv {
  port: number;
  baseUrl: string;
}

const NOT_FOUND_HTML =
  '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h1>404</h1><p>Page not found</p></body></html>';

// buildApp wires the Brick-TS pages service mesh plus the raw HTML route
// GET /p/:slug (public page viewer); request logging comes from the SDK (brick
// options below). Better Auth's OpenAPI document joins the API reference in the
// `brick dev` dashboard (its APIs tab) through `reference.documents`.
// CORS headers mirror the Go middleware in server/main.go (owned by A1).
//
// Side-effect free: constructs (but never starts) the app, so embedders
// (TanStack Start server entry) can import this module safely.
export function buildApp() {
  const port = portSecret.require();
  const app = brick({
    services: [pagesService],
    description:
      "Publishing workspace engine: pages, themes, and public reading surface",
    port: port,
    reference: {
      documents: [
        {
          title: "Auth",
          document: () => getAuth().api.generateOpenAPISchema(),
        },
      ],
    },
    // Developer docs for the `brick dev` dashboard (its Docs tab). Paths start
    // at this file: ../../docs is the docs/ folder of this example.
    documentation: {
      dir: "../../docs",
      components: "../../docs/components.tsx",
    },
    requestLogging: true,
    telemetry: true,
    title: "Pages API",
    version: "1.0.0",
  });

  const corsHeaders = (origin: string | null): Record<string, string> => ({
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, MCP-Protocol-Version",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Origin": origin ?? "*",
  });

  // Preflight short-circuit (Go: 204 No Content).
  app.onBeforeHandle(({ request }: any) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(request.headers.get("origin")),
        status: 204,
      });
    }
  });

  // CORS response headers (owned by A1). Request logging (Go: method path →
  // status (latency)) is handled by the SDK requestLogging plugin above.
  app.onAfterHandle(({ request, set }: any) => {
    const headers = corsHeaders(request.headers.get("origin"));
    for (const [key, value] of Object.entries(headers)) {
      (set.headers as Record<string, string>)[key] = value;
    }
  });

  app.onError(({ request, set }: any) => {
    const headers = corsHeaders(request?.headers?.get?.("origin") ?? null);
    for (const [key, value] of Object.entries(headers)) {
      (set.headers as Record<string, string>)[key] = value;
    }
    return undefined;
  });

  // better-auth handler (email/password, session, OAuth/MCP plugins).
  // Mounted before the raw routes so /api/auth/* never hits the action mesh.
  app.all(
    "/api/auth/*",
    traceRoute("/api/auth/*", ({ request }) => getAuth().handler(request)),
  );

  // Public page viewer: raw HTML endpoint (not part of the JSON action mesh).
  // Port of the Go GET /p/:slug handler with its cache headers.
  app.endpoint({
    description:
      "Raw HTML rendering of a published page (outside the JSON action mesh).",
    handler: async ({ params, set, db }) => {
      set.headers["content-type"] = "text/html; charset=utf-8";
      const rows = db
        ? await db
            .select()
            .from(pagesTable)
            .where(
              and(
                eq(pagesTable.slug, params.slug),
                eq(pagesTable.isPublic, true),
              ),
            )
        : [];
      const page = rows[0];
      if (!page) {
        set.status = 404;
        set.headers["cache-control"] = "public, max-age=30, s-maxage=30";
        return NOT_FOUND_HTML;
      }
      set.status = 200;
      set.headers["cache-control"] =
        "public, max-age=60, s-maxage=300, stale-while-revalidate=600";
      return renderPageDocument(page);
    },
    method: "GET",
    path: "/p/:slug",
    service: pagesService,
    summary: "Public page viewer",
  });

  // MCP bearer transport (Go `mcp.NewHandler` parity) + OAuth discovery.
  registerMcpRoutes(app);

  return app;
}

export default buildApp();
