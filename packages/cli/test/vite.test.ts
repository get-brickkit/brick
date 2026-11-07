import { expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer, isRunnableDevEnvironment, build } from "vite";
import { brickClient } from "../src/vite";
import { tempProject, waitFor } from "./helpers";

it("loads any default-exported BrickApp and reloads edits to its action dependencies", async () => {
  const root = await tempProject("vite-test");
  const actions = (
    value: string,
  ) => `import { defineService, t } from "@brickkit/core";
const service = defineService("reload");
service.action({ name: "value", output: t.String(), input: t.Object({ id: t.String()${value == "after" ? ", locale: t.String()" : ""} }), execute: () => ${JSON.stringify(value)} });
export default service;
`;
  await Bun.write(join(root, "actions.ts"), actions("before"));
  await Bun.write(
    join(root, "any-name.ts"),
    `import { brick } from "@brickkit/core";
import service from "./actions";
export default brick({ services: [service], requestLogging: false });
`,
  );
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [brickClient({ entry: "./any-name.ts" })],
    server: { middlewareMode: true },
  });
  try {
    const environment = server.environments.ssr!;
    expect(isRunnableDevEnvironment(environment)).toBe(true);
    if (!isRunnableDevEnvironment(environment))
      throw new Error("Missing runnable SSR environment");
    const contractFile = join(root, "_brick/contract.ts");
    const initialContract = await Bun.file(contractFile).text();
    expect(initialContract).toContain('"id": string');
    expect(initialContract).not.toContain('"locale": string');
    const app = (await environment.runner.import("virtual:brick-app")).default;
    const request = () =>
      new Request("http://localhost/api/reload/value", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "1", locale: "en" }),
      });
    expect(await (await app.fetch(request())).text()).toBe("before");
    await Bun.write(join(root, "actions.ts"), actions("after"));
    await waitFor(async () => {
      const updated = (await environment.runner.import("virtual:brick-app"))
        .default;
      return (
        (await (await updated.fetch(request())).text()) === "after" &&
        (await Bun.file(contractFile).text()).includes('"locale": string')
      );
    }, 5000);
    expect(await Bun.file(contractFile).text()).toContain('"locale": string');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);

