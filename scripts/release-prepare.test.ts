import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishedPackages } from "./published-packages.ts";

const FIELDS = ["dependencies", "peerDependencies", "devDependencies"];
const PACKAGES = publishedPackages();
const NAMES = new Set(PACKAGES.map((p) => p.data.name));
// The real packages, reduced to their dependencies on each other, at 0.7.2.
const siblingDeps = (data: any, version: string) =>
  Object.fromEntries(
    FIELDS.map((field) => [
      field,
      Object.fromEntries(
        Object.entries(data[field] ?? {})
          .filter(([dep]) => NAMES.has(dep))
          .map(([dep, range]) => [
            dep,
            `${String(range).startsWith("^") ? "^" : ""}${version}`,
          ]),
      ),
    ]),
  );

// A checkout of the real packages at 0.7.2, pushed to a bare origin.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "brick-release-prepare-"));
  roots.push(root);
  const checkout = join(root, "checkout");
  const origin = join(root, "origin.git");
  await mkdir(join(checkout, "scripts"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  for (const script of ["release.ts", "published-packages.ts"])
    await cp(
      new URL(`./${script}`, import.meta.url),
      join(checkout, "scripts", script),
    );
  await writeFile(join(checkout, ".gitignore"), "node_modules\n");
  await writeFile(
    join(checkout, "package.json"),
    JSON.stringify({
      private: true,
      repository: { url: "git+https://github.com/get-brickkit/brick.git" },
      workspaces: ["packages/*"],
      scripts: { build: "exit 99", test: "exit 99" },
    }),
  );
  for (const { dir, data } of PACKAGES) {
    const directory = join(checkout, "packages", dir);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: data.name,
        version: "0.7.2",
        ...siblingDeps(data, "0.7.2"),
      }),
    );
  }
  // A private package is neither checked for lockstep nor bumped.
  await mkdir(join(checkout, "packages/private-tool"));
  await writeFile(
    join(checkout, "packages/private-tool/package.json"),
    JSON.stringify({ name: "private-tool", version: "9.9.9", private: true }),
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
  const noRefsCreated = () => {
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("tag", "--list")).toBe("");
    expect(git("--git-dir", origin, "rev-parse", "main")).toBe(head);
    expect(git("--git-dir", origin, "tag", "--list")).toBe("");
  };
  return { checkout, git, noRefsCreated };
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("--prepare stages the bumped manifests and lockfile without creating release refs", async () => {
  const { checkout, noRefsCreated } = await fixture();
  execFileSync(process.execPath, ["scripts/release.ts", "patch", "--prepare"], {
    cwd: checkout,
    stdio: "pipe",
  });
  for (const { dir, data } of PACKAGES) {
    const manifest = await Bun.file(
      join(checkout, "packages", dir, "package.json"),
    ).json();
    expect(manifest).toEqual({
      name: data.name,
      version: "0.7.3",
      ...siblingDeps(data, "0.7.3"),
    });
  }
  expect(
    (
      await Bun.file(
        join(checkout, "packages/private-tool/package.json"),
      ).json()
    ).version,
  ).toBe("9.9.9");
  noRefsCreated();
  expect(await Bun.file(join(checkout, "bun.lock")).text()).toContain(
    '"version": "0.7.3"',
  );
}, 15000);

test("a release dispatches the publish workflow and changes nothing locally", async () => {
  const { checkout, git, noRefsCreated } = await fixture();
  // release.ts resolves gh only from fixed system directories (no PATH), so
  // the fake goes in through a preload instead of a script on PATH.
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
  noRefsCreated();
  expect(git("status", "--porcelain", "--untracked-files=no")).toBe("");
}, 15000);
