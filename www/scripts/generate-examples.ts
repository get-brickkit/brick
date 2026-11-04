// Builds the examples catalog data at build time.
//
// For every `examples/*/brick.example.json` this writes
//   src/generated/examples/<slug>.json  metadata + architecture (eagerly bundled)
//   src/generated/sources/<slug>.json   source files (lazily loaded by the browser)
// The architecture comes from loading the example's entry in a subprocess, the
// same data `brick info` prints, so the site never runs example code at request time.
import { existsSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wwwRoot = resolve(here, "..");
const repoRoot = resolve(wwwRoot, "..");
const examplesDir = join(repoRoot, "examples");
const outDir = join(wwwRoot, "src/generated");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".output",
  ".nitro",
  ".tanstack",
  ".vercel",
  "dist",
  "build",
  "meta", // drizzle snapshots
  "target", // Cargo
  "bin", // Go binaries
]);
const SKIP_FILES = new Set([
  "bun.lock",
  "package-lock.json",
  "brick.example.json",
]);
const LANGS: Record<string, string> = {
  ".ts": "ts",
  ".tsx": "tsx",
  ".mts": "ts",
  ".js": "js",
  ".mjs": "js",
  ".json": "json",
  ".md": "md",
  ".css": "css",
  ".sql": "sql",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".html": "html",
  ".sh": "bash",
  ".go": "go",
  ".rs": "rust",
};
const MAX_FILE_BYTES = 40_000;

interface ExampleMeta {
  title: string;
  description: string;
  tags?: string[];
  features?: string[];
  entry: string;
  run?: string[];
  runNote?: string;
  order?: number;
}

async function walk(dir: string, root: string, out: string[] = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name))
          await walk(join(dir, entry.name), root, out);
      } else if (
        !SKIP_FILES.has(entry.name) &&
        !entry.name.endsWith(".gen.ts")
      ) {
        out.push(relative(root, join(dir, entry.name)));
      }
    }),
  );
  return out;
}

async function collectSources(dir: string) {
  const paths = (await walk(dir, dir)).sort((a, b) => a.localeCompare(b));
  const files = await Promise.all(
    paths.map(async (path) => {
      const lang = LANGS[extname(path)];
      if (!lang || path.startsWith(".env")) return undefined;
      if ((await stat(join(dir, path))).size > MAX_FILE_BYTES) return undefined;
      return { path, lang, code: await readFile(join(dir, path), "utf8") };
    }),
  );
  return files.filter((file) => file !== undefined);
}

function loadArchitecture(dir: string, entry: string) {
  const result = Bun.spawnSync(
    ["bun", join(here, "example-architecture.ts"), entry],
    {
      cwd: dir,
      // The probe only reads the architecture, so examples must not need
      // production-only secrets here: they validate env strictly when
      // NODE_ENV is production.
      env: { ...process.env, NODE_ENV: "development" },
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`${dir}: ${entry} failed\n${result.stderr.toString()}`);
  }
  // Examples may log on import; the JSON document is the last line.
  const lines = result.stdout.toString().trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!);
}

// The probe loads the built workspace packages (package exports point at dist).
if (!existsSync(join(repoRoot, "packages/core/dist/index.js"))) {
  console.log("[examples] building workspace packages");
  const build = Bun.spawnSync(["bun", "run", "build"], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (build.exitCode !== 0) throw new Error("workspace build failed");
}

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, "examples"), { recursive: true });
await mkdir(join(outDir, "sources"), { recursive: true });

async function processExample(slug: string) {
  const dir = join(examplesDir, slug);
  const metaPath = join(dir, "brick.example.json");
  if (!existsSync(metaPath)) return false;
  const meta: ExampleMeta = JSON.parse(await readFile(metaPath, "utf8"));
  for (const key of ["title", "description", "entry"] as const) {
    if (!meta[key]) throw new Error(`${metaPath}: "${key}" is required`);
  }
  const architecture = loadArchitecture(dir, meta.entry);
  const sources = await collectSources(dir);
  const readme = sources.find((f) => f.path === "README.md");
  await writeFile(
    join(outDir, "examples", `${slug}.json`),
    JSON.stringify({
      slug,
      ...meta,
      tags: meta.tags ?? [],
      features: meta.features ?? [],
      run: meta.run ?? [],
      readme: readme?.code,
      fileCount: sources.length,
      architecture,
    }),
  );
  await writeFile(
    join(outDir, "sources", `${slug}.json`),
    JSON.stringify(sources),
  );
  console.log(`[examples] ${slug}: ${sources.length} files`);
  return true;
}

const slugs = (await readdir(examplesDir)).sort((a, b) => a.localeCompare(b));
const processed = await Promise.all(slugs.map((slug) => processExample(slug)));
if (!processed.some(Boolean))
  throw new Error("no examples/*/brick.example.json found");
