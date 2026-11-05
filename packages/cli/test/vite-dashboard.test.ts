import { afterAll, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { context, propagation, trace } from "@opentelemetry/api";
import { createServer } from "vite";
import { brickClient } from "../src/vite";
import { startViteDashboard } from "../src/dev-vite-dashboard";
import { freePort, tempProject, waitFor } from "./helpers";

afterAll(() => {
  // The tracer provider is process-wide; release it for other test files.
  trace.disable();
  context.disable();
  propagation.disable();
});

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
) {
  let value!: T;
  // On timeout, return the last value so the assertion shows it.
  await waitFor(async () => done((value = await read())), 5000).catch(() => {});
  return value;
}

async function writeApp(root: string, extraOptions = "", folder = "") {
  const cli = "@brickkit/core";
  await Bun.write(
    join(root, folder, "actions.ts"),
    `import { defineService, t } from "@brickkit/core";
const service = defineService("dash");
service.action({
  name: "echo",
  input: t.Object({ text: t.String() }),
  output: t.String(),
  execute: ({ input }) => input.text,
});
export default service;
`,
  );
  await Bun.write(
    join(root, folder, "app.ts"),
    `import { brick } from ${JSON.stringify(cli)};
import service from "./actions";
export default brick({ services: [service], requestLogging: false, telemetry: true${extraOptions} });
`,
  );
}

it("serves the dashboard for the app's requests during vite dev", async () => {
  const root = await tempProject("vite-dashboard");
  await writeApp(root);
  const port = await freePort();
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [brickClient({ entry: "./app.ts", dashboard: { port } })],
    server: { middlewareMode: true },
  });
  try {
    const environment = server.environments.ssr!;
    const app = (await environment.runner.import("virtual:brick-app")).default;
    const response = await app.fetch(
      new Request("http://localhost/api/dash/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
    );
    expect(await response.text()).toBe("hello");

    const state = await eventually(
      () => fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json()),
      (value) => value.traces.length > 0,
    );
    const requestTrace = state.traces.find(
      (item: { route?: string }) => item.route === "/api/dash/echo",
    );
    expect(requestTrace.status).toBe("ok");
    expect(
      requestTrace.spans.map((span: { name: string }) => span.name),
    ).toContain("action dash.echo");
    expect(state.reloads[0]).toMatchObject({
      kind: "started",
      detail: "application loaded",
    });
    expect(
      state.architecture.schema.services.map(
        (svc: { name: string }) => svc.name,
      ),
    ).toEqual(["dash"]);
    expect(state.canRestart).toBe(false);

    // The finished request is also kept on disk, in the project's .brick folder.
    expect(state.historyDays).toBe(90);
    const kept = await eventually(
      () =>
        fetch(
          `http://127.0.0.1:${port}/api/history/traces?from=0&to=${Date.now() + 1000}`,
        ).then((r) => r.json()),
      (value) => value.total > 0,
    );
    expect(kept.traces[0]).toMatchObject({
      endpoint: "POST /api/dash/echo",
      status: "ok",
    });
    expect(existsSync(join(root, ".brick", "telemetry.sqlite"))).toBe(true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
  await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow();
}, 30000);

