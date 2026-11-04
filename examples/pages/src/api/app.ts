import { and, brick, eq, traceRoute } from "@brickkit/core";

import { getAuth } from "./auth";
import { registerMcpRoutes } from "./mcp";
import { baseUrlSecret, portSecret } from "./secrets";
import { benchGo, benchRust, benchService } from "./services/bench/service";
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
// CORS allows only the public origin (BASE_URL), with credentials for the
// session cookie.
//
// Side-effect free: constructs (but never starts) the app, so embedders
// (TanStack Start server entry) can import this module safely.
export function buildApp() {
  const port = portSecret.require();
  const app = brick({
    services: [pagesService, benchService],
    // Go and Rust services: Bun proxies /api/bench-go/* and /api/bench-rust/*.
    remote: [benchGo, benchRust],
    cors: {
      origin: new URL(baseUrlSecret.value() as string).origin,
      credentials: true,
    },
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
