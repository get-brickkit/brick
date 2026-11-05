import { describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runCli, tempProject } from "./helpers";

const entry = join(import.meta.dir, "fixtures/client-app.ts");
const pkg = await Bun.file(resolve(import.meta.dir, "../package.json")).json();

const run = (
  cwd: string,
  args: string[],
  env?: Record<string, string | undefined>,
) => runCli(args, { cwd, env });

describe("brick CLI (commander)", () => {
  it("shows top-level help with commands, port resolution, and examples", async () => {
    const root = await tempProject("cli-test");
    try {
      const result = await run(root, ["--help"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("brick");
      expect(result.stdout).toContain("dev");
      expect(result.stdout).toContain("build");
      expect(result.stdout).toContain("Port Resolution");
      expect(result.stdout).toContain("brick dev app.ts --port 5000");
      expect(result.stdout).toContain("CLI --port");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows version matching package.json", async () => {
    const root = await tempProject("cli-test");
    try {
      const result = await run(root, ["--version"]);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toContain(pkg.version);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shows per-command help for dev/start/build/gen/info", async () => {
    const root = await tempProject("cli-test");
    try {
      for (const args of [
        ["dev", "--help"],
        ["start", "--help"],
        ["worker", "--help"],
        ["build", "--help"],
        ["gen", "--help"],
        ["gen", "openapi", "--help"],
        ["gen", "client", "--help"],
        ["info", "--help"],
      ]) {
        const result = await run(root, args);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain("Usage:");
      }
      const buildHelp = await run(root, ["build", "--help"]);
      expect(buildHelp.stdout).toContain("--outdir");
      expect(buildHelp.stdout).toContain("--no-aot");
      expect(buildHelp.stdout).toContain("--port");
      const devHelp = await run(root, ["dev", "--help"]);
      expect(devHelp.stdout).toContain("--port");
      expect(devHelp.stdout).toContain("Port Resolution");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates --port: rejects non-integer, out-of-range, and missing values", async () => {
    const root = await tempProject("cli-test");
    try {
      for (const port of ["abc", "0", "-1", "65536", "99999", "3000.5", ""]) {
        const result = await run(root, ["dev", entry, "--port", port]);
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/invalid|port/i);
      }
      const missing = await run(root, ["dev", entry, "--port"]);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("argument missing");
      const buildBad = await run(root, ["build", entry, "--port", "abc"]);
      expect(buildBad.code).toBe(1);
      expect(buildBad.stderr).toMatch(/invalid|port/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates PORT env: rejects PORT=0 and non-numeric env", async () => {
    const root = await tempProject("cli-test");
    try {
      // Use info command? No, info doesn't use port. Use dev with invalid env;
      // dev fails fast before listening when PORT is invalid.
      const zero = await run(root, ["dev"], { PORT: "0" });
      expect(zero.code).toBe(1);
      expect(zero.stderr + zero.stdout).toMatch(/invalid|port/i);
      const bad = await run(root, ["dev"], { PORT: "not-a-port" });
      expect(bad.code).toBe(1);
      expect(bad.stderr + bad.stdout).toMatch(/invalid|port/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing required entry for build/gen/info", async () => {
    const root = await tempProject("cli-test");
    try {
      for (const args of [
        ["build"],
        ["gen", "openapi"],
        ["gen", "client"],
        ["info"],
      ]) {
        const result = await run(root, args);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("missing required argument");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown options with clear errors", async () => {
    const root = await tempProject("cli-test");
    try {
      const result = await run(root, ["gen", "client", entry, "--wat"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("unknown option");
      const buildUnknown = await run(root, ["build", entry, "--wat"]);
      expect(buildUnknown.code).toBe(1);
      expect(buildUnknown.stderr).toContain("unknown option");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects flag-like --output values (e.g. --output --wat)", async () => {
    const root = await tempProject("cli-test");
    try {
      const result = await run(root, [
        "gen",
        "client",
        entry,
        "--output",
        "--wat",
      ]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Usage: brick gen client");
      const openapi = await run(root, [
        "gen",
        "openapi",
        entry,
        "--output",
        "--wat",
      ]);
      expect(openapi.code).toBe(1);
      expect(openapi.stderr).toContain("Usage: brick gen openapi");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports unknown generators with available list", async () => {
    const root = await tempProject("cli-test");
    try {
      for (const args of [["gen"], ["gen", "foo"]]) {
        const result = await run(root, args);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain("Unknown generator");
        expect(result.stderr).toContain("openapi");
        expect(result.stderr).toContain("client");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects deprecated build flags and conflicting flags with one line", async () => {
    const root = await tempProject("cli-test");
    try {
      const prefix = await run(root, ["build", entry, "--prefix", "/api"]);
      expect(prefix.code).toBe(1);
      expect(prefix.stderr).toContain("configure prefix");
      const logging = await run(root, ["build", entry, "--no-request-logging"]);
      expect(logging.code).toBe(1);
      expect(logging.stderr).toContain("configure prefix");
      // A user's mistake prints one line, not a stack.
      expect(logging.stderr).not.toContain("Fatal error");
      const conflict = await run(root, [
        "dev",
        entry,
        "--no-dashboard",
        "--history-days",
        "3",
      ]);
      expect(conflict.code).toBe(1);
      expect(conflict.stderr.trim()).toBe(
        "Brick: --history-days cannot be combined with --no-dashboard.",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps services alias working like info", async () => {
    const root = await tempProject("cli-test");
    try {
      const result = await run(root, ["services", entry]);
      expect(result.code).toBe(0);
      const arch = JSON.parse(result.stdout);
      expect(arch.version).toBe("1.0.0");
      expect(arch.services.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
