import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { freePort, tempProject, waitFor } from "./helpers";

async function waitForValue(url: string, value: string) {
  let last = "no response";
  await waitFor(async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      last = `${response.status} ${await response.text()}`;
    } catch {}
    return last === `200 {"v":"${value}"}`;
  }, 8000).catch(() => {
    throw new Error(`Expected ${value}; last response: ${last}`);
  });
}

test.each([
  [false, "src"],
  [true, "src"],
  [false, "dist"],
  [true, "dist"],
])(
  "brick dev reloads dependency services (default app: %s, CLI from %s; dist needs a build)",
  async (exportApp, cliDirectory) => {
    const directory = await tempProject("dev-reload");
    const port = freePort();
    const service = (
      value: string,
    ) => `import { defineService } from "@brickkit/core";
const svc = defineService("rt", {});
svc.action({ name: "hi", execute: async () => ({ v: "${value}" }) });`;
    await writeFile(join(directory, "svc.ts"), service("ONE"));
    await writeFile(
      join(directory, "main.ts"),
      exportApp
        ? 'import "./svc"; import { brick } from "@brickkit/core"; export default brick({ prefix: "/custom" });'
        : 'import "./svc";',
    );
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(
          import.meta.dir,
          `../${cliDirectory}/bin.${cliDirectory === "src" ? "ts" : "js"}`,
        ),
        "dev",
        "main.ts",
        "--no-dashboard",
        "--port",
        String(port),
      ],
      { cwd: directory, stdout: "ignore", stderr: "inherit" },
    );
    try {
      const url = `http://localhost:${port}/${exportApp ? "custom" : "api"}/rt/hi`;
      await waitForValue(url, "ONE");
      await writeFile(join(directory, "svc.ts"), service("TWO"));
      await waitForValue(url, "TWO");
      await writeFile(join(directory, "svc.ts"), service("THREE"));
      await waitForValue(url, "THREE");
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
      await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  },
  25000,
);
