import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  findConfigFile,
  loadConfig,
  resolvePort,
  resolveProject,
  validateConfig,
} from "../src/config";

const cli = resolve(import.meta.dir, "../src/bin.ts");
const roots: string[] = [];

async function project(files: Record<string, string>) {
  const root = await mkdtemp(
    resolve(import.meta.dir, "../.brick-config-test-"),
  );
  roots.push(root);
  for (const [file, source] of Object.entries(files))
    await Bun.write(join(root, file), source);
  return root;
}

async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PORT: undefined },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

const APP = `import { brick, defineService, t } from "@brickkit/core";
export const notes = defineService("notes");
notes.action({ name: "list", output: t.Array(t.String()), execute: () => [] });
export default brick({ services: [notes] });
`;

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("brick.config.ts validation", () => {
  const error = (config: unknown) => {
    try {
      validateConfig(config);
    } catch (e) {
      return (e as Error).message;
    }
    return undefined;
  };

  it("accepts every key from the reference", () => {
    expect(
      error({
        entry: "src/app.ts",
        services: "src/services",
        generated: "_brick",
        client: { output: "_brick/contract.ts" },
        openapi: { output: "openapi.json" },
        dev: {
          port: 4000,
          frontend: "vite",
          dashboard: { port: 4001, historyDays: 7 },
        },
        build: { outdir: "dist", aot: true, requestLogging: true },
        dashboard: {
          extension: "src/dashboard/index.tsx",
          theme: {
            light: { primary: "oklch(0.55 0.2 260)" },
            dark: { primary: "red" },
            radius: "0.5rem",
            fonts: { sans: "Inter", mono: "JetBrains Mono" },
          },
        },
        lint: {
          presets: ["recommended", "layout"],
          rules: { "brick/test-colocated": "warn" },
          ignore: ["src/legacy/**"],
        },
      }),
    ).toBeUndefined();
    expect(error({ dev: { dashboard: false } })).toBeUndefined();
    expect(error({})).toBeUndefined();
  });

  it("names the key path of an unknown key, a bad type, or frontend without a client", () => {
    expect(error({ dev: { dashboard: { port: "4001" } } })).toBe(
      "brick.config.ts: dev.dashboard.port must be a port number",
    );
    expect(error({ dev: { prot: 1 } })).toBe(
      "brick.config.ts: unknown key dev.prot",
    );
    expect(error({ build: { aot: "yes" } })).toBe(
      "brick.config.ts: build.aot must be true or false",
    );
    expect(error({ dev: { dashboard: true } })).toBe(
      "brick.config.ts: dev.dashboard must be an object or false",
    );
    expect(error({ lint: { presets: ["fancy"] } })).toContain(
      "lint.presets must list presets",
    );
    expect(error({ lint: { rules: { "brick/naming": "loud" } } })).toContain(
      "lint.rules must map rule names",
    );
    expect(error({ dashboard: { theme: { light: { primary: 1 } } } })).toBe(
      "brick.config.ts: dashboard.theme.light must map token names to values",
    );
    expect(error({ dev: { frontend: "vite" } })).toBe(
      "brick.config.ts: dev.frontend requires client.output",
    );
    expect(error(null)).toContain("must default-export");
  });
});

describe("loading brick.config.ts", () => {
  it("finds the nearest config in parents, resolves paths from its folder, and is optional", async () => {
    const root = await project({
      "brick.config.ts": `export default { entry: "server/main.ts", generated: "gen" };\n`,
    });
    await mkdir(join(root, "a/b"), { recursive: true });
    expect(findConfigFile(join(root, "a/b"))).toBe(
      join(root, "brick.config.ts"),
    );
    const loaded = (await loadConfig(undefined, join(root, "a/b")))!;
    expect(loaded.root).toBe(root);
    expect(loaded.entry).toBe(join(root, "server/main.ts"));
    expect(loaded.services).toBe(join(root, "src/services"));
    expect(loaded.generated).toBe(join(root, "gen"));
    const bare = await project({});
    expect(await loadConfig(undefined, bare)).toBeUndefined();
    expect(await resolveProject(undefined, bare)).toMatchObject({
      file: undefined,
      root: bare,
      entry: join(bare, "src/app.ts"),
      contract: join(bare, "_brick/contract.ts"),
      outdir: join(bare, "dist/brick"),
    });
    await expect(loadConfig("nope.ts", bare)).rejects.toThrow("not found");
  });

  it("resolves the port: flag, then PORT, then config, then 4000, within 1-65535", () => {
    expect(resolvePort(5000, 6000, "7000")).toBe(5000);
    expect(resolvePort("5000", undefined, "7000")).toBe(5000);
    expect(resolvePort(undefined, 6000, "7000")).toBe(7000);
    expect(resolvePort(undefined, 6000, "")).toBe(6000);
    expect(resolvePort(undefined, undefined, undefined)).toBe(4000);
    expect(resolvePort("1", undefined, undefined)).toBe(1);
    expect(resolvePort("65535", undefined, undefined)).toBe(65535);
    for (const bad of ["0", "-1", "65536", "abc", "3000.5", ""])
      expect(() => resolvePort(bad, undefined, undefined)).toThrow(
        /Invalid port/,
      );
    expect(() => resolvePort(undefined, undefined, "invalid")).toThrow(
      /Invalid port/,
    );
  });
});

describe("CLI with brick.config.ts", () => {
  it("takes the entry and outputs from the config, flags win, and --config picks a file", async () => {
    const root = await project({
      "brick.config.ts": `export default { client: { output: "web/contract.ts" }, openapi: { output: "api.json" } };\n`,
      "src/app.ts": APP,
    });
    const client = await run(root, "gen", "client");
    expect(client.stderr).toBe("");
    expect(client.code).toBe(0);
    expect(await Bun.file(join(root, "web/contract.ts")).text()).toContain(
      "BrickClientAction<",
    );
    // No services folder yet: the manifest imports nothing.
    expect(
      await Bun.file(join(root, "_brick/services.gen.ts")).text(),
    ).toContain("export {};");
    expect((await run(root, "gen", "openapi")).code).toBe(0);
    expect((await Bun.file(join(root, "api.json")).json()).openapi).toBe(
      "3.1.0",
    );
    expect(
      (await run(root, "gen", "openapi", "--output", "flag.json")).code,
    ).toBe(0);
    expect(await Bun.file(join(root, "flag.json")).exists()).toBe(true);

    const other = await project({
      "settings/brick.config.ts": `export default { entry: "../src/app.ts", openapi: { output: "../explicit.json" } };\n`,
      "src/app.ts": APP,
    });
    expect(
      (
        await run(
          other,
          "gen",
          "openapi",
          "--config",
          "settings/brick.config.ts",
        )
      ).code,
    ).toBe(0);
    expect(await Bun.file(join(other, "explicit.json")).exists()).toBe(true);
  });

  it("fails at load with the key path", async () => {
    const root = await project({
      "brick.config.ts": `export default { dev: { dashboard: { port: 0 } } };\n`,
      "src/app.ts": APP,
    });
    const result = await run(root, "gen", "client");
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe(
      "brick.config.ts: dev.dashboard.port must be a port number",
    );
  });

  it("bare brick gen writes everything the config names", async () => {
    const root = await project({
      "brick.config.ts": `export default { client: { output: "c.ts" }, openapi: { output: "o.json" } };\n`,
      "src/app.ts": APP,
    });
    const result = await run(root, "gen");
    expect(result.code).toBe(0);
    for (const file of ["_brick/services.gen.ts", "c.ts", "o.json"])
      expect(await Bun.file(join(root, file)).exists()).toBe(true);
  });
});
