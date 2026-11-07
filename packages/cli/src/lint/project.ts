import { relative, sep } from "node:path";
import type { BrickSettings } from "./ast";
import { ConfigError, type LoadedConfig } from "../config";
import { fileRules, resolveRules, type Severity } from "./presets";

/** Rules, settings and ignores of a project, shared by brick lint and both linters. */
export function projectRules(project: LoadedConfig) {
  const lint = project.config.lint ?? {};
  let resolved: Record<string, Severity>;
  try {
    resolved = resolveRules(lint.presets, lint.rules);
  } catch (error) {
    throw new ConfigError(
      `brick.config.ts: lint.rules: ${(error as Error).message}`,
    );
  }
  const from = (path: string) =>
    relative(project.root, path).split(sep).join("/") || ".";
  const settings: BrickSettings = {
    root: project.root,
    services: from(project.services),
    entry: from(project.entry),
    generated: from(project.generated),
  };
  return {
    resolved,
    rules: fileRules(resolved),
    settings,
    ignore: [...(lint.ignore ?? []), `${settings.generated}/**`],
  };
}
