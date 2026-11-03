import { defineConfig } from "tsdown";

// Types for `@brickkit/cli/dashboard`, the UI kit a dashboard extension
// imports. Its code is the dashboard's own kit.js (scripts/build-dashboard.ts),
// so only the declarations are built here. Base UI's types are written in;
// React's and Brick's stay imports.
export default defineConfig({
  entry: { dashboard: "dashboard/kit.ts" },
  tsconfig: "tsconfig.dashboard.json",
  dts: { emitDtsOnly: true },
  deps: { onlyBundle: false },
  format: ["esm"],
  outDir: "dist",
  clean: false,
  platform: "browser",
});
