import { test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { capture, freePort, tempProject, waitFor } from "./helpers";

test("brick dev restarts when an imported file outside the entry directory changes", async () => {
  const directory = await tempProject("dev-deps");
  await mkdir(join(directory, "server"));
  await mkdir(join(directory, "shared"));
  await writeFile(
    join(directory, "shared/value.ts"),
    'export const value = "one";\n',
  );
  await writeFile(
    join(directory, "server/main.ts"),
    'import { value } from "../shared/value";\nconsole.log("loaded", value);\n',
  );
  const port = await freePort();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/bin.ts"),
      "dev",
      "server/main.ts",
      "--port",
      String(port),
      "--no-dashboard",
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const logs = capture(child);
  try {
    await waitFor(() => logs.read().includes("loaded one"));
    await writeFile(
      join(directory, "shared/value.ts"),
      'export const value = "two";\n',
    );
    await waitFor(() => logs.read().includes("loaded two"));
  } finally {
    child.kill();
    await child.exited;
    await logs.finished;
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
