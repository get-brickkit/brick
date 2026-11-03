import { defineConfig } from "tsdown";

// Publish bundle: ESM for Node 18+ and bundler consumers (Vite/Nitro).
// @brickkit/core and all node_modules stay external; only this package's
// source is bundled. Entries mirror package.json "exports" plus the bin.
export default defineConfig({
  dts: true,
  // TS 7 emits declarations for the whole tsconfig project; scope it to src.
  tsconfig: "tsconfig.build.json",
  fixedExtension: false,
  hash: false,
  entry: [
    "src/index.ts",
    "src/bin.ts",
    "src/compiler.ts",
    "src/workflows.ts",
    "src/vite.ts",
    "src/dev-worker.ts",
    "src/dev-reporter.ts",
    "src/lint/eslint.ts",
    "src/lint/oxlint.ts",
  ],
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  sourcemap: true,
});
