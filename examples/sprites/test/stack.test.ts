import { describe, expect, it } from "bun:test";
import {
  createBrickClient,
  getGlobalRegistry,
  useService,
} from "@brickkit/core";
import { app } from "../src/app";
import { decodePng } from "../src/png";
import { sprites, stack } from "../src/sprites";

function pngOf(base64: string) {
  return decodePng(Buffer.from(base64, "base64"));
}

async function post(path: string, body?: unknown, method = "POST") {
  return app.handle(
    new Request(`http://sprites.test${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

describe("stack action", () => {
  it("returns a decodable slice strip and a 16-frame sheet", async () => {
    const result = await stack.run({ sample: "car" });
    const strip = pngOf(result.stripPng);
    const sheet = pngOf(result.sheetPng);
    expect(strip.width).toBe(result.slices * result.sliceWidth);
    expect(strip.height).toBe(result.sliceHeight);
    expect(
      strip.data.some((value, index) => index % 4 === 3 && value > 0),
    ).toBe(true);
    expect(result.directions).toBe(16);
    expect(sheet.width).toBe(16 * result.frameWidth);
    expect(sheet.height).toBe(result.frameHeight);
  });

  it("runs in process through useService", async () => {
    if (!getGlobalRegistry().get("sprites"))
      getGlobalRegistry().register(sprites);
    const api = useService(sprites);
    const result = await api.stack({ sample: "tree", slices: 18 });
    expect(result.slices).toBe(18);
    expect(pngOf(result.stripPng).height).toBe(result.sliceHeight);
  });

  it("serves the same action over HTTP and the typed client", async () => {
    const http = await post("/api/sprites/stack", {
      sample: "tree",
      slices: 16,
    });
    expect(http.status).toBe(200);
    const body = await http.json();
    expect(pngOf(body.stripPng).width).toBe(16 * body.sliceWidth);

    const client = createBrickClient<{ sprites: { stack: typeof stack } }>({
      baseUrl: "http://sprites.test",
      fetch: (input, init) => app.handle(new Request(input, init)),
    });
    const typed = await client.sprites.stack({ sample: "car", slices: 12 });
    expect(typed.slices).toBe(12);
    expect(pngOf(typed.sheetPng).width).toBe(16 * typed.frameWidth);
  });

  it("is an MCP tool that returns the slice strip", async () => {
    const listed = await post("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const tools = (await listed.json()).result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toContain("stack");

    const called = await post("/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "stack", arguments: { sample: "car", slices: 10 } },
    });
    const payload = await called.json();
    expect(payload.result.isError).toBeUndefined();
    const result = payload.result.structuredContent;
    const strip = pngOf(result.stripPng);
    expect(strip.width).toBe(result.slices * result.sliceWidth);
    expect(strip.height).toBe(result.sliceHeight);
    expect(JSON.parse(payload.result.content[0].text).slices).toBe(10);
  });

  it("rejects a call with no sheet and serves the page and samples", async () => {
    const missing = await post("/api/sprites/stack", {});
    expect(missing.status).toBe(400);
    const page = await post("/", undefined, "GET");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Sprite stack");
    const sample = await post("/samples/car.png", undefined, "GET");
    expect(sample.headers.get("content-type")).toContain("image/png");
    const image = decodePng(new Uint8Array(await sample.arrayBuffer()));
    expect(image.width).toBeGreaterThan(20);
    expect(image.height).toBeGreaterThan(8);
  });
});
