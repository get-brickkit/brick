import { expect, it } from "bun:test";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { TEMPORARY_FILE_PREFIX } from "../src/client-contract-file";
import { CLI, runCli, tempProject } from "./helpers";

const entry = join(import.meta.dir, "fixtures/client-app.ts");

const run = (cwd: string, ...args: string[]) =>
  runCli(["gen", "client", ...args], { cwd });

it("generates a browser-safe contract with default/custom output and preserves unchanged files", async () => {
  const root = await tempProject("cli-test");
  try {
    await mkdir(join(root, "_brick"));
    await Bun.write(join(root, "_brick/contract.ts"), "previous contract\n");
    const result = await run(root, entry);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const output = join(root, "_brick/contract.ts");
    expect(result.stdout).toContain(output);
    const source = await Bun.file(output).text();
    expect(await readdir(join(root, "_brick"))).toEqual(["contract.ts"]);
    expect(source).toContain("BrickClientAction<");
    expect(source).toContain("export type BrickJsonValue =");
    expect(source).toContain("{ [key: string]: BrickJsonValue }");
    expect(source).toContain("/v2/records/:doctype/value");
    expect(source).not.toContain("private_tool");
    const modified = (await stat(output)).mtimeMs;
    await Bun.sleep(20);
    expect((await run(root, entry)).code).toBe(0);
    expect((await stat(output)).mtimeMs).toBe(modified);
    expect((await run(root, entry, "--output", "web/api.ts")).code).toBe(0);
    expect(await Bun.file(join(root, "web/api.ts")).text()).toBe(source);
    const bundle = await Bun.build({
      entrypoints: [output],
      target: "browser",
    });
    expect(bundle.success).toBe(true);
    const browserSource = await bundle.outputs[0]!.text();
    expect(browserSource).not.toContain("__backend_only__");
    expect(browserSource).not.toContain("bun:sqlite");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects invalid arguments/default exports and never overwrites the app entry", async () => {
  const root = await tempProject("cli-test");
  try {
    for (const args of [
      [],
      ["--output", "api.ts"],
      [entry, "--output"],
      [entry, "--wat"],
      [entry, "--output", "--wat"],
    ]) {
      const result = await run(root, ...args);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Usage: brick gen client");
    }
    const invalid = join(root, "app.ts");
    await Bun.write(invalid, "export default {};\n");
    const output = join(root, "contract.ts");
    await Bun.write(output, "existing contract\n");
    const result = await run(root, invalid, "--output", output);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("default-export a BrickApp");
    expect(await Bun.file(output).text()).toBe("existing contract\n");
    expect((await run(root, invalid, "--output", invalid)).stderr).toContain(
      "must not overwrite",
    );
    expect(await Bun.file(invalid).text()).toBe("export default {};\n");
    expect((await run(root, join(root, "missing.ts"))).code).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves the previous contract and removes temporary files after write or rename failures", async () => {
  const root = await tempProject("cli-test");
  try {
    const directory = join(root, "output");
    await mkdir(directory);
    const output = join(directory, "contract.ts");
    await Bun.write(output, "previous contract\n");
    for (const operation of ["writeFile", "rename"]) {
      const preload = join(root, "failure.ts");
      await Bun.write(
        preload,
        `
import { mock } from "bun:test";
import * as fs from "node:fs/promises";
const originalWrite = fs.writeFile;
const originalRename = fs.rename;
mock.module("node:fs/promises", () => ({
  ...fs,
  ${operation}: async (path, ...args) => {
    if (String(path).includes(${JSON.stringify(TEMPORARY_FILE_PREFIX)})) {
      if (${JSON.stringify(operation)} === "writeFile") await originalWrite(path, "partial write");
      throw new Error("Injected ${operation} failure");
    }
    return ${operation === "writeFile" ? "originalWrite" : "originalRename"}(path, ...args);
  },
}));
`,
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preload,
          CLI,
          "gen",
          "client",
          entry,
          "--output",
          output,
        ],
        {
          cwd: root,
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain(`Injected ${operation} failure`);
      expect(await Bun.file(output).text()).toBe("previous contract\n");
      expect(await readdir(directory)).toEqual(["contract.ts"]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bundles the CLI without a Vite runtime dependency", async () => {
  const bundle = await Bun.build({
    entrypoints: [CLI],
    target: "bun",
    packages: "external",
  });
  expect(bundle.success).toBe(true);
  const source = await bundle.outputs[0]!.text();
  expect(source).not.toMatch(/(?:from\s*|import\s*\()["']vite(?:["'/])/);
});
