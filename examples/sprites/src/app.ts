import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brick, createMcpHandler, createMcpRegistry } from "@brickkit/core";
import { encodePng } from "./png";
import { isSampleName, sampleSheet } from "./samples";
import { sprites } from "./sprites";

const page = readFileSync(
  join(import.meta.dir, "../public/index.html"),
  "utf8",
);

export const mcp = createMcpHandler({
  registry: createMcpRegistry({ services: [sprites] }),
  serverInfo: { name: "sprite-stack", version: "0.1.0" },
  protocolVersions: ["2025-06-18", "2025-03-26", "2024-11-05"],
});

export const app = brick({
  services: [sprites],
  title: "Sprite stack",
  description:
    "Four orthographic pixel-art views become a sprite you can spin. One action, served in process, over HTTP, and as an MCP tool.",
  requestLogging: false,
  endpoints: [
    {
      method: "GET",
      path: "/",
      summary: "Turntable",
      handler: () =>
        new Response(page, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
    {
      method: "GET",
      path: "/samples/:name",
      summary: "Bundled 4-view sheet",
      handler: ({ params, set }) => {
        const name = params.name?.replace(/\.png$/, "") ?? "";
        if (!isSampleName(name)) {
          set.status = 404;
          return { message: "Unknown sample. Try car or tree." };
        }
        const bytes = encodePng(sampleSheet(name));
        const body = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(body).set(bytes);
        return new Response(body, {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=3600",
          },
        });
      },
    },
  ],
});

app.post("/mcp", ({ request }: { request: Request }) => mcp(request));

export default app;
