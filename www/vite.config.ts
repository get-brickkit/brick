import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { docsPagePaths } from "./scripts/docs-pages.ts";
import { redirects } from "./src/lib/redirects.ts";

// Every docs page is prerendered.
const docsPages = docsPagePaths(
  fileURLToPath(new URL("./content/docs", import.meta.url)),
);

// Vercel routes run before its static files. Static HTML and negotiated markdown
// share a URL, so caches must key on Accept, and a request for markdown goes to
// the server function.
const docsPath = "^/(?:docs(?:/.*)?)?$";

// Prerender writes `path.html`. Vercel serves that file at `/path.html` unless
// an override names the clean path. `index.html` is already the homepage.
function htmlCleanUrlOverrides(staticDir: string) {
  const overrides: Record<string, { path: string }> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".html")) {
        const file = relative(staticDir, full).replaceAll("\\", "/");
        if (file === "index.html") continue;
        overrides[file] = { path: file.slice(0, -".html".length) };
      }
    }
  };
  walk(staticDir);
  return overrides;
}
type VercelRoute = {
  src: string;
  status?: number;
  headers?: Record<string, string>;
  continue?: boolean;
  has?: { type: string; key: string; value: string }[];
  dest?: string;
};
const docsRoutes: VercelRoute[] = [
  // Legacy URLs first, including a trailing slash, so they land in one hop.
  // The generic slash rule then covers every other path except `/`.
  ...Object.entries(redirects).flatMap(([from, to]) => [
    {
      src: `^${from}/?$`,
      status: 308,
      headers: { Location: to },
    },
    {
      src: `^${from}\\.md/?$`,
      status: 308,
      headers: { Location: `${to}.md` },
    },
  ]),
  { src: "^/(.+)/$", status: 308, headers: { Location: "/$1" } },
  { src: docsPath, headers: { Vary: "Accept" }, continue: true },
  {
    src: docsPath,
    has: [{ type: "header", key: "accept", value: ".*text/markdown.*" }],
    dest: "/__server",
  },
];

export default defineConfig({
  server: {
    port: 3000,
  },
  plugins: [
    {
      name: "docs-markdown-routes",
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          // Nitro otherwise treats .md routes as static assets in development.
          if (request.url?.split(/[?#]/, 1)[0].match(/^\/docs\/.*\.md$/)) {
            request.headers.accept = `${request.headers.accept ?? "*/*"}, text/html;q=0`;
          }
          next();
        });
      },
    },
    mdx(),
    tailwindcss(),
    tanstackStart({
      pages: docsPages.map((path) => ({ path })),
      prerender: {
        enabled: true,
        failOnError: true,
        // `.html` files, not `path/index.html`. A directory index is also the
        // response for the trailing-slash URL, so both forms would be 200.
        autoSubfolderIndex: false,
        // Markdown stays on the server. Hash and query variants write the same
        // file as the page; concurrent writes truncate it (core came out empty).
        filter: (page) => {
          if (page.path.includes("#") || page.path.includes("?")) return false;
          const path = page.path.split(/[?#]/)[0] ?? "";
          if (path.endsWith(".md")) return false;
          if (path.length > 1 && path.endsWith("/")) return false;
          return !Object.hasOwn(redirects, path);
        },
        onSuccess: ({ page, html }) => {
          if (html.length === 0) {
            throw new Error(
              `Prerender produced an empty document for ${page.path}`,
            );
          }
        },
      },
    }),
    react(),
    nitro({
      preset: "vercel",
      // @ts-expect-error nitro runtime trace configuration
      externals: {
        inline: ["tslib"],
      },
      handlers: [
        {
          route: "/**",
          middleware: true,
          handler: fileURLToPath(
            new URL("./server/redirects.ts", import.meta.url),
          ),
        },
      ],
      hooks: {
        "build:before"(nitro) {
          // Static files are inserted ahead of other middleware. Redirects have
          // to run first, or a prerendered page answers its slash URL with 200.
          const middleware = nitro.routing.globalMiddleware;
          const index = middleware.findIndex((entry) =>
            entry.handler
              .replaceAll("\\", "/")
              .endsWith("/server/redirects.ts"),
          );
          if (index > 0) {
            const [entry] = middleware.splice(index, 1);
            if (entry) middleware.unshift(entry);
          }
        },
      },
      vercel: { config: { version: 3, routes: docsRoutes } },
    }),
    {
      name: "html-clean-url-overrides",
      // Post plugins run after TanStack's prerender hook. A normal plugin
      // would patch config.json before those HTML files are written.
      enforce: "post",
      buildApp: {
        // TanStack prerenders after Nitro writes config.json, so the clean
        // URL map has to be applied once those HTML files exist.
        order: "post",
        async handler() {
          const outputDir = fileURLToPath(
            new URL("./.vercel/output", import.meta.url),
          );
          const configPath = join(outputDir, "config.json");
          const config = JSON.parse(readFileSync(configPath, "utf8")) as {
            overrides?: Record<string, { path?: string }>;
          };
          config.overrides = {
            ...config.overrides,
            ...htmlCleanUrlOverrides(join(outputDir, "static")),
          };
          writeFileSync(configPath, JSON.stringify(config, null, 2));
        },
      },
    },
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
