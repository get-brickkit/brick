import corePackage from "../../../packages/core/package.json";
import { repoUrl } from "./shared";

export const site = {
  name: "Brick",
  url: "https://www.brickkit.dev",
  title: "Brick TypeScript backend framework for Bun",
  description:
    "High-Throughput, Logical-Monolith / Physical-Microservices TypeScript Platform powered by Bun, Elysia, TypeBox, and Drizzle ORM.",
  repo: repoUrl,
  version: corePackage.version,
};
