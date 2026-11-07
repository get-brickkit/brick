export { startDevServer, startWorker, type DevServerOptions } from "./runner";
export { buildApplication, type BuildApplicationOptions } from "./build";
export type {
  DashboardExtensionOptions,
  DashboardTheme,
} from "./dashboard-extension";
export { generateClientContract } from "./client-contract";
import { defineConfig as defineProjectConfig } from "./config";
export type { BrickConfig, LintPreset, LintSeverity } from "./config";
/**
 * @deprecated Import it from `@brickkit/cli/config`, which loads less. This
 * one keeps everything index reaches loadable under Node.
 */
export const defineConfig = defineProjectConfig;
