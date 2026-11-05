import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { BASE_PATH } from "./base-path";
import { nodeRequireBanner } from "./vite-plugin-node-require";

export default defineConfig(({ command, isSsrBuild }) => ({
  // The dashboard serves the page, and so its files, at BASE_PATH. Every URL the
  // build writes, in the page and in the scripts (preloads, the zstd wasm), then
  // points there and not at the dashboard's own /assets/.
  base: `${BASE_PATH}/`,
  build: {
    // A developer's tool for current browsers: no lowering of modern syntax.
    target: "es2022",
    // The SSR entry is `server/app.ts`, built to `build/server/index.js`, which
    // the CLI imports.
    rollupOptions: isSsrBuild ? { input: "./server/app.ts" } : undefined,
    // Unminified, as upstream ships it: readable code, and no "obfuscated code"
    // flags from supply-chain scanners.
    minify: false,
  },
  // Bundle every dependency into the server build, so the package runs without
  // the UI's dependencies installed. Only Node.js built-ins stay external.
  ssr: {
    noExternal: command === "build" ? true : undefined,
  },
  plugins: [tailwindcss(), reactRouter(), nodeRequireBanner()],
  resolve: {
    // One copy of React, or hooks fail with "Invalid hook call".
    dedupe: ["react", "react-dom"],
    alias: [{ find: "~", replacement: "/app" }],
  },
}));
