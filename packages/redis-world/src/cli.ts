import { Redis } from "ioredis";
import { configFromEnv } from "./config.js";
import { loadOptionalEnvFile } from "./internal/env.js";
import { keys } from "./keys.js";

/** What the setup CLI says about, and flushes for, a world's queue. */
export interface SetupQueue {
  /** The bin users run, for the FLUSH hint. */
  binName: string;
  /** One line describing the queue's keys. */
  description: string;
  /** Queue keys outside `keyPrefix`, flushed with it. */
  keyPattern?: string;
}

async function setupRedis(
  queue: (keyPrefix: string) => SetupQueue = (keyPrefix) => ({
    binName: "brickkit-redis-world-setup",
    description: `Redis queue: ${keys(keyPrefix).queueKey}, processing lists and delayed set`,
  }),
) {
  // Load .env file if it exists.
  loadOptionalEnvFile();

  const { redis: connectionString, keyPrefix } = configFromEnv();
  const { binName, description, keyPattern } = queue(keyPrefix);

  console.log("Setting up Redis for Workflow...");
  console.log(
    `Connection: ${connectionString.replace(/^(\w+:\/\/)([^@]+)@/, "$1[redacted]@")}`,
  );
  console.log(`Key Prefix: ${keyPrefix}`);

  let redis: Redis | undefined;
  let exitCode = 0;

  try {
    redis = new Redis(connectionString);

    // Test connection
    await redis.ping();
    console.log("Successfully connected to Redis!");

    // Get Redis info
    const info = await redis.info("server");
    const version = info.match(/redis_version:([^\r\n]+)/)?.[1];
    if (version) {
      console.log(`Redis version: ${version}`);
    }

    // Check if any workflow keys exist
    const existingKeys = await redis.keys(`${keyPrefix}*`);
    if (keyPattern) existingKeys.push(...(await redis.keys(keyPattern)));
    if (existingKeys.length > 0) {
      console.log(
        `\nWarning: found ${existingKeys.length} existing workflow keys with prefix "${keyPrefix}"`,
      );
      console.log(
        "\nTo flush existing workflow data, run with FLUSH=true environment variable:",
      );
      console.log(`  FLUSH=true npx ${binName}`);

      if (process.env.FLUSH === "true") {
        console.log("\nFlushing existing workflow data...");
        const pipeline = redis.pipeline();
        for (const key of existingKeys) {
          pipeline.del(key);
        }
        await pipeline.exec();
        console.log(`Deleted ${existingKeys.length} keys`);
      }
    } else {
      console.log(`\nNo existing workflow data found (clean slate)`);
    }

    console.log("\nRedis is ready for Workflow DevKit!");
    console.log("\nThe following Redis data structures will be used:");
    console.log(
      `  - Runs, event logs, steps, hooks and streams: ${keyPrefix}*`,
    );
    console.log(`  - ${description}`);
  } catch (error) {
    exitCode = 1;
    console.error("Failed to setup Redis:", error);
  } finally {
    await redis?.quit().catch(() => {});
  }

  process.exit(exitCode);
}

export { setupRedis };
