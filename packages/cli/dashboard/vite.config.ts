import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { ASSETS, ROUTES } from "../src/dashboard-protocol";

const here = fileURLToPath(new URL(".", import.meta.url));

// Builds the dashboard into ../dashboard-dist with stable file names, which the
// CLI serves at /assets/. Fonts and other assets keep their own names. The API
// reference is a separate chunk (with its own styles) loaded on first use; the
// CLI serves plain file names only, so chunks are not put in a folder.
export default defineConfig({
  root: here,
  // The CLI serves the build under /assets/, so asset URLs in CSS must too.
  base: `${ROUTES.assets.path}/`,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": here.replace(/\/$/, ""),
      // Fumadocs OpenAPI defaults to this module, which bundles every Shiki
      // language and theme; the dashboard's own is a handful of them.
      "fumadocs-core/highlight/shiki/full": `${here}lib/shiki.ts`,
    },
  },
  build: {
    outDir: fileURLToPath(new URL("../dashboard-dist", import.meta.url)),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        // `ASSETS.app`
        app: fileURLToPath(new URL("./main.tsx", import.meta.url)),
        // `@brickkit/cli/dashboard` for extensions; it shares chunks with the
        // app, so both use one copy of each component and context.
        kit: fileURLToPath(new URL("./kit.ts", import.meta.url)),
      },
      // Keep kit.js's exports: extensions import them.
      preserveEntrySignatures: "exports-only",
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name]-[hash].js",
        assetFileNames: (asset) =>
          asset.names.includes("main.css") ? ASSETS.appCss : "[name][extname]",
      },
    },
  },
});
