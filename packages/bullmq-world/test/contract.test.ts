import { worldContract } from "../../redis-world/test/world-contract.js";
import { createWorld } from "../src/index.js";

worldContract({
  packageName: "@brickkit/bullmq-world",
  createWorld,
  // BullMQ keeps its queue under its own prefix, not `keyPrefix`.
  isolate: (id) => ({ jobPrefix: `w_${id}_` }),
});
