import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { E2E_DIR, PACKAGE_NAME, WF_BIN, WORLD_ROOTS } from "./harness/paths.js";
import { RedisServer } from "./harness/redis-server.js";

function newestMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(
      newest,
      entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs,
    );
  }
  return newest;
}

/** Fingerprint of the built worlds, so a rebuild during the run is noticed. */
function distFingerprint(): string {
  const hash = createHash("sha256");
  for (const root of WORLD_ROOTS) {
    const dist = join(root, "dist");
    for (const name of readdirSync(dist)
      .filter((f) => f.endsWith(".js"))
      .sort()) {
      hash.update(name).update(readFileSync(join(dist, name)));
    }
  }
  return hash.digest("hex");
}

let fingerprintAtStart = "";
let scratch: RedisServer | undefined;

export async function setup(): Promise<void> {
  // 1. The workers load the world from dist/, so a stale dist tests old code.
  for (const root of WORLD_ROOTS) {
    if (
      newestMtime(join(root, "src")) >
      statSync(join(root, "dist", "index.js")).mtimeMs
    ) {
      throw new Error(
        `${root}/dist is older than its src/: run \`bun run build:worlds\` first (\`bun run test:e2e\` does).`,
      );
    }
  }
  fingerprintAtStart = distFingerprint();
  console.log(
    `[e2e] testing ${PACKAGE_NAME}, dist/ fingerprint ${fingerprintAtStart.slice(0, 12)}`,
  );

  // 2. The scratch Redis most tests share, unless E2E_REDIS_URL names one.
  if (!process.env.E2E_REDIS_URL) {
    scratch = await RedisServer.start();
    process.env.E2E_REDIS_URL = scratch.url;
  }

  // 3. The `wf build` equivalent: bundle the fixture workflows into
  //    test/e2e/.well-known/workflow/v1/{flow.mjs,manifest.json}.
  const build = spawnSync(WF_BIN, ["build"], {
    cwd: E2E_DIR,
    encoding: "utf8",
  });
  if (build.status !== 0) {
    throw new Error(
      `wf build failed (${build.status}):\n${build.stdout}\n${build.stderr}`,
    );
  }
}

export async function teardown(): Promise<void> {
  await scratch?.dispose();
  // Setup threw before fingerprinting: nothing to compare.
  if (fingerprintAtStart && distFingerprint() !== fingerprintAtStart) {
    throw new Error(
      "dist/ changed while the e2e suite was running; results are not trustworthy. Rerun.",
    );
  }
}