it("rejects a non-BrickApp default export and prevents browser imports of the backend", async () => {
  const root = await tempProject("vite-test");
  await Bun.write(join(root, "bad.ts"), "export default {};\n");
  await Bun.write(
    join(root, "client.ts"),
    'import app from "virtual:brick-app"; console.log(app);\n',
  );
  try {
    await expect(
      createServer({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [brickClient({ entry: "bad.ts" })],
        server: { middlewareMode: true },
      }),
    ).rejects.toThrow("default-export a BrickApp");
    await Bun.write(
      join(root, "good.ts"),
      `import { brick } from "@brickkit/core";
export default brick({ services: [], requestLogging: false });`,
    );
    await expect(
      build({
        configFile: false,
        root,
        logLevel: "silent",
        plugins: [brickClient({ entry: "good.ts" })],
        build: {
          write: false,
          rolldownOptions: { input: join(root, "client.ts") },
        },
      }),
    ).rejects.toThrow("server-only");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("generates the contract before a cold production build without bundling the backend", async () => {
  const root = await tempProject("vite-test");
  const entry = resolve(import.meta.dir, "fixtures/client-app.ts");
  await Bun.write(
    join(root, "client.ts"),
    `import { createBrickQueryClient } from "@brickkit/core/tanstack-query";
import { contract } from "./_brick/contract";
export const api = createBrickQueryClient({ baseUrl: "http://localhost", contract });
export const options = api.records.search.queryOptions({ input: { term: "typed" } });
`,
  );
  try {
    expect(await Bun.file(join(root, "_brick/contract.ts")).exists()).toBe(
      false,
    );
    const result = await build({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [brickClient({ entry })],
      build: {
        write: false,
        rolldownOptions: { input: join(root, "client.ts") },
      },
    });
    expect(await Bun.file(join(root, "_brick/contract.ts")).exists()).toBe(
      true,
    );
    const outputs = Array.isArray(result) ? result : [result];
    const source = outputs
      .flatMap((output) => ("output" in output ? output.output : []))
      .filter((output) => output.type === "chunk")
      .map((output) => output.code)
      .join("\n");
    expect(source).toContain("/v2/records/:doctype/value");
    expect(source).not.toContain("__backend_only__");
    expect(source).not.toContain("__unselected__");
    expect(source).not.toContain("defineService");
    expect(source).not.toContain("bun:sqlite");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves unchanged contracts and recovers from invalid edits with updated schemas and routes", async () => {
  const { stat } = await import("node:fs/promises");
  const root = await tempProject("vite-test");
  const file = join(root, "actions.ts");
  const output = join(root, "_brick/contract.ts");
  const source = (
    implementation: string,
    method = "POST",
    path = "/before",
    extra = "",
  ) => `
import { defineService, t } from "@brickkit/core";
const service = defineService("watched");
service.action({ name: "value", input: t.Object({ id: t.String() }), output: t.String(), method: ${JSON.stringify(method)}, path: ${JSON.stringify(path)}, execute: () => ${JSON.stringify(implementation)} });
${extra}
export default service;
`;
  await Bun.write(file, source("before"));
  await Bun.write(
    join(root, "app.ts"),
    `import { brick } from "@brickkit/core"; import service from "./actions"; export default brick({ services: [service] });`,
  );
  let hotUpdates = 0;
  const errors: unknown[] = [];
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [
      brickClient({ entry: "app.ts" }),
      {
        name: "observe-updates",
        hotUpdate() {
          if (this.environment.name === "ssr") hotUpdates++;
        },
      },
    ],
    server: { middlewareMode: true, watch: null },
  });
  // Drive Vite's change handler directly: Chokidar throttles rapid fixture writes.
  // The other HMR tests cover delivery through the real filesystem watcher.
  async function update(source: string) {
    await Bun.write(file, source);
    server.watcher.emit("change", file);
  }
  // The real Vite error channel drives its browser overlay.
  const hot = server.environments.ssr!.hot;
  const send = hot.send.bind(hot);
  hot.send = ((...args: Parameters<typeof send>) => {
    errors.push(args[0]);
    return send(...args);
  }) as typeof hot.send;
  try {
    const initial = await Bun.file(output).text();
    const timestamp = (await stat(output)).mtimeMs;
    await update(source("implementation only"));
    await waitFor(async () => hotUpdates > 0);
    expect(await Bun.file(output).text()).toBe(initial);
    expect((await stat(output)).mtimeMs).toBe(timestamp);
    await update("export default { syntax error");
    await waitFor(async () =>
      errors.some(
        (value) =>
          !!value &&
          typeof value === "object" &&
          "type" in value &&
          value.type === "error",
      ),
    );
    expect(await Bun.file(output).text()).toBe(initial);
    await update(
      source(
        "fixed",
        "PATCH",
        "/after/:id",
        'service.action({ name: "added", output: t.Number(), execute: () => 1 });',
      ),
    );
    await waitFor(async () =>
      (await Bun.file(output).text()).includes('"added"'),
    );
    expect(await Bun.file(output).text()).toContain("PATCH");
    expect(await Bun.file(output).text()).toContain("/after/:id");
    await update(source("removed", "GET", "/final"));
    await waitFor(
      async () => !(await Bun.file(output).text()).includes('"added"'),
    );
    expect(await Bun.file(output).text()).toContain("GET");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

it("removes actions registered on an imported service singleton after edits", async () => {
  const root = await tempProject("vite-test");
  const registration = join(root, "actions.ts");
  const contractFile = join(root, "_brick/contract.ts");
  await Bun.write(
    join(root, "service.ts"),
    'import { defineService } from "@brickkit/core"; export const service = defineService("singleton");',
  );
  const source = (name: string) =>
    `import { service } from "./service"; service.action({ name: ${JSON.stringify(name)}, execute: () => "ok" });`;
  await Bun.write(registration, source("removed"));
  await Bun.write(
    join(root, "app.ts"),
    'import { brick } from "@brickkit/core"; import { service } from "./service"; import "./actions"; export default brick({ services: [service] });',
  );
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    plugins: [brickClient({ entry: "app.ts" })],
    server: { middlewareMode: true },
  });
  try {
    expect(await Bun.file(contractFile).text()).toContain('"removed"');
    await Bun.write(registration, source("added"));
    await waitFor(
      async () => (await Bun.file(contractFile).text()).includes('"added"'),
      5000,
    ).catch(() => {});
    const updatedSource = await Bun.file(contractFile).text();
    expect(updatedSource).toContain('"added"');
    expect(updatedSource).not.toContain('"removed"');
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
