// A TS-only app builds and generates exactly what it did before Go and Rust
// services existed: no deploy folder, no polyglot contract, no extra output.
import { expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/bin.ts");
const entry = join(import.meta.dir, "fixtures/ts-only-app.ts");

async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout: stdout.replaceAll(cwd, "<root>"), stderr };
}

async function files(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();
}

it("builds and generates a TS-only app exactly as before", async () => {
  const root = await mkdtemp(resolve(import.meta.dir, "../.brick-ts-only-"));
  try {
    await Bun.write(
      join(root, "brick.config.ts"),
      `export default { entry: ${JSON.stringify(entry)}, client: { output: "_brick/contract.ts" } };\n`,
    );
    const gen = await run(root, "gen");
    expect(gen.code).toBe(0);
    const build = await run(root, "build", "--outdir", "dist");
    expect(build.code).toBe(0);
    expect(gen.stderr + build.stderr).toBe("");
    expect(await files(root)).toEqual([
      "_brick/contract.ts",
      "_brick/services.gen.ts",
      "brick.config.ts",
      "dist/brick-ir.json",
      "dist/routes.js",
      "dist/server.js",
      "dist/server.js.map",
    ]);
    expect(gen.stdout + build.stdout).toMatchSnapshot();
    expect(gen.stdout + build.stdout).not.toMatch(/remote|deploy|Deploy/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
