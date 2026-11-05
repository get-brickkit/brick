export { startDevServer, startWorker, type DevServerOptions } from "./runner";
export { buildApplication, type BuildApplicationOptions } from "./build";
export type {
  DashboardExtensionOptions,
  DashboardTheme,
} from "./dashboard-extension";
export { generateClientContract } from "./client-contract";
// Kept for configs that import it from here; `@brickkit/cli/config` loads less.
export {
  defineConfig,
  type BrickConfig,
  type LintPreset,
  type LintSeverity,
} from "./config";
