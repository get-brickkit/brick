import { expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runCli, tempProject } from "./helpers";

const entry = join(import.meta.dir, "fixtures/client-app.ts");

const run = (cwd: string, ...args: string[]) => runCli(args, { cwd });

it("gen openapi loads app entry and generates OpenAPI spec", async () => {
  const root = await tempProject("cli-test");
  try {
    const result = await run(root, "gen", "openapi", entry);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const spec = JSON.parse(result.stdout);
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Brick-TS API Mesh");
    expect(spec.paths["/v2/records/search"]).toBeDefined();
    expect(spec.paths["/v2/users/{id}"]).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("gen openapi writes the document the app serves at /openapi.json", async () => {
  const app = join(import.meta.dir, "fixtures/compiler-app.ts");
  const result = await run(import.meta.dir, "gen", "openapi", app);
  expect(result.code).toBe(0);
  const spec = JSON.parse(result.stdout);
  expect(spec.info).toMatchObject({ title: "Compiled app", version: "3.2.1" });
  expect(spec.paths["/raw"]).toBeDefined();
});

it("gen openapi writes to --output file", async () => {
  const root = await tempProject("cli-test");
  try {
    const outputFile = join(root, "api.json");
    const result = await run(
      root,
      "gen",
      "openapi",
      entry,
      "--output",
      outputFile,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(outputFile);
    const spec = JSON.parse(await Bun.file(outputFile).text());
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.paths["/v2/records/search"]).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("info loads app entry and exports architecture", async () => {
  const root = await tempProject("cli-test");
  try {
    const result = await run(root, "info", entry);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const arch = JSON.parse(result.stdout);
    expect(arch.version).toBe("1.0.0");
    expect(arch.services.some((s: any) => s.name === "records")).toBe(true);
    expect(arch.services.some((s: any) => s.name === "users")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("info fails on an entry that does not exist", async () => {
  const root = await tempProject("cli-test");
  try {
    expect((await run(root, "info", join(root, "missing.ts"))).code).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("pages info exports effective routes matching the live server", async () => {
  const cwd = resolve(import.meta.dir, "../../../examples/pages");
  const result = await run(cwd, "info", "src/api/app.ts");
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  const architecture = JSON.parse(result.stdout);
  const pages = architecture.services.find(
    (service: any) => service.name === "pages",
  );
  expect(pages.options.database).toBeUndefined();
  expect(pages.databaseConfig).toMatchObject({
    name: "pages",
    engine: "postgres",
  });
  expect(
    pages.actions.find((action: any) => action.name === "get_public_page"),
  ).toMatchObject({ method: "GET", path: "/api/pages/public/:slug" });
  expect(
    pages.actions.find((action: any) => action.name === "page.update"),
  ).toMatchObject({ method: "PATCH", path: "/api/pages/page/:id" });

  // Use a separate process so the pages app's registry/secrets do not leak into other tests.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import app from "./src/api/app.ts";
    import { brick, getGlobalRegistry } from "@brickkit/core";
    const registry = getGlobalRegistry();
    const original = registry.exportArchitecture(app.definition);
    const prefixed = brick({ services: [...app.definition.services], prefix: "/v9", requestLogging: false });
    app.listen({ port: 0 });
    prefixed.listen({ port: 0 });
    try {
      const live = await fetch(app.server.url + "_brick/services").then(r => r.json());
      const prefixedLive = await fetch(prefixed.server.url + "_brick/services").then(r => r.json());
      console.log(JSON.stringify({ original, live, prefixedLive, current: registry.exportArchitecture(prefixed.definition),
        routes: app.routes.map(({ method, path }) => ({ method, path })),
        prefixedRoutes: prefixed.routes.map(({ method, path }) => ({ method, path })) }));
    } finally {
      await app.stop();
      await prefixed.stop();
    }
  `,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  const live = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(live.original).toEqual(architecture);
  expect(live.live).toEqual(architecture);
  expect(live.current).toEqual(live.prefixedLive);
  for (const action of pages.actions) {
    expect(live.routes).toContainEqual({
      method: action.method,
      path: action.path,
    });
  }
  const prefixedPages = live.prefixedLive.services.find(
    (service: any) => service.name === "pages",
  );
  expect(
    prefixedPages.actions.find((action: any) => action.name === "page.update"),
  ).toMatchObject({ method: "PATCH", path: "/v9/pages/page/:id" });
  expect(
    prefixedPages.actions.find(
      (action: any) => action.name === "get_public_page",
    ),
  ).toMatchObject({ method: "GET", path: "/v9/pages/public/:slug" });
  for (const action of prefixedPages.actions) {
    expect(live.prefixedRoutes).toContainEqual({
      method: action.method,
      path: action.path,
    });
  }
});
