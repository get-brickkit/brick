import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const E2E_DIR = join(here, "..");
/** redis-world, which holds this suite and the `wf` used to build its fixtures. */
const HARNESS_ROOT = join(E2E_DIR, "..", "..");
/** The world under test: `E2E_WORLD=bullmq-world` runs the suite against bullmq-world. */
export const WORLD = process.env.E2E_WORLD ?? "redis-world";
if (WORLD !== "redis-world" && WORLD !== "bullmq-world")
  throw new Error(
    `E2E_WORLD must be redis-world or bullmq-world, got ${WORLD}`,
  );
/** The package under test; workers run in it so its name resolves to itself. */
export const PKG_ROOT = join(HARNESS_ROOT, "..", WORLD);
export const PACKAGE_NAME = `@brickkit/${WORLD}`;
/** Built world packages the workers load: redis-world, and the world under test. */
export const WORLD_ROOTS = [...new Set([HARNESS_ROOT, PKG_ROOT])];
export const DIST_ENTRY = join(PKG_ROOT, "dist", "index.js");
export const SERVER_ENTRY = join(E2E_DIR, "server", "server.mts");
export const TARGET_WORLD_ENTRY = join(E2E_DIR, "server", "target-world.mjs");
export const WF_BIN = join(HARNESS_ROOT, "node_modules", ".bin", "wf");
export const REDIS_SERVER_BIN = process.env.REDIS_SERVER_BIN ?? "redis-server";
/** The scratch Redis the e2e suite uses unless a test needs its own server
 * (global-setup starts one when E2E_REDIS_URL is unset). */
export const SCRATCH_REDIS_URL = process.env.E2E_REDIS_URL!;
