#!/usr/bin/env bun
// Dispatch a release through publish-npm.yml. The workflow validates and
// publishes every package before creating the release commit and tag.
//
//   bun run release [patch|minor|major|beta] [--dry-run|--prepare]
// --prepare stages manifests and the lockfile for CI validation without shipping.
// A stable bump from X.Y.Z-beta.N promotes it to X.Y.Z.
// All packages use the same version and ship under one v<version> tag.
// The Rust crate (sdk/rust/brick/Cargo.toml) shares it, and the Go module
// (sdk/go, which has no version in go.mod) is tagged sdk/go/v<version>.
//
// Prerequisites (checked up front):
//   - clean tracked tree, on main (stable) or beta, in sync with origin
//   - target tag(s) don't already exist on origin
//   - `gh` authenticated (for GitHub access)
//   - npm trust mappings configured per package (one-time, browser):
//     npmjs.com package Settings -> Trusted Publisher -> get-brickkit/brick

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore and try the next directory
    }
  }
  throw new Error(
    `release: error: binary "${name}" not found in ${SAFE_BIN_DIRS.join(":")} — install it there first`,
  );
}
const GIT = resolveBin("git");

const CORE_PKG = join(ROOT, "packages/core/package.json");
const CLI_PKG = join(ROOT, "packages/cli/package.json");
const CRUD_PKG = join(ROOT, "packages/crud/package.json");
const BULLMQ_WORLD_PKG = join(ROOT, "packages/bullmq-world/package.json");
// redis-world depends on no other @brickkit package, so only its version is bumped.
const REDIS_WORLD_PKG = join(ROOT, "packages/redis-world/package.json");
// The brickkit crate, and the lockfiles that record its version.
const CRATE_TOML = join(ROOT, "sdk/rust/brick/Cargo.toml");
const CARGO_LOCKS = [
  join(ROOT, "sdk/rust/Cargo.lock"),
  join(ROOT, "examples/pages/services/bench-rust/Cargo.lock"),
];
const CRATE_VERSION = /^version = "([^"]+)"/m;
const LOCKED_CRATE = /(\nname = "brickkit"\nversion = ")[^"]+"/;

function sh(cmd: string[], cwd = ROOT): string {
  if (DRY) {
    console.log(`  [dry-run] $ ${cmd.join(" ")}`);
    return "";
  }
  const [bin, ...rest] = cmd;
  // git/gh run push/fetch, so resolve them to absolute paths above.
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

function readJson(p: string): any {
  return JSON.parse(readFileSync(p, "utf-8"));
}

function writeJson(p: string, data: any): void {
  if (DRY) {
    console.log(`  [dry-run] write ${p}`);
    return;
  }
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
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
  } else if (kind === "patch") {
    patch++;
  } else fail(`bump must be patch|minor|major, got "${kind}"`);
  return `${major}.${minor}.${patch}`;
}

if (
  args.length > 1 ||
  (DRY && PREPARE) ||
  !["patch", "minor", "major", "beta"].includes(bump)
)
  fail("usage: bun run release [patch|minor|major|beta] [--dry-run|--prepare]");

// --- preconditions ---
const dirty = execFileSync(GIT, ["status", "--porcelain"], {
  cwd: ROOT,
  encoding: "utf-8",
})
  .split("\n")
  .filter((l) => l && !l.startsWith("??"));
if (dirty.length)
  fail(`tracked tree not clean:\n${dirty.join("\n")}\ncommit or stash first`);
const branch = execFileSync(GIT, ["branch", "--show-current"], {
  cwd: ROOT,
  encoding: "utf-8",
}).trim();
const releaseBranch = bump === "beta" ? "beta" : "main";
if (branch !== releaseBranch) fail(`must run on ${releaseBranch}`);
execFileSync(GIT, ["fetch", "origin"], {
  cwd: ROOT,
  stdio: DRY ? "ignore" : "inherit",
});
const divergence = execFileSync(
  GIT,
  ["rev-list", "--left-right", "--count", `HEAD...origin/${releaseBranch}`],
  {
    cwd: ROOT,
    encoding: "utf-8",
  },
).trim();
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

// --- compute new versions ---
const coreJson = readJson(CORE_PKG);
const cliJson = readJson(CLI_PKG);
const crudJson = readJson(CRUD_PKG);
const bullmqWorldJson = readJson(BULLMQ_WORLD_PKG);
const releases = [
  { file: CORE_PKG, data: coreJson },
  { file: CLI_PKG, data: cliJson },
  { file: CRUD_PKG, data: crudJson },
  { file: BULLMQ_WORLD_PKG, data: bullmqWorldJson },
  { file: REDIS_WORLD_PKG, data: readJson(REDIS_WORLD_PKG) },
];
if (releases.some((r) => r.data.version !== coreJson.version))
  fail("core, cli, crud and world versions must match");
const crateToml = readFileSync(CRATE_TOML, "utf-8");
if (CRATE_VERSION.exec(crateToml)?.[1] !== coreJson.version)
  fail(`${CRATE_TOML} version must match the packages (${coreJson.version})`);
const version = bumpVersion(coreJson.version, bump);
const tag = `v${version}`;
const goTag = `sdk/go/${tag}`;
cliJson.dependencies["@brickkit/core"] = `^${version}`;
crudJson.peerDependencies["@brickkit/core"] = `^${version}`;
// bullmq-world imports redis-world/internal, which changes in lockstep: pin it exactly.
bullmqWorldJson.dependencies["@brickkit/redis-world"] = version;
const exists = execFileSync(GIT, ["ls-remote", "origin", `refs/tags/${tag}`], {
  cwd: ROOT,
  encoding: "utf-8",
}).trim();
if (exists) fail(`tag ${tag} already exists on origin`);
const goExists = execFileSync(
  GIT,
  ["ls-remote", "origin", `refs/tags/${goTag}`],
  { cwd: ROOT, encoding: "utf-8" },
).trim();
if (goExists) fail(`tag ${goTag} already exists on origin`);

console.log("releasing:");
for (const r of releases)
  console.log(
    `  ${r.data.name}  ${r.data.version} -> ${version}  (tag ${tag})`,
  );
console.log(`  brickkit (crate)  ${coreJson.version} -> ${version}`);
console.log(`  sdk/go (module)  tag ${goTag}`);
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
    "get-brickkit/brick",
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
  writeJson(r.file, r.data);
}
writeFileSync(
  CRATE_TOML,
  crateToml.replace(CRATE_VERSION, `version = "${version}"`),
);
for (const lock of CARGO_LOCKS)
  if (existsSync(lock))
    writeFileSync(
      lock,
      readFileSync(lock, "utf-8").replace(LOCKED_CRATE, `$1${version}"`),
    );
sh(["bun", "install"]);
console.log(`prepared ${tag}; release refs and registry are unchanged`);