it("keeps nothing on disk when history is turned off", async () => {
  const root = await tempProject("vite-dashboard");
  await writeApp(root);
  const port = await freePort();
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [
      brickClient({ entry: "./app.ts", dashboard: { port, historyDays: 0 } }),
    ],
    server: { middlewareMode: true },
  });
  try {
    await server.environments.ssr!.runner.import("virtual:brick-app");
    const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) =>
      r.json(),
    );
    expect(state.historyDays).toBe(0);
    expect((await fetch(`http://127.0.0.1:${port}/api/history`)).status).toBe(
      404,
    );
    expect(existsSync(join(root, ".brick"))).toBe(false);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("gives the dashboard the app's API documents and where the server listens", async () => {
  const root = await tempProject("vite-dashboard");
  await writeApp(
    root,
    `, title: "Echo API", reference: { documents: [
      { title: "Auth", document: async () => ({ openapi: "3.1.0", info: { title: "Auth", version: "1" }, paths: { "/sign-in": {} } }) },
      { title: "Broken", document: () => { throw new Error("no schema"); } },
    ] }`,
  );
  const port = await freePort();
  const vitePort = await freePort();
  // The documents are built when the app loads, during createServer.
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [
      brickClient({ entry: "./app.ts", dashboard: { port, historyDays: 0 } }),
    ],
    server: { port: vitePort, strictPort: true, host: "127.0.0.1" },
  });
  try {
    await server.listen();
    const state = await eventually(
      () => fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json()),
      (value) => Boolean(value.api?.appUrl),
    );
    // Once the app has loaded and the server is listening, both are known.
    // A document that cannot be built is skipped, not fatal.
    expect(state.api).toMatchObject({
      appUrl: `http://localhost:${vitePort}`,
      titles: ["Echo API", "Auth"],
    });
    expect(warnings.join("\n")).toContain('Skipping the "Broken" API document');

    const documents = await fetch(`http://127.0.0.1:${port}/api/openapi`).then(
      (r) => r.json(),
    );
    expect(documents.map((item: { title: string }) => item.title)).toEqual([
      "Echo API",
      "Auth",
    ]);
    expect(Object.keys(documents[0].document.paths)).toContain(
      "/api/dash/echo",
    );
    expect(Object.keys(documents[1].document.paths)).toEqual(["/sign-in"]);
  } finally {
    console.warn = warn;
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("shows the app's developer documentation, relative to the app entry, and follows edits", async () => {
  const root = await tempProject("vite-dashboard");
  // The app lives in src/, the docs beside src/: "../docs" reads from app.ts.
  await writeApp(root, `, documentation: "../docs"`, "src");
  await Bun.write(
    join(root, "docs/index.mdx"),
    "---\ntitle: Home\n---\n\nWelcome.\n",
  );
  // A decoy where "./docs" would land if paths started at the project root.
  await Bun.write(join(root, "src/docs/index.mdx"), "---\ntitle: Wrong\n---\n");
  const port = await freePort();
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [
      brickClient({
        entry: "./src/app.ts",
        dashboard: { port, historyDays: 0 },
      }),
    ],
    server: { middlewareMode: true },
  });
  const state = () =>
    fetch(`http://127.0.0.1:${port}/api/state`).then((r) => r.json());
  try {
    const ready = await eventually(
      state,
      (value) => value.docs?.status === "ready",
    );
    expect(ready.docs).toMatchObject({ title: "Docs", components: false });
    const info = await fetch(`http://127.0.0.1:${port}/api/docs`).then((r) =>
      r.json(),
    );
    expect(info.tree.children).toEqual([
      { type: "page", name: "Home", url: "/" },
    ]);

    await Bun.write(join(root, "docs/more.mdx"), "# More\n");
    const changed = await eventually(
      state,
      (value) => value.docs?.revision > ready.docs.revision,
    );
    expect(changed.docs.revision).toBeGreaterThan(ready.docs.revision);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("has no docs when the app sets no documentation", async () => {
  const root = await tempProject("vite-dashboard");
  await writeApp(root);
  const port = await freePort();
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [
      brickClient({ entry: "./app.ts", dashboard: { port, historyDays: 0 } }),
    ],
    server: { middlewareMode: true },
  });
  try {
    await server.environments.ssr!.runner.import("virtual:brick-app");
    const state = await fetch(`http://127.0.0.1:${port}/api/state`).then((r) =>
      r.json(),
    );
    expect(state.docs).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/api/docs`)).status).toBe(404);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("names the plugin's own option when the dashboard port is taken", async () => {
  const taken = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(),
  });
  const warnings: string[] = [];
  try {
    const dashboard = await startViteDashboard({
      port: taken.port,
      directory: import.meta.dir,
      entry: join(import.meta.dir, "app.ts"),
      historyDays: 0,
      logger: { info() {}, warn: (message) => warnings.push(message) },
    });
    expect(dashboard).toBeUndefined();
    expect(warnings.join("\n")).toContain("dashboard.port in brickClient()");
    expect(warnings.join("\n")).not.toContain("--dashboard-port");
  } finally {
    taken.stop(true);
  }
});
