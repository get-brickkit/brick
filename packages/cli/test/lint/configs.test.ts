import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromProject } from "../../src/lint/oxlint";
import { brick } from "../../src/lint/plugin";
import { resolveRules } from "../../src/lint/presets";

it("refuses an unknown preset or rule", () => {
  expect(() => resolveRules(["nope" as never])).toThrow(
    'unknown preset "nope"',
  );
  expect(() => resolveRules([], { "brick/nope": "warn" })).toThrow(
    'unknown rule "brick/nope"',
  );
});

it("builds ESLint and oxlint configs from brick.config.ts", async () => {
  const root = mkdtempSync(join(tmpdir(), "brick-lint-config-"));
  try {
    writeFileSync(
      join(root, "brick.config.ts"),
      `export default { services: "app/services", lint: { presets: ["layout"], rules: { "brick/kind-folders": "off" }, ignore: ["legacy/**"] } };\n`,
    );
    const [eslint] = await brick.configs.fromProject({ cwd: root });
    const oxlint = await fromProject({ cwd: root });
    for (const config of [
      {
        rules: eslint!.rules,
        settings: eslint!.settings,
        ignore: eslint!.ignores,
      },
      {
        rules: oxlint.rules,
        settings: oxlint.settings,
        ignore: oxlint.ignorePatterns,
      },
    ]) {
      expect(config.rules["brick/kind-folders"]).toBe("off");
      expect(config.rules["brick/file-suffixes"]).toBe("error");
      // App rules need the loaded app, so only `brick lint` runs them.
      expect(config.rules["brick/unique-names"]).toBeUndefined();
      expect(config.settings).toMatchObject({
        brick: { root, services: "app/services" },
      });
      expect(config.ignore).toContain("legacy/**");
    }
    // Each preset is a ready flat config too.
    expect(brick.configs.recommended.rules["brick/action-schemas"]).toBe(
      "error",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
