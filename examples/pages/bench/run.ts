// Benchmark the same three APIs (echo, validate, db) in TS, Go and Rust.
//
// Starts the pages app in production mode (`vite build`, then the built server
// on Bun) with release builds of the Go and Rust services, warms up, then calls
// every API 200 times sequentially from the client side, browser → Bun:
// fetch("http://localhost:<port>/api/<service>/<action>"). The Go and Rust APIs
// are also called 200 times directly on their own ports, so the gateway's cost
// shows separately. Writes bench/results.json.
//
//   bun run --cwd examples/pages bench            # from the repository root
//   BENCH_SKIP_BUILD=1 bun bench/run.ts           # reuse the last builds
//
// Uses its own database (BENCH_DATABASE_URL, default drafton_bench), created
// and migrated from drizzle/ on first run.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpus, arch, platform, release, totalmem } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../scripts/migrations";
import { internalToken, startRemoteServices } from "@brickkit/core";
import postgres from "postgres";

import { benchGo, benchRust } from "../src/api/services/bench/service";

const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 200);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 50);
const root = join(import.meta.dir, "..");
const databaseUrl =
  process.env.BENCH_DATABASE_URL ?? "postgresql://localhost:5432/drafton_bench";

type Language = "ts" | "go" | "rust";
type Api = "echo" | "validate" | "db";
type Path = "gateway" | "direct";

const SERVICES: Record<Language, string> = {
  ts: "bench",
  go: "bench-go",
  rust: "bench-rust",
};
const APIS: Api[] = ["echo", "validate", "db"];
const ECHO = {
  message: "hello brick",
  n: 42,
  tags: ["a", "b", "c"],
  nested: { ok: true, list: [1, 2, 3] },
};
const inputOf = (api: Api, i: number): unknown =>
  api === "echo"
    ? ECHO
    : api === "validate"
      ? { name: "alice", age: 30, role: "editor" }
      : { id: (i % 100) + 1 };

// Production builds and runs need a signing secret; any value will do here.
const AUTH_SECRET = randomBytes(32).toString("hex");

function sh(command: string, cwd = root) {
  const result = spawnSync("/bin/sh", ["-c", command], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, AUTH_SECRET },
  });
  if (result.status !== 0) throw new Error(`failed: ${command}`);
}

function version(command: string): string {
  const result = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
  });
  return (result.stdout || result.stderr || "").trim().split("\n")[0] ?? "";
}

async function waitFor(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await fetch(url).then(
        (r) => r.ok,
        () => false,
      )
    )
      return;
    await Bun.sleep(100);
  }
  throw new Error(`${url} did not come up`);
}

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank percentile.
  const pct = (p: number) =>
    sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    p50: round(pct(50)),
    p90: round(pct(90)),
    p99: round(pct(99)),
    mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    min: round(sorted[0]!),
    max: round(sorted.at(-1)!),
  };
};

// 1. Database and builds.
await applyMigrations(databaseUrl);
if (!process.env.BENCH_SKIP_BUILD) {
  sh("bun run --cwd ../.. build");
  sh("bun run build");
  for (const remote of [benchGo, benchRust])
    sh(remote.options.build!.command, join(root, remote.options.dir));
}

// 2. Start the Go and Rust services (release builds), then the app on Bun.
const probe = Bun.serve({ port: 0, fetch: () => new Response() });
const port = probe.port!;
probe.stop(true);
const appUrl = `http://localhost:${port}`;
const children = await startRemoteServices([benchGo, benchRust], {
  mode: "start",
  appUrl: `http://127.0.0.1:${port}`,
  services: ["pages", "bench"],
  cwd: root,
  env: { DATABASE_URL: databaseUrl },
});
const app = spawn("bun", [".output/server/index.mjs"], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    BASE_URL: appUrl,
    DATABASE_URL: databaseUrl,
    AUTH_SECRET,
  },
});
// The built server closes gracefully but its pools keep it alive: kill it after 6s.
const stop = async () => {
  if (app.exitCode === null && app.signalCode === null) {
    const exited = new Promise((done) => app.once("exit", done));
    app.kill("SIGTERM");
    const timer = setTimeout(() => app.kill("SIGKILL"), 6000);
    await exited;
    clearTimeout(timer);
  }
  await children.stop();
};
process.on("SIGINT", () => void stop().then(() => process.exit(130)));

