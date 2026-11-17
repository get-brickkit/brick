import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
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
type VercelRoute = {
  src: string;
  status?: number;
  headers?: Record<string, string>;
  continue?: boolean;
  has?: { type: string; key: string; value: string }[];
  dest?: string;
};
const docsRoutes: VercelRoute[] = [
  // One URL per page: no trailing slash, and moved pages go to their new home.
  { src: "^/(.+)/$", status: 308, headers: { Location: "/$1" } },
  ...Object.entries(redirects).map(([from, to]) => ({
    src: `^${from}(\\.md)?$`,
    status: 308,
    headers: { Location: `${to}$1` },
  })),
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
        // The markdown pages stay with the server, which sets their headers.
        // Crawled #anchor links are the same file as their page; rendering them
        // again wrote that file concurrently and left /docs/api-reference/core cut off.
        filter: (page) =>
          !page.path.endsWith(".md") && !page.path.includes("#"),
      },
    }),
    react(),
    nitro({
      preset: "vercel",
      // @ts-expect-error nitro runtime trace configuration
      externals: {
        inline: ["tslib"],
      },
      vercel: { config: { version: 3, routes: docsRoutes } },
    }),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
