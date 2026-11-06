import { setupRedis as setupWorld } from "@brickkit/redis-world/internal";
import { configFromEnv } from "./config.js";
import { bullKeys } from "./queue.js";

function setupRedis() {
  // Inside the callback: it runs after the .env file loads.
  return setupWorld(() => {
    const { queueName, pattern } = bullKeys(configFromEnv().jobPrefix);
    return {
      binName: "brickkit-bullmq-world-setup",
      description: `BullMQ queue: bull:${queueName}`,
      keyPattern: pattern,
    };
  });
}

export { setupRedis };
