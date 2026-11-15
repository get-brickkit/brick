import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A test-only key: deliveries must carry it (see `queueAuthKey`).
    env: {
      WORKFLOW_QUEUE_AUTH_KEY: "PFZaRa4dQzhgPdrVUNW-sHdEMFov59egd9dqo6Td2no",
    },
    globals: true,
    globalSetup: ["./test/global-setup.ts"],
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // The e2e/chaos suite is slow and spawns processes: `bun run test:e2e` runs it.
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "test/**/*.test.ts"],
    },
  },
});
