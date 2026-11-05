import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "../config";
import type { BrickSettings } from "./ast";
import type { Severity } from "./presets";

export interface LintMessage {
  /** Path from the project root. */
  file: string;
  line: number;
  column: number;
  /** `brick/<rule>`. */
  rule: string;
  severity: "error" | "warn";
  message: string;
}

let fromSource: string | undefined;
/** The lint/oxlint entry oxlint loads under Node: the bundle beside this code, or, run from source, a fresh bundle of it. */
function pluginPath() {
  const here = fileURLToPath(import.meta.url);
  if (!here.endsWith(".ts")) return resolve(dirname(here), "lint/oxlint.js");
  if (fromSource) return fromSource;
  // Inside the package, so Node resolves the bundle's imports from here.
  const file = resolve(here, "../../../node_modules/.cache/brick-lint.js");
  // Built beside it, then renamed: another process may be loading it.
  const building = `${file}.${process.pid}`;
  const result = spawnSync(
    process.execPath,
    ["build", resolve(dirname(here), "oxlint.ts"), "--target", "node"].concat([
      "--packages",
      "external",
      "--outfile",
      building,
    ]),
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new Error(
      `Brick: building the lint plugin failed:\n${result.stderr}`,
    );
  renameSync(building, file);
  return (fromSource = file);
}

function oxlintBin(root: string) {
  for (const base of [
    join(root, "package.json"),
    fileURLToPath(import.meta.url),
  ]) {
    try {
      const pkg = createRequire(base).resolve("oxlint/package.json");
      return join(dirname(pkg), "bin/oxlint");
    } catch {
      // not installed there; try the next place
    }
  }
  throw new ConfigError(
    "Brick: brick lint needs oxlint; add it: bun add -d oxlint",
  );
}

/**
 * Run the file rules over a project with oxlint, as `brick lint` does.
 * Only rules set to "error" or "warn" run; `ignore` globs are relative to `root`.
 */
export function runFileRules(options: {
  root: string;
  rules: Record<string, Severity>;
  settings: BrickSettings;
  ignore?: string[];
  fix?: boolean;
}): LintMessage[] {
  const rules = Object.fromEntries(
    Object.entries(options.rules).filter(([, severity]) => severity !== "off"),
  );
  if (Object.keys(rules).length === 0) return [];
  const directory = mkdtempSync(join(tmpdir(), "brick-lint-"));
  try {
    const config = join(directory, "oxlintrc.json");
    writeFileSync(
      config,
      JSON.stringify({
        plugins: [],
        categories: { correctness: "off" },
        jsPlugins: [{ name: "brick", specifier: pluginPath() }],
        settings: { brick: options.settings },
        rules,
      }),
    );
    const result = spawnSync(
      oxlintBin(options.root),
      [
        "-c",
        config,
        "--format",
        "json",
        "--disable-nested-config",
        "--no-error-on-unmatched-pattern",
        ...(options.fix ? ["--fix"] : []),
        ...(options.ignore ?? []).flatMap((pattern) => [
          "--ignore-pattern",
          pattern,
        ]),
        ".",
      ],
      { cwd: options.root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    let report: {
      diagnostics?: {
        message: string;
        code?: string;
        severity: string;
        filename: string;
        labels?: { span: { line: number; column: number } }[];
      }[];
    };
    try {
      report = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `Brick: oxlint failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
      );
    }
    return (report.diagnostics ?? []).map((diagnostic) => ({
      file: diagnostic.filename,
      line: diagnostic.labels?.[0]?.span.line ?? 1,
      column: diagnostic.labels?.[0]?.span.column ?? 1,
      // Parse errors come without a rule code.
      rule: diagnostic.code?.replace(/^brick\((.*)\)$/, "brick/$1") ?? "syntax",
      severity: diagnostic.severity === "error" ? "error" : "warn",
      message: diagnostic.message,
    }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
