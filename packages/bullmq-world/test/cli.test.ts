import { expect, test, vi } from "vitest";

// The real setup loads the .env file, then asks for the queue; mimic that order.
vi.mock("@brickkit/redis-world/internal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@brickkit/redis-world/internal")>()),
  setupRedis: (queue: (keyPrefix: string) => unknown) => {
    process.env.WORKFLOW_REDIS_JOB_PREFIX = "fromenv_";
    return queue("prefix:");
  },
}));

const { setupRedis } = await import("../src/cli.js");

test("the queue pattern follows a job prefix that only the .env file sets", () => {
  expect(setupRedis()).toMatchObject({
    keyPattern: expect.stringContaining("fromenv_"),
  });
});
