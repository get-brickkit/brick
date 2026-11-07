import { createWorld } from "../src/index.js";
import { worldContract } from "./world-contract.js";

worldContract({
  packageName: "@brickkit/redis-world",
  createWorld,
  isolate: () => ({}),
});
