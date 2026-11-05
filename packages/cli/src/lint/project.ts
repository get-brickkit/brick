import { relative, sep } from "node:path";
import type { BrickSettings } from "./ast";
import { resolveProject, type BrickConfig, type LoadedConfig } from "../config";

export interface Project {
  /** Folder of brick.config.ts, or the working directory without one. */
  root: string;
  file?: string;
  config: BrickConfig;
  settings: BrickSettings;
}

/** The lint settings of a project: its paths, relative to its root. */
export function settingsOf(project: LoadedConfig): BrickSettings {
  const from = (path: string) =>
    relative(project.root, path).split(sep).join("/") || ".";
  return {
    root: project.root,
    services: from(project.services),
    entry: from(project.entry),
    generated: from(project.generated),
    web: "web",
  };
}

/** Read and validate the nearest brick.config.ts (or `config`), with Brick's default paths. */
export async function readProject(
  options: { cwd?: string; config?: string } = {},
): Promise<Project> {
  const project = await resolveProject(options.config, options.cwd);
  return {
    root: project.root,
    file: project.file,
    config: project.config,
    settings: settingsOf(project),
  };
}
