import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { brick, defineService, resetGlobalRegistry } from "@brickkit/core";
import { startDevServer } from "../src/runner";
import { printBanner } from "../src/serve";
import { existsSync } from "fs";
import path from "path";

describe("startDevServer", () => {
  beforeEach(() => {
    resetGlobalRegistry();
  });

  it("should start server without entry when no entry is provided", async () => {
    const app = await startDevServer({ port: 45111 });
    expect(app).toBeDefined();
    await (app as { shutdown(): Promise<void> }).shutdown();
  });

  it("should fail when entry is provided but not found", async () => {
    await expect(
      startDevServer({ entry: "does-not-exist.ts", port: 45112 }),
    ).rejects.toThrow(/Entry file not found: .*does-not-exist\.ts/);
  });

  it("should load valid entry file successfully", async () => {
    const filename = `.test-entry-${Date.now()}.ts`;
    const entryPath = path.join(process.cwd(), filename);
    await Bun.write(entryPath, "console.log('Entry loaded');");
    try {
      const app = await startDevServer({ entry: filename, port: 45113 });
      expect(app).toBeDefined();
      (app as { stop(): void }).stop();
    } finally {
      if (existsSync(entryPath)) await Bun.file(entryPath).delete();
    }
  });

  it("refuses a dashboard on the app's port, when PORT sets it too", async () => {
    const filename = `.test-entry-port-${Date.now()}.ts`;
    await Bun.write(filename, "export {};");
    const previous = process.env.PORT;
    process.env.PORT = "9400";
    try {
      await expect(
        startDevServer({ entry: filename, dashboard: {} }),
      ).rejects.toThrow("dashboard port must differ from the API port");
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
      await Bun.file(filename).delete();
    }
  });
});

it("the banner lists the routes the server mounts, not shadowed ones", () => {
  resetGlobalRegistry();
  const service = defineService("banner");
  for (const name of ["first", "shadowed"])
    service.action({ name, method: "GET", path: "/same", execute: () => name });
  const app = brick({ services: [service], requestLogging: false });
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line) => {
    lines.push(String(line));
  });
  try {
    printBanner(app, { label: "Test", port: 4000 });
  } finally {
    log.mockRestore();
  }
  expect(lines.filter((line) => line.includes("/same"))).toEqual([
    "     -> GET    /api/banner/same",
  ]);
});
