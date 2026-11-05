import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishedPackages } from "./published-packages.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brick-release-notes-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.com");
  mkdirSync(join(root, "scripts"));
  for (const script of ["release-notes.ts", "published-packages.ts"])
    copyFileSync(join(import.meta.dir, script), join(root, "scripts", script));
  copyFileSync(
    join(import.meta.dir, "../package.json"),
    join(root, "package.json"),
  );
  const packages = publishedPackages();
  const write = (version?: string) => {
    for (const { dir, data } of packages) {
      mkdirSync(join(root, "packages", dir), { recursive: true });
      writeFileSync(
        join(root, "packages", dir, "package.json"),
        JSON.stringify({
          name: data.name,
          devDependencies: data.devDependencies,
          version,
        }),
      );
    }
  };
  write();
  // Every published package carries the lockstep version; the change itself lands in the first.
  const commit = (subject: string, version: string) => {
    write(version);
    writeFileSync(join(root, "packages", packages[0]!.dir, "change"), subject);
    git("add", ".");
    git("commit", "--allow-empty", "-m", subject);
  };
  const notes = () =>
    execFileSync(process.execPath, ["scripts/release-notes.ts"], {
      cwd: root,
      encoding: "utf8",
    });
  return { root, git, commit, notes };
}

test("beta notes include only changes since the previous beta and omit maintenance", () => {
  const { git, commit, notes } = fixture();
  commit("feat: old stable feature", "0.2.4");
  git("tag", "v0.2.4");
  commit("feat: old beta feature", "0.3.0-beta.4");
  git("tag", "v0.3.0-beta.4");
  commit("fix: repository metadata", "0.3.0-beta.4");
  commit("style: formatting", "0.3.0-beta.4");
  commit("chore(release): v0.3.0-beta.5", "0.3.0-beta.5");
  git("tag", "v0.3.0-beta.5");
  const output = notes();
  expect(output).toContain("repository metadata");
  expect(output).toContain("v0.3.0-beta.4...v0.3.0-beta.5");
  for (const noise of [
    "old stable feature",
    "old beta feature",
    "formatting",
    "chore(release)",
    "Other Changes",
    "## @brickkit/crud",
    "## @brickkit/cli",
  ]) {
    expect(output).not.toContain(noise);
  }
});

test("stable notes include beta features and preserve breaking change markers", () => {
  const { git, commit, notes } = fixture();
  commit("chore(release): v0.2.4", "0.2.4");
  git("tag", "v0.2.4");
  commit("feat(core)!: new plugin API", "0.3.0-beta.0");
  git("tag", "v0.3.0-beta.0");
  commit("chore(release): v0.3.0", "0.3.0");
  git("tag", "v0.3.0");
  expect(notes()).toContain("feat(core)!: new plugin API");
  expect(notes()).toContain("v0.2.4...v0.3.0");
});

test("notes list changes to the world packages", () => {
  const { root, git, commit, notes } = fixture();
  commit("chore(release): v0.8.1", "0.8.1");
  git("tag", "v0.8.1");
  for (const pkg of ["bullmq-world", "redis-world"]) {
    writeFileSync(join(root, "packages", pkg, "index.ts"), pkg);
    git("add", ".");
    git("commit", "-m", `feat(${pkg}): start a run once`);
  }
  const output = notes();
  expect(output).toContain("## @brickkit/bullmq-world");
  expect(output).toContain("## @brickkit/redis-world");
  expect(output).not.toContain("## @brickkit/core");
});

test("notes list changes to the inspector under the CLI, which ships it", () => {
  const { root, git, commit, notes } = fixture();
  commit("chore(release): v0.8.1", "0.8.1");
  git("tag", "v0.8.1");
  mkdirSync(join(root, "packages/workflow-inspector"), { recursive: true });
  writeFileSync(
    join(root, "packages/workflow-inspector/package.json"),
    JSON.stringify({ name: "@brickkit/workflow-inspector", private: true }),
  );
  git("add", ".");
  git(
    "commit",
    "-m",
    "fix(workflow-inspector): show the trace for an unknown tab",
  );
  const output = notes();
  expect(output).toContain("## @brickkit/cli");
  expect(output).toContain("show the trace for an unknown tab");
  expect(output).not.toContain("## @brickkit/workflow-inspector");
  expect(output).not.toContain("## @brickkit/core");
});

test("notes ignore tags on unrelated branches and handle maintenance-only releases", () => {
  const { git, commit, notes } = fixture();
  commit("feat: initial feature", "0.2.4");
  git("tag", "v0.2.4");
  git("checkout", "-b", "unrelated");
  commit("feat: unrelated", "0.9.0");
  git("tag", "v0.9.0");
  git("checkout", "main");
  commit("chore(release): v0.3.0-beta.0", "0.3.0-beta.0");
  expect(notes()).toContain("No user-facing package changes.");
  expect(notes()).toContain("v0.2.4...v0.3.0-beta.0");
});

test("notes link commits and the changelog to the repository the packages publish from", () => {
  const { git, commit, notes } = fixture();
  commit("chore(release): v0.2.4", "0.2.4");
  git("tag", "v0.2.4");
  commit("fix: link to the right repository", "0.2.5");
  const sha = git("rev-parse", "HEAD");
  git("tag", "v0.2.5");
  const output = notes();
  const repo = "https://github.com/get-brickkit/brick";
  expect(output).toContain(`(${repo}/commit/${sha})`);
  expect(output).toContain(`(${repo}/compare/v0.2.4...v0.2.5)`);
});
