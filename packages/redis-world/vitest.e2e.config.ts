import { defineConfig } from "vitest/config";

// End-to-end and chaos suite: real worker processes, real Redis, real
// generated workflow bundles. Slow by design (~4 min).
//
//   bun run test:e2e                      build dist/, then run everything
//   npx vitest run --config vitest.e2e.config.ts chaos -t 11b   (needs a fresh `bun run build:worlds`)
//
// The same suite runs against bullmq-world from that package (`E2E_WORLD=bullmq-world`).
// Workers load the world from dist/ (global-setup refuses a dist older than
// src/ and flags a rebuild mid-run). Fixture workflows in test/e2e/workflows are
// bundled by `wf build` in global-setup. Needs a redis-server binary. Knobs (env):
//   E2E_WORLD=bullmq-world                 the world under test (default redis-world)
//   E2E_REDIS_URL=redis://localhost:6395   shared Redis (unique prefixes per test);
//                                          unset, global-setup starts one
//   E2E_DUMP=1                             print worker logs + event logs even when a test passes
//   E2E_TRACE_WORLD=1                      workers log every events.create/list call (tuned workers only)
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/e2e/**/*.e2e.test.ts"],
    globalSetup: ["test/e2e/global-setup.ts"],
    // Generous: nothing here is fast. Individual tests pass their own larger timeouts.
    testTimeout: 240_000,
    hookTimeout: 120_000,
    // Files share one scratch Redis and one machine; running them one at a time
    // keeps timing-sensitive scenarios (sleeps, lock expiry) honest.
    fileParallelism: false,
    reporters: ["verbose"],
    // The test-side world's ioredis clients log every refused reconnect while a
    // test has Redis stopped on purpose (scenario 13); that is expected noise,
    // not evidence. Everything else is left alone.
    onConsoleLog(log) {
      if (
        log.includes("[ioredis] Unhandled error event") ||
        log.startsWith("Error: connect ECONNREFUSED")
      )
        return false;
      return undefined;
    },
  },
});
