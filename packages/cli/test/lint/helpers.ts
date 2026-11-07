import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PROJECT_DEFAULTS } from "../../src/config";
import { runFileRules, type LintMessage } from "../../src/lint/run";

export interface Case {
  file: string;
  code: string;
  /** How many reports the rule makes on this file (0 for valid code). */
  errors: number;
  /** The file after `--fix`, for fixable rules. */
  output?: string;
}

/** Lint each case as its own file in one project, with only `rule` on. */
export function lintCases(
  rule: string,
  cases: Case[],
  options?: { ruleOptions?: unknown },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "brick-lint-test-")));
  try {
    for (const { file, code } of cases) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), code);
    }
    const run = (fix?: boolean): LintMessage[] =>
      runFileRules({
        root,
        rules: {
          [`brick/${rule}`]: options?.ruleOptions
            ? (["error", options.ruleOptions] as never)
            : "error",
        },
        settings: { root, ...PROJECT_DEFAULTS },
        fix,
      });
    const messages = run();
    const outputs = cases.some((c) => c.output !== undefined)
      ? (run(true),
        Object.fromEntries(
          cases.map((c) => [c.file, readFileSync(join(root, c.file), "utf8")]),
        ))
      : {};
    return {
      messages,
      count: (file: string) => messages.filter((m) => m.file === file).length,
      output: (file: string) => outputs[file],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
