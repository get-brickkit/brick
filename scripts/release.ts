#!/usr/bin/env bun
// Dispatch a release through publish-npm.yml. The workflow validates and
// publishes every package before creating the release commit and tag.
//
//   bun run release [patch|minor|major|beta] [--dry-run|--prepare]
// --prepare stages manifests and the lockfile for CI validation without shipping.
// A stable bump from X.Y.Z-beta.N promotes it to X.Y.Z.
// All packages use the same version and ship under one v<version> tag.
//
// Prerequisites (checked up front):
//   - clean tracked tree, on main (stable) or beta, in sync with origin
//   - target tag(s) don't already exist on origin
//   - `gh` authenticated (for GitHub access)
//   - npm trust mappings configured per package (one-time, browser):
//     npmjs.com package Settings -> Trusted Publisher -> get-brickkit/brick

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  publishedPackages,
  releaseVersion,
  repositoryUrl,
} from "./published-packages.ts";

const ROOT = join(import.meta.dir, "..");
const DRY = process.argv.includes("--dry-run");
const PREPARE = process.argv.includes("--prepare");
const args = process.argv
  .slice(2)
  .filter((a) => a !== "--dry-run" && a !== "--prepare");
const [bump = "patch"] = args;

// Resolve binaries from fixed, unwriteable system directories instead of
// trusting the caller's PATH (Sonar typescript:S4036). A release runs
// `git push` and publishes to npm, so a hijacked PATH entry could swap
// the binary that actually runs.
const SAFE_BIN_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];
function resolveBin(name: string): string {
  for (const dir of SAFE_BIN_DIRS) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `release: error: binary "${name}" not found in ${SAFE_BIN_DIRS.join(":")} — install it there first`,
  );
}
const GIT = resolveBin("git");

function sh(cmd: string[], cwd = ROOT): string {
  const [bin, ...rest] = cmd;
  // git and gh talk to GitHub, so resolve them to absolute paths above.
  // Other tools (e.g. bun, often under ~/.bun/bin) keep PATH lookup.
  const resolved = bin === "git" ? GIT : bin === "gh" ? resolveBin("gh") : bin;
  return execFileSync(resolved, rest, {
    cwd,
    encoding: "utf-8",
  }).trim();
}

function fail(msg: string): never {
  console.error(`release: error: ${msg}`);
  process.exit(1);
}

function bumpVersion(v: string, kind: string): string {
  if (kind === "beta") {
    const prerelease = /^(\d+\.\d+\.\d+)-beta\.(\d+)$/.exec(v);
    if (prerelease) return `${prerelease[1]}-beta.${Number(prerelease[2]) + 1}`;
    return `${bumpVersion(v, "minor")}-beta.0`;
  }
  const promoted = /^(\d+\.\d+\.\d+)-beta\.\d+$/.exec(v);
  if (promoted) return promoted[1];
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) fail(`non-semver version "${v}" — bump it by hand`);
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "major") {
    major++;
    minor = 0;
    patch = 0;
  } else if (kind === "minor") {
    minor++;
    patch = 0;
  } else {
    patch++;
  }
  return `${major}.${minor}.${patch}`;
}

if (
  args.length > 1 ||
  (DRY && PREPARE) ||
  !["patch", "minor", "major", "beta"].includes(bump)
)
  fail("usage: bun run release [patch|minor|major|beta] [--dry-run|--prepare]");

const dirty = sh(["git", "status", "--porcelain"])
  .split("\n")
  .filter((l) => l && !l.startsWith("??"));
if (dirty.length)
  fail(`tracked tree not clean:\n${dirty.join("\n")}\ncommit or stash first`);
const branch = sh(["git", "branch", "--show-current"]);
const releaseBranch = bump === "beta" ? "beta" : "main";
if (branch !== releaseBranch) fail(`must run on ${releaseBranch}`);
execFileSync(GIT, ["fetch", "origin"], {
  cwd: ROOT,
  stdio: DRY ? "ignore" : "inherit",
});
const divergence = sh([
  "git",
  "rev-list",
  "--left-right",
  "--count",
  `HEAD...origin/${releaseBranch}`,
]);
if (!DRY && divergence !== "0\t0")
  fail(
    `local ${releaseBranch} differs from origin/${releaseBranch} — synchronize it first`,
  );
if (!PREPARE) {
  const GH = resolveBin("gh");
  try {
    execFileSync(GH, ["auth", "status"], { cwd: ROOT, stdio: "ignore" });
  } catch {
    fail("gh is not authenticated — run `gh auth login` first");
  }
}

const releases = publishedPackages(ROOT);
let current: string;
try {
  current = releaseVersion(releases);
} catch (error) {
  fail((error as Error).message);
}
const version = bumpVersion(current, bump);
const tag = `v${version}`;
// Point every dependency on a sibling package at the new version, keeping its
// range: `^x` stays a caret, an exact pin (bullmq-world -> redis-world) stays exact.
// `workspace:` ranges are left for the package manager to rewrite.
const names = new Set(releases.map((r) => r.data.name));
for (const { data } of releases)
  for (const field of ["dependencies", "peerDependencies", "devDependencies"])
    for (const dep of Object.keys(data[field] ?? {}))
      if (names.has(dep) && !data[field][dep].startsWith("workspace:"))
        data[field][dep] = data[field][dep].startsWith("^")
          ? `^${version}`
          : version;
const exists = sh(["git", "ls-remote", "origin", `refs/tags/${tag}`]);
if (exists) fail(`tag ${tag} already exists on origin`);

console.log("releasing:");
for (const r of releases)
  console.log(
    `  ${r.data.name}  ${r.data.version} -> ${version}  (tag ${tag})`,
  );
if (DRY) {
  console.log("dry-run only — no changes made");
  process.exit(0);
}

// Local releases use the same post-publication commit gate as manual dispatches.
if (!PREPARE) {
  const result = sh([
    "gh",
    "workflow",
    "run",
    "publish-npm.yml",
    "--repo",
    new URL(repositoryUrl(ROOT)).pathname.slice(1),
    "--ref",
    releaseBranch,
    "-f",
    `bump=${bump}`,
    "-f",
    "dry_run=false",
  ]);
  console.log(result || "Release workflow queued.");
  process.exit(0);
}

// CI stages manifests for validation; this mode never creates release refs.
for (const r of releases) {
  r.data.version = version;
  writeFileSync(r.file, JSON.stringify(r.data, null, 2) + "\n");
}
sh(["bun", "install"]);
console.log(`prepared ${tag}; release refs and registry are unchanged`);
