import { setupRedis as setupWorld } from "@brickkit/redis-world/internal";

function setupRedis() {
  const jobPrefix = process.env.WORKFLOW_REDIS_JOB_PREFIX || "workflow_";
  return setupWorld(() => ({
    binName: "brickkit-bullmq-world-setup",
    description: `BullMQ queue: bull:${jobPrefix}flows`,
    keyPattern: `bull:${jobPrefix}*`,
  }));
}

// Check if running as main module
if (import.meta.url === `file://${process.argv[1]}`) {
  setupRedis();
}

export { setupRedis };
