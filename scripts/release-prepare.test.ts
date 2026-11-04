import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PACKAGES = ["core", "crud", "cli", "bullmq-world", "redis-world"];

test("prepares candidates and dispatches releases without creating release refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "brick-release-prepare-"));
  const checkout = join(root, "checkout");
  const origin = join(root, "origin.git");
  await mkdir(join(checkout, "scripts"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  try {
    await cp(
      new URL("./release.ts", import.meta.url),
      join(checkout, "scripts/release.ts"),
    );
    await writeFile(join(checkout, ".gitignore"), "node_modules\n");
    await writeFile(
      join(checkout, "package.json"),
      JSON.stringify({
        private: true,
        workspaces: ["packages/*"],
        scripts: { build: "exit 99", test: "exit 99" },
      }),
    );
    for (const name of PACKAGES) {
      const directory = join(checkout, "packages", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          name: `@brickkit/${name}`,
          version: "0.7.2",
          ...(name === "cli"
            ? { dependencies: { "@brickkit/core": "^0.7.2" } }
            : {}),
          ...(name === "crud"
            ? { peerDependencies: { "@brickkit/core": "^0.7.2" } }
            : {}),
          ...(name === "bullmq-world"
            ? { dependencies: { "@brickkit/redis-world": "0.7.2" } }
            : {}),
        }),
      );
    }
    await mkdir(join(checkout, "sdk/rust/brick"), { recursive: true });
    await writeFile(
      join(checkout, "sdk/rust/brick/Cargo.toml"),
      '[package]\nname = "brickkit"\nversion = "0.7.2"\n\n[dependencies]\nserde = { version = "1" }\n',
    );
    await writeFile(
      join(checkout, "sdk/rust/Cargo.lock"),
      '[[package]]\nname = "brickkit"\nversion = "0.7.2"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n',
    );
    execFileSync(process.execPath, ["install"], {
      cwd: checkout,
      stdio: "pipe",
    });
    git("init", "-b", "main");
    git("config", "user.name", "Release test");
    git("config", "user.email", "release@example.com");
    git("add", ".");
    git("commit", "-m", "fixture");
    git("init", "--bare", origin);
    git("--git-dir", origin, "fetch", checkout, "HEAD:refs/heads/main");
    git("remote", "add", "origin", origin);
    const head = git("rev-parse", "HEAD");
    execFileSync(
      process.execPath,
      ["scripts/release.ts", "patch", "--prepare"],
      { cwd: checkout, stdio: "pipe" },
    );
    for (const name of PACKAGES) {
      const manifest = await Bun.file(
        join(checkout, "packages", name, "package.json"),
      ).json();
      expect(manifest.version).toBe("0.7.3");
      if (name === "cli")
        expect(manifest.dependencies["@brickkit/core"]).toBe("^0.7.3");
      if (name === "crud")
        expect(manifest.peerDependencies["@brickkit/core"]).toBe("^0.7.3");
      if (name === "bullmq-world")
        expect(manifest.dependencies["@brickkit/redis-world"]).toBe("0.7.3");
    }
    // The crate moves in lockstep; the Go module has no version to bump.
    expect(
      await Bun.file(join(checkout, "sdk/rust/brick/Cargo.toml")).text(),
    ).toContain(
      'version = "0.7.3"\n\n[dependencies]\nserde = { version = "1" }',
    );
    expect(await Bun.file(join(checkout, "sdk/rust/Cargo.lock")).text()).toBe(
      '[[package]]\nname = "brickkit"\nversion = "0.7.3"\n\n[[package]]\nname = "serde"\nversion = "1.0.0"\n',
    );
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("tag", "--list")).toBe("");
    expect(git("--git-dir", origin, "rev-parse", "main")).toBe(head);
    expect(git("--git-dir", origin, "tag", "--list")).toBe("");
    expect(await Bun.file(join(checkout, "bun.lock")).text()).toContain(
      '"version": "0.7.3"',
    );
    git("checkout", "--", ".");
    await writeFile(
      join(checkout, "mock-github.ts"),
      `
import { mock } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { basename } from "node:path";
const execute = childProcess.execFileSync;
const exists = fs.existsSync;
mock.module("node:fs", () => ({ ...fs, existsSync: (path) => basename(path) === "gh" || exists(path) }));
mock.module("node:child_process", () => ({ ...childProcess, execFileSync: (file, args, options) => {
  if (basename(file) !== "gh") return execute(file, args, options);
  if (args[0] === "auth") return "";
  if (args[0] !== "workflow") throw new Error("Unexpected GitHub command");
  fs.writeFileSync("dispatch.json", JSON.stringify(args));
  return "queued";
} }));
`,
    );
    execFileSync(
      process.execPath,
      ["--preload", "./mock-github.ts", "scripts/release.ts", "patch"],
      { cwd: checkout, stdio: "pipe" },
    );
    expect(await Bun.file(join(checkout, "dispatch.json")).json()).toEqual([
      "workflow",
      "run",
      "publish-npm.yml",
      "--repo",
      "get-brickkit/brick",
      "--ref",
      "main",
      "-f",
      "bump=patch",
      "-f",
      "dry_run=false",
    ]);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("tag", "--list")).toBe("");
    expect(git("diff", "--name-only")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
