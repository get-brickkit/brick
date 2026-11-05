import { setupRedis as setupWorld } from "@brickkit/redis-world/internal";
import { configFromEnv } from "./config.js";
import { bullKeys } from "./queue.js";

function setupRedis() {
  const { queueName, pattern } = bullKeys(configFromEnv().jobPrefix);
  return setupWorld(() => ({
    binName: "brickkit-bullmq-world-setup",
    description: `BullMQ queue: bull:${queueName}`,
    keyPattern: pattern,
  }));
}

export { setupRedis };
