import { defineConfig } from "tsdown";

// Publish bundle: ESM for Node 18+ and bundler consumers (Vite/Nitro).
// Dependencies and node builtins stay external; only workspace source is
// bundled. Entries mirror the package.json "exports" map.
export default defineConfig({
  dts: true,
  // TS 7 emits declarations for the whole tsconfig project; scope it to src.
  tsconfig: "tsconfig.build.json",
  fixedExtension: false,
  hash: false,
  entry: [
    "src/index.ts",
    "src/client.ts",
    "src/tanstack-query.ts",
    "src/pg.ts",
  ],
  format: ["esm"],
  outDir: "dist",
  // Keep shared declaration chunks from colliding with public entry files.
  outputOptions: { chunkFileNames: "chunks/[name].js" },
  platform: "node",
  sourcemap: true,
});