try {
  await waitFor(`${appUrl}/_health`);
  await children.ready();

  const targets: { language: Language; api: Api; path: Path; url: string }[] =
    [];
  for (const language of ["ts", "go", "rust"] as Language[])
    for (const api of APIS) {
      targets.push({
        language,
        api,
        path: "gateway",
        url: `${appUrl}/api/${SERVICES[language]}/${api}`,
      });
      if (language !== "ts")
        targets.push({
          language,
          api,
          path: "direct",
          url: `${children.urls[language === "go" ? "benchGo" : "benchRust"]}/${api}`,
        });
    }

  const call = async (target: (typeof targets)[number], i: number) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    // A direct call skips Bun, so it brings the token Bun would add.
    if (target.path === "direct") headers["x-brick-internal"] = internalToken();
    const started = performance.now();
    const response = await fetch(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(inputOf(target.api, i)),
    });
    await response.arrayBuffer();
    return { ms: performance.now() - started, status: response.status };
  };

  // 3. Warm up every target, and check each answers 200.
  for (const target of targets)
    for (let i = 0; i < WARMUP; i++) {
      const { status } = await call(target, i);
      if (status !== 200)
        throw new Error(`${target.url} answered ${status} during warmup`);
    }

  // 4. Measure: each target 200 times, one request at a time.
  const requests: {
    language: Language;
    api: Api;
    path: Path;
    i: number;
    ms: number;
    status: number;
  }[] = [];
  for (const target of targets)
    for (let i = 0; i < ITERATIONS; i++) {
      const { ms, status } = await call(target, i);
      requests.push({
        language: target.language,
        api: target.api,
        path: target.path,
        i,
        ms: Math.round(ms * 1000) / 1000,
        status,
      });
    }

  const summary = targets.map(({ language, api, path }) => {
    const rows = requests.filter(
      (r) => r.language === language && r.api === api && r.path === path,
    );
    return {
      language,
      api,
      path,
      n: rows.length,
      errors: rows.filter((r) => r.status !== 200).length,
      ...stats(rows.map((r) => r.ms)),
    };
  });

  const sql = postgres(databaseUrl, { max: 1 });
  const [{ version: pg }] = await sql`SELECT version()`;
  await sql.end();
  const results = {
    date: new Date().toISOString(),
    config: {
      iterations: ITERATIONS,
      warmup: WARMUP,
      sequential: true,
      client: "Bun fetch (keep-alive) from the bench process",
      app: "vite build (Nitro node-server output) run on Bun, NODE_ENV=production",
      pools: "10 connections in TS (postgres-js), Go (pgxpool) and Rust (sqlx)",
      units: "milliseconds, request sent to response body read",
    },
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 2 ** 30),
    },
    versions: {
      bun: Bun.version,
      go: version("go version"),
      rustc: version("rustc --version"),
      postgres: pg as string,
      brick: (
        await Bun.file(join(root, "../../packages/core/package.json")).json()
      ).version,
    },
    summary,
    requests,
  };
  await Bun.write(
    join(import.meta.dir, "results.json"),
    `${JSON.stringify(results, null, 2)}\n`,
  );
  console.table(
    summary.map(
      ({ language, api, path, p50, p90, p99, mean, min, max, errors }) => ({
        language,
        api,
        path,
        p50,
        p90,
        p99,
        mean,
        min,
        max,
        errors,
      }),
    ),
  );
  console.log(`Wrote ${join(import.meta.dir, "results.json")}`);
} finally {
  await stop();
}
