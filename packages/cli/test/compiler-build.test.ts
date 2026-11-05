import { expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, rename, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

it("bundles the lazy SQLite adapter without another adapter import", async () => {
  const deploy = await mkdtemp(join(tmpdir(), "brick-sqlite-deploy-"));
  try {
    const entry = join(deploy, "entry.ts");
    const sqlite = resolve(import.meta.dir, "../../core/src/db/sqlite.ts");
    await Bun.write(
      entry,
      `import { createSQLiteDatabase } from ${JSON.stringify(sqlite)};
       const db = createSQLiteDatabase();
       console.log(JSON.stringify(db.$client.query("SELECT 42 AS answer").get()));
       db.$client.close();`,
    );
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      outdir: deploy,
      naming: "server.js",
    });
    expect(result.success).toBe(true);
    await rm(entry);
    const child = Bun.spawn([process.execPath, join(deploy, "server.js")], {
      cwd: deploy,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ answer: 42 });
  } finally {
    await rm(deploy, { recursive: true, force: true });
  }
}, 20000);

it("rejects an entry that does not default-export a BrickApp", async () => {
  const root = resolve(import.meta.dir, "../../..");
  await mkdir(join(root, ".brick"), { recursive: true });
  const dir = await mkdtemp(join(root, ".brick/invalid-app-"));
  try {
    const entry = join(dir, "app.ts");
    await Bun.write(entry, "export default {};");
    const build = Bun.spawn(
      [
        process.execPath,
        join(root, "packages/cli/src/bin.ts"),
        "build",
        entry,
        "--outdir",
        join(dir, "dist"),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain(
      "must default-export a BrickApp created by brick()",
    );
    expect(await Bun.file(join(dir, "dist/server.js")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const aot of [true, false]) {
  it(`builds a deployable ${aot ? "AOT" : "runtime compiled"} server and runs generated handlers without the definitions module`, async () => {
    const root = resolve(import.meta.dir, "../../..");
    await mkdir(join(root, ".brick"), { recursive: true });
    const dir = await mkdtemp(join(root, ".brick/compiler-test-"));
    const deploy = await mkdtemp(join(tmpdir(), "brick-deploy-"));
    let server: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const build = Bun.spawn(
        [
          process.execPath,
          join(root, "packages/cli/src/bin.ts"),
          "build",
          join(import.meta.dir, "fixtures/compiler-app.ts"),
          "--outdir",
          dir,
          ...(aot ? [] : ["--no-aot"]),
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [code, stdout, stderr] = await Promise.all([
        build.exited,
        new Response(build.stdout).text(),
        new Response(build.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain("Compiled 3 services");
      const ir = await Bun.file(join(dir, "brick-ir.json")).json();
      expect(ir.prefix).toBe("/v1");
      expect(ir.services).toEqual(["built", "plain", "store"]);
      expect(
        ir.routes.some((r: any) => r.path === "/v1/built/public/pages/:slug"),
      ).toBe(true);
      expect(ir.preparations[0].service).toBe("store");
      expect(await Bun.file(join(dir, "routes.js")).text()).toContain(
        "export const ir",
      );
      const bundle = await Bun.file(join(dir, "server.js")).text();
      expect(bundle.includes("Compiled.register(")).toBe(aot);
      // Deploy only the bundle, outside the source tree and node_modules resolution.
      await rename(join(dir, "server.js"), join(deploy, "server.js"));
      await Bun.write(
        join(deploy, "no-codegen.js"),
        `
// Let the OS allocate the test server's port when it binds.
const serve = Bun.serve.bind(Bun);
Bun.serve = options => serve({ ...options, port: 0 });
globalThis.Function = new Proxy(Function, {
  construct(target, args) {
    if (args.some(arg => typeof arg === "string" && arg.startsWith("return (function bindAction")))
      throw new Error("Brick handlers must use build-time factories");
    return Reflect.construct(target, args);
  }
});
`,
      );
      server = Bun.spawn(
        [
          process.execPath,
          "--preload",
          join(deploy, "no-codegen.js"),
          join(deploy, "server.js"),
        ],
        {
          cwd: deploy,
          env: { ...process.env, PORT: "4000" },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
      let output = "";
      while (!output.includes("http://localhost:")) {
        const chunk = await Promise.race([
          reader.read(),
          Bun.sleep(5000).then(() => {
            throw new Error("Built server did not start");
          }),
        ]);
        if (chunk.done)
          throw new Error(
            "Built server exited before listening: " +
              (await new Response(server.stderr as ReadableStream).text()),
          );
        output += new TextDecoder().decode(chunk.value);
      }
      const base = output.match(/http:\/\/localhost:\d+/)![0];
      const ready = await fetch(`${base}/v1/plain/get-ready`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ ok: true });
      expect((await fetch(`${base}/v1/excluded/hello`)).status).toBe(404);
      expect(await (await fetch(`${base}/raw`)).json()).toEqual({ raw: true });
      const custom = await fetch(`${base}/custom`);
      expect(custom.headers.get("x-app-hook")).toBe("preserved");
      expect(await custom.json()).toEqual({
        custom: true,
      });
      const allowed = await fetch(`${base}/v1/built/public/pages/hello`, {
        headers: { "x-user": "alice" },
      });
      expect(await allowed.json()).toEqual({ slug: "hello" });
      expect(allowed.headers.get("x-request-id")).toBeTruthy();
      expect(await (await fetch(`${base}/v1/store/page/one`)).json()).toEqual({
        id: "one",
        title: "Built page",
      });
      const list = (await (
        await fetch(`${base}/v1/store/page/query`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ limit: 10, includeTotal: true }),
        })
      ).json()) as any;
      expect(list.total).toBe(1);
      expect(list.items).toEqual([{ id: "one", title: "Built page" }]);
      const unfiltered = await fetch(`${base}/v1/store/page/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"includeTotal":true}',
      });
      expect(unfiltered.status).toBe(200);
      expect(await unfiltered.json()).toMatchObject({
        total: 1,
        items: list.items,
      });
      const createdResponse = await fetch(`${base}/v1/store/page`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"id":"created","title":"Created in deployed bundle"}',
      });
      expect(createdResponse.status).toBe(200);
      const created = (await createdResponse.json()) as any;
      expect(created.title).toBe("Created in deployed bundle");
      const changed = await fetch(`${base}/v1/store/page/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: '{"data":{"title":"Updated in deployed bundle"}}',
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toEqual({
        id: created.id,
        title: "Updated in deployed bundle",
      });
      expect(
        (
          await fetch(`${base}/v1/store/page/${created.id}`, {
            method: "DELETE",
          })
        ).status,
      ).toBe(200);
      expect((await fetch(`${base}/v1/built/public/pages/hello`)).status).toBe(
        401,
      );
      expect(
        (
          await fetch(`${base}/v1/built/public/pages/x`, {
            headers: { "x-user": "alice" },
          })
        ).status,
      ).toBe(400);
      expect((await fetch(`${base}/api-docs`)).status).toBe(200);
      expect((await fetch(`${base}/docs`)).status).toBe(404);
      expect((await fetch(`${base}/reference`)).status).toBe(200);
      const spec = (await (await fetch(`${base}/spec.json`)).json()) as any;
      expect(spec.info).toMatchObject({
        title: "Compiled app",
        version: "3.2.1",
      });
      expect(spec.paths["/raw"]).toBeDefined();
      expect(spec.paths["/v1/built/get-page"]).toBeUndefined();
      expect(Object.keys(spec.paths["/v1/built/public/pages/{slug}"])).toEqual([
        "get",
      ]);
      expect((await fetch(`${base}/v1/built/get-page`)).status).toBe(404);
      expect(
        (await fetch(`${base}/v1/built/public/pages/hello`, { method: "POST" }))
          .status,
      ).toBe(404);
      server.kill("SIGTERM");
      expect(await server.exited).toBe(0);
      let remainingOutput = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        remainingOutput += new TextDecoder().decode(chunk.value);
      }
      expect(remainingOutput).not.toMatch(/^(GET|POST|PATCH|DELETE) /m);
    } finally {
      server?.kill();
      await rm(dir, { recursive: true, force: true });
      await rm(deploy, { recursive: true, force: true });
    }
  }, 20000);
}

it("a built server serves the monitoring dashboard its app asks for, as brick start does", async () => {
  const root = resolve(import.meta.dir, "../../..");
  const dir = await mkdtemp(join(tmpdir(), "brick-dashboard-build-"));
  let server: ReturnType<typeof Bun.spawn> | undefined;
  try {
    // The built server imports the dashboard from @brickkit/cli at run time.
    await mkdir(join(dir, "node_modules/@brickkit"), { recursive: true });
    for (const name of ["core", "cli"])
      await symlink(
        join(root, "packages", name),
        join(dir, "node_modules/@brickkit", name),
      );
    const free = () => {
      const listener = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = listener.port!;
      listener.stop(true);
      return port;
    };
    const dashboardPort = free();
    const appPort = free();
    await Bun.write(
      join(dir, "app.ts"),
      `import { brick } from "@brickkit/core";
export default brick({ dashboard: { port: ${dashboardPort} } });
`,
    );
    const build = Bun.spawn(
      [
        process.execPath,
        join(root, "packages/cli/src/bin.ts"),
        "build",
        "app.ts",
        // AOT needs elysia beside the entry; this test is about the dashboard.
        "--no-aot",
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stderr] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    server = Bun.spawn([process.execPath, "dist/brick/server.js"], {
      cwd: dir,
      env: { ...process.env, PORT: String(appPort) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = Date.now() + 10000;
    let health: Response | undefined;
    while (!health && Date.now() < deadline) {
      health = await fetch(`http://127.0.0.1:${dashboardPort}/_health`).catch(
        () => undefined,
      );
      if (!health) await Bun.sleep(50);
    }
    expect(health?.status).toBe(200);
  } finally {
    server?.kill();
    await server?.exited;
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
