import { expect, test } from "bun:test";
import { rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { capture, freePort, settle, tempProject, waitFor } from "./helpers";

async function fixture() {
  return { directory: await tempProject("dev-supervisor"), port: freePort() };
}

test("exported app prefix takes precedence with a warning", async () => {
  const { directory, port } = await fixture();
  const entry = join(directory, "main.ts");
  await writeFile(
    entry,
    'import { brick } from "@brickkit/core"; export default brick({ prefix: "/custom" });',
  );
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/dev-worker.ts"),
      JSON.stringify({ entry, port, prefix: "/override", telemetry: false }),
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const logs = capture(child);
  try {
    await waitFor(() =>
      logs.read().includes("exported BrickApp prefix /custom takes precedence"),
    );
    expect(logs.read()).toContain("Ignoring prefix /override");
  } finally {
    child.kill();
    await child.exited;
    await logs.finished;
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

test("worker exits are reported and edits recover without intentional-exit warnings", async () => {
  const { directory, port } = await fixture();
  const entry = join(directory, "main.ts");
  await writeFile(entry, "process.exit(7);");
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/bin.ts"),
      "dev",
      entry,
      "--no-dashboard",
      "--port",
      String(port),
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const logs = capture(child);
  try {
    await waitFor(() =>
      logs.read().includes("Application process exited with code 7"),
    );
    expect(child.exitCode).toBeNull();
    await writeFile(
      entry,
      'import { brick } from "@brickkit/core"; export default brick();',
    );
    await waitFor(async () => {
      try {
        return (await fetch(`http://localhost:${port}/_health`)).status === 200;
      } catch {
        return false;
      }
    });
    await writeFile(entry, "process.exit(9);");
    await waitFor(() =>
      logs.read().includes("Application process exited with code 9"),
    );
    expect(logs.read().match(/Application process exited/g)).toHaveLength(2);
  } finally {
    child.kill();
    await child.exited;
    await logs.finished;
    await rm(directory, { recursive: true, force: true });
  }
  expect(logs.read().match(/Application process exited/g)).toHaveLength(2);
}, 15000);

test("dev generates before frontend startup, watches imported files, and recovers without contract loops", async () => {
  const { directory, port } = await fixture();
  const external = await tempProject("dev-dependency");
  const entry = join(directory, "main.ts");
  const dependency = join(external, "actions.ts");
  const output = join(directory, "_brick/contract.ts");
  const actionSource = (
    result: string,
    extra = "",
  ) => `import { defineService, t } from "@brickkit/core";
const service = defineService("supervised");
service.action({ name: "value", input: t.Object({ id: t.String()${extra} }), output: t.String(), execute: () => ${JSON.stringify(result)} });
export default service;`;
  await writeFile(dependency, actionSource("first"));
  await writeFile(
    entry,
    `import { brick } from "@brickkit/core"; import service from ${JSON.stringify(dependency)}; export default brick({ services: [service], requestLogging: false });`,
  );
  await writeFile(
    join(directory, "frontend.ts"),
    `import { appendFile } from "node:fs/promises";
if (!(await Bun.file("_brick/contract.ts").text()).includes('"value"')) process.exit(4);
await appendFile("frontend-starts.txt", "started\\n");
setInterval(() => {}, 1000);`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/bin.ts"),
      "dev",
      entry,
      "--no-dashboard",
      "--port",
      String(port),
      "--client",
      "_brick/contract.ts",
      "--frontend",
      `${process.execPath} frontend.ts`,
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const logs = capture(child);
  try {
    await waitFor(() =>
      Bun.file(join(directory, "frontend-starts.txt")).exists(),
    );
    const first = await Bun.file(output).text();
    const timestamp = (await stat(output)).mtimeMs;
    await writeFile(dependency, actionSource("implementation only"));
    await waitFor(() => logs.read().includes("Changes detected"));
    await settle();
    expect(await Bun.file(output).text()).toBe(first);
    expect((await stat(output)).mtimeMs).toBe(timestamp);
    await writeFile(dependency, "export default { broken syntax");
    await waitFor(() =>
      logs.read().includes("Application process exited with code 1"),
    );
    expect(await Bun.file(output).text()).toBe(first);
    await writeFile(dependency, actionSource("fixed", ", locale: t.String()"));
    await waitFor(async () =>
      (await Bun.file(output).text()).includes('"locale": string'),
    );
    const restarts = logs.read().match(/Changes detected/g)?.length;
    await settle(400);
    expect(logs.read().match(/Changes detected/g)?.length).toBe(restarts);
    expect(await Bun.file(join(directory, "frontend-starts.txt")).text()).toBe(
      "started\n",
    );
  } finally {
    child.kill();
    await child.exited;
    await logs.finished;
    await rm(directory, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
}, 15000);

for (const mode of ["programmatic", "SIGTERM"] as const) {
  test(`stops frontend descendants on ${mode} shutdown`, async () => {
    const { directory, port } = await fixture();
    const entry = join(directory, "app.ts");
    const marker = join(directory, "descendant.txt");
    await writeFile(
      entry,
      'import { brick } from "@brickkit/core"; export default brick({ services: [], requestLogging: false });',
    );
    await writeFile(
      join(directory, "descendant.ts"),
      `const server = Bun.serve({ port: 0, fetch: () => new Response("frontend") }); await Bun.write("descendant.txt", process.pid + ":" + server.port);`,
    );
    await writeFile(
      join(directory, "frontend.ts"),
      `import { spawn } from "node:child_process"; spawn(process.execPath, ["descendant.ts"], { stdio: "inherit" }); setInterval(() => {}, 1000);`,
    );
    await writeFile(
      join(directory, "supervisor.ts"),
      `import { startDevServer } from ${JSON.stringify(resolve(import.meta.dir, "../src/runner.ts"))};
const server = await startDevServer({ entry: ${JSON.stringify(entry)}, port: ${port}, clientOutput: "contract.ts", frontend: ${JSON.stringify(`cd . && ${process.execPath} frontend.ts`)} });
process.on("message", () => { server.stop(); process.exit(0); });`,
    );
    const supervisor = Bun.spawn([process.execPath, "supervisor.ts"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      ipc() {},
    });
    const logs = capture(supervisor);
    let descendantPid: number | undefined;
    try {
      await waitFor(() => Bun.file(marker).exists());
      const [pid, frontendPort] = (await Bun.file(marker).text())
        .split(":")
        .map(Number);
      descendantPid = pid;
      const url = `http://localhost:${frontendPort}`;
      expect(await (await fetch(url)).text()).toBe("frontend");
      if (mode === "programmatic") supervisor.send("stop");
      else supervisor.kill("SIGTERM");
      await supervisor.exited;
      await waitFor(async () => {
        try {
          await fetch(url);
          return false;
        } catch {
          return true;
        }
      });
      expect(supervisor.exitCode).toBe(0);
    } finally {
      supervisor.kill();
      await supervisor.exited;
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch (error) {
          expect(error).toHaveProperty("code", "ESRCH");
        }
      }
      await logs.finished;
      await rm(directory, { recursive: true, force: true });
    }
  }, 15000);
}

test("recovers when an external dependency has invalid syntax on initial startup", async () => {
  const { directory, port } = await fixture();
  const external = await tempProject("dev-dependency");
  const entry = join(directory, "app.ts");
  const dependency = join(external, "service.ts");
  const output = join(directory, "contract.ts");
  await writeFile(dependency, "export default { broken syntax");
  await writeFile(
    entry,
    `import { brick } from "@brickkit/core"; import service from ${JSON.stringify(dependency)}; export default brick({ services: [service], requestLogging: false });`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/bin.ts"),
      "dev",
      entry,
      "--no-dashboard",
      "--port",
      String(port),
      "--client",
      output,
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const logs = capture(child);
  try {
    await waitFor(() =>
      logs.read().includes("Application process exited with code 1"),
    );
    expect(await Bun.file(output).exists()).toBe(false);
    await writeFile(
      dependency,
      'import { defineService, t } from "@brickkit/core"; const service = defineService("initialRecovery"); service.action({ name: "ping", output: t.String(), execute: () => "pong" }); export default service;',
    );
    await waitFor(() => Bun.file(output).exists());
    expect(await Bun.file(output).text()).toContain('"ping"');
  } finally {
    child.kill();
    await child.exited;
    await logs.finished;
    await rm(directory, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
}, 15000);
