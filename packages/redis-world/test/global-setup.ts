import { RedisContainer } from "@testcontainers/redis";

export default async function setup() {
  if (process.env.REDIS_TEST_URL || process.platform === "win32") return;

  // Set the URL before workers import tests that open Redis clients at module scope.
  const container = await new RedisContainer("redis:7-alpine").start();
  process.env.REDIS_TEST_URL = container.getConnectionUrl();

  return async () => {
    delete process.env.REDIS_TEST_URL;
    await container.stop();
  };
}
