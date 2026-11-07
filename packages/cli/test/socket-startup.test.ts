import { expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { freePort, tempProject, waitFor } from "./helpers";

const root = resolve(import.meta.dir, "../../..");
const entry = join(import.meta.dir, "fixtures/socket-app.ts");
const bin = join(root, "packages/cli/src/bin.ts");

for (const mode of ["dev", "start", "build", "build-runtime"] as const)
  it(`serves typed sockets through brick ${mode}`, async () => {
    const port = freePort();
    const dir = await tempProject("socket-startup");
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let ws: WebSocket | undefined;
    try {
      if (mode.startsWith("build")) {
        const build = Bun.spawn(
          [
            process.execPath,
            bin,
            "build",
            entry,
            "--outdir",
            dir,
            "--port",
            String(port),
            ...(mode === "build-runtime" ? ["--no-aot"] : []),
          ],
          { cwd: root, stdout: "pipe", stderr: "pipe" },
        );
        const [code, out, err] = await Promise.all([
          build.exited,
          new Response(build.stdout).text(),
          new Response(build.stderr).text(),
        ]);
        expect({ code, err, out: out.includes("Compiled") }).toEqual({
          code: 0,
          err: "",
          out: true,
        });
      }
      const args = mode.startsWith("build")
        ? [join(dir, "server.js")]
        : [
            bin,
            mode,
            entry,
            "--port",
            String(port),
            ...(mode === "dev" ? ["--no-dashboard"] : []),
          ];
      child = Bun.spawn([process.execPath, ...args], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PORT: String(port) },
      });
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      const healthy = await waitFor(
        async () =>
          child!.exitCode !== null ||
          (await fetch(`http://localhost:${port}/_health`).then(
            (response) => response.ok,
            () => false,
          )),
        8000,
      ).then(
        () => child!.exitCode === null,
        () => false,
      );
      if (!healthy) {
        child.kill();
        await child.exited;
        throw new Error(
          `Server failed to start: ${await stdout}\n${await stderr}`,
        );
      }
      ws = new WebSocket(`ws://localhost:${port}/v2/socket_fixture/live`);
      const received = new Promise<unknown>((resolve, reject) => {
        ws!.onopen = () =>
          ws!.send(JSON.stringify({ event: "echo", data: "from client" }));
        ws!.onmessage = ({ data }) => resolve(JSON.parse(String(data)));
        ws!.onerror = reject;
      });
      expect(await received).toEqual({ event: "echoed", data: "from client" });
      ws.close();
      child.kill();
      await child.exited;
      await Promise.all([stdout, stderr]);
    } finally {
      ws?.close();
      child?.kill();
      await child?.exited;
      await rm(dir, { recursive: true, force: true });
    }
  }, 30000);
