import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { capture, freePort, settle, tempProject, waitFor } from "./helpers";

function appSource(revision: number, telemetry = true, documentation = "") {
  return `// revision ${revision}
import { brick, defineService, t } from "@brickkit/core";

const demo = defineService("demo");
demo.action({
  name: "echo",
  input: t.Object({ text: t.String() }),
  execute: ({ input }) => ({ text: input.text }),
});
demo.action({
  name: "fail",
  execute: () => {
    throw new Error("boom");
  },
});

export default brick({ services: [demo]${telemetry ? ", telemetry: true" : ""}${documentation ? `, documentation: ${JSON.stringify(documentation)}` : ""} });
`;
}

const json = { "content-type": "application/json" };

test("brick dev shows requests, failures, history across restarts, and startup crashes", async () => {
  const directory = await tempProject("dev-telemetry");
  // The app is in src/ and its docs beside src/: "../docs", as it reads in main.ts.
  const entry = join(directory, "src", "main.ts");
  await mkdir(join(directory, "src"), { recursive: true });
  await writeFile(entry, appSource(1, true, "../docs"));
  await mkdir(join(directory, "docs"), { recursive: true });
  await writeFile(
    join(directory, "docs/index.mdx"),
    "---\ntitle: Demo docs\n---\n\nHello from the docs folder.\n",
  );
  const apiPort = await freePort();
  const dashboardPort = await freePort();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/bin.ts"),
      "dev",
      entry,
      "--port",
      String(apiPort),
      "--dashboard-port",
      String(dashboardPort),
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const logs = capture(child);
  const api = `http://127.0.0.1:${apiPort}`;
  const state = async () =>
    (await fetch(`http://127.0.0.1:${dashboardPort}/api/state`)).json();

  try {
    await waitFor(() =>
      fetch(`${api}/_health`)
        .then((r) => r.ok)
        .catch(() => false),
    );
    await fetch(`${api}/api/demo/echo`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "hi" }),
    });
    await fetch(`${api}/api/demo/fail`, {
      method: "POST",
      headers: json,
      body: "{}",
    });
    await waitFor(async () => (await state()).failures.length >= 1);

    // The dashboard is given the app's OpenAPI document and where it listens.
    await waitFor(async () => Boolean((await state()).api));
    expect((await state()).api).toMatchObject({
      appUrl: `http://localhost:${apiPort}`,
      titles: ["Brick-TS API Mesh"],
    });
    const documents = await (
      await fetch(`http://127.0.0.1:${dashboardPort}/api/openapi`)
    ).json();
    expect(Object.keys(documents[0].document.paths)).toContain(
      "/api/demo/echo",
    );

    // The app's documentation folder reaches the dashboard through the worker.
    await waitFor(async () => (await state()).docs?.status === "ready");
    const docsPage = await (
      await fetch(`http://127.0.0.1:${dashboardPort}/api/docs/page`)
    ).json();
    expect(docsPage.title).toBe("Demo docs");
    expect(docsPage.code).toContain("Hello from the docs folder");

    let snapshot = await state();
    const failed = snapshot.traces.find(
      (trace: { route?: string }) => trace.route === "/api/demo/fail",
    );
    expect(failed.status).toBe("error");
    expect(failed.httpStatus).toBe(500);
    expect(
      failed.spans.some(
        (span: { attributes: Record<string, unknown> }) =>
          span.attributes["brick.error.code"] === "INTERNAL_SERVER_ERROR",
      ),
    ).toBe(true);
    expect(snapshot.failures[0]).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "boom",
      action: "fail",
      route: "/api/demo/fail",
    });
    expect(snapshot.reloads[0]).toMatchObject({
      kind: "started",
      generation: 1,
    });

    // Live stream: the browser sees a request as soon as it completes.
    const stream = await fetch(`http://127.0.0.1:${dashboardPort}/api/events`);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const readUntil = async (marker: string) => {
      while (!buffer.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`Stream ended before ${marker}`);
        buffer += decoder.decode(value);
      }
    };
    await readUntil("event: snapshot");
    await fetch(`${api}/api/demo/echo`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "live" }),
    });
    await readUntil('"route":"/api/demo/echo"');
    await reader.cancel();

    // Edits restart the app; earlier requests and failures stay on screen.
    await writeFile(entry, appSource(2));
    await waitFor(async () =>
      (await state()).reloads.some(
        (reload: { kind: string; generation: number }) =>
          reload.kind === "started" && reload.generation === 2,
      ),
    );
    snapshot = await state();
    expect(
      snapshot.traces.some(
        (trace: { route?: string }) => trace.route === "/api/demo/fail",
      ),
    ).toBe(true);
    expect(
      snapshot.reloads.some(
        (reload: { kind: string; detail?: string }) =>
          reload.kind === "restarting" && reload.detail === "source changed",
      ),
    ).toBe(true);

    // A broken entry reports why startup failed, not just an exit code.
    await writeFile(entry, `throw new Error("missing export");\n`);
    // The failure arrives from the worker; the exit is seen a moment later.
    await waitFor(async () => {
      const current = await state();
      return (
        current.failures.some(
          (failure: { phase: string }) => failure.phase === "startup",
        ) &&
        current.reloads.some(
          (reload: { kind: string }) => reload.kind === "exited",
        )
      );
    });
    snapshot = await state();
    expect(snapshot.failures[0]).toMatchObject({
      phase: "startup",
      code: "STARTUP_FAILED",
      message: "missing export",
    });
    expect(
      snapshot.reloads.some(
        (reload: { kind: string }) => reload.kind === "exited",
      ),
    ).toBe(true);
  } finally {
    child.kill();
    await child.exited;
    await logs.finished;
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

test("brick dev explains an app that does not opt in to telemetry", async () => {
  const directory = await tempProject("dev-telemetry");
  const entry = join(directory, "main.ts");
  await writeFile(entry, appSource(1, false));
  const apiPort = await freePort();
  const dashboardPort = await freePort();
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../src/bin.ts"),
      "dev",
      entry,
      "--port",
      String(apiPort),
      "--dashboard-port",
      String(dashboardPort),
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const logs = capture(child);
  const api = `http://127.0.0.1:${apiPort}`;
  try {
    await waitFor(() =>
      fetch(`${api}/_health`)
        .then((r) => r.ok)
        .catch(() => false),
    );
    await fetch(`${api}/api/demo/echo`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ text: "hi" }),
    });
    await waitFor(() => logs.read().includes("telemetry: true"));
    await settle();
    const snapshot = await (
      await fetch(`http://127.0.0.1:${dashboardPort}/api/state`)
    ).json();
    expect(snapshot.traces).toHaveLength(0);
  } finally {
    child.kill();
    await child.exited;
    await logs.finished;
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("brick dev refuses a dashboard port that equals the API port", async () => {
  const directory = await tempProject("dev-telemetry");
  const entry = join(directory, "main.ts");
  await writeFile(entry, appSource(1));
  const port = await freePort();
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "../src/bin.ts"),
        "dev",
        entry,
        "--port",
        String(port),
        "--dashboard-port",
        String(port),
      ],
      { cwd: directory, stdout: "pipe", stderr: "pipe" },
    );
    const logs = capture(child);
    expect(await child.exited).toBe(1);
    await logs.finished;
    expect(logs.read()).toContain(
      "dashboard port must differ from the API port",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
