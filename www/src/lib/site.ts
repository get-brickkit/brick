import corePackage from "../../../packages/core/package.json";
import { repoUrl } from "./shared";

export const site = {
  name: "Brick",
  url: "https://www.brickkit.dev",
  title: "Brick: TypeScript backend framework for Bun",
  description:
    "Open-source TypeScript backend framework for Bun. Turn Drizzle tables into CRUD APIs, and get OpenAPI, a typed client and MCP tools from the same code.",
  repo: repoUrl,
  version: corePackage.version,
};
