import { and, brick, definePlugin, eq } from "@brickkit/core";

import { getAuth } from "./auth";
import { authorizeMcp, authRoutes, resolveUser } from "./auth/brick";
import { portSecret } from "./secrets";
// Registers the MCP tools on pagesService, so `mcp` serves them.
import "./services/pages/mcp";
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

// CORS headers mirror the Go middleware in server/main.go. Middleware runs
// before routing, so they also reach what `auth.handler` answers.
const cors = definePlugin({
  name: "@pages/cors",
  app: ({ middleware }) =>
    middleware(({ request, set }) => {
      Object.assign(set.headers, {
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers":
          "Content-Type, Authorization, MCP-Protocol-Version",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Origin": request.headers.get("origin") ?? "*",
      });
      // Preflight short-circuit (Go: 204 No Content).
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204 });
    }),
});

// buildApp wires the Brick-TS pages service mesh plus the raw HTML route
// GET /p/:slug (public page viewer); request logging comes from the SDK (brick
// options below). Better Auth's OpenAPI document joins the API reference in the
// `brick dev` dashboard (its APIs tab) through `reference.documents`.
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
    plugins: [cors()],
    // Better Auth: its routes (/api/auth/*, OAuth discovery) and the signed-in
    // user (session cookie, or an MCP access token) as ctx.user.
    auth: { resolve: resolveUser, handler: authRoutes },
    // Every pagesService tool at /mcp, for MCP access tokens only.
    mcp: { authorize: authorizeMcp },
  });

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

  return app;
}

export default buildApp();
