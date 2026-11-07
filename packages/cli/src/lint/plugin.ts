import {
  fileRules,
  PRESETS,
  resolveRules,
  rules,
  type PresetName,
  type Severity,
} from "./presets";
import { resolveProject } from "../config";
import { projectRules } from "./project";

const FILES = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];

interface FlatConfig {
  name: string;
  files?: string[];
  ignores?: string[];
  plugins: Record<string, unknown>;
  settings?: Record<string, unknown>;
  rules: Record<string, Severity>;
}

/** The ESLint flat-config plugin; oxlint loads the same object through `jsPlugins`. */
export const brick = {
  meta: { name: "brick" },
  rules,
  configs: {} as Record<PresetName, FlatConfig> & {
    /** Presets, rule settings, ignores and paths from brick.config.ts, as an ESLint flat-config array. */
    fromProject: typeof fromProject;
  },
};

for (const name of Object.keys(PRESETS) as PresetName[])
  brick.configs[name] = {
    name: `brick/${name}`,
    plugins: { brick },
    rules: fileRules(resolveRules([name])),
  };

async function fromProject(
  options: { cwd?: string; config?: string } = {},
): Promise<FlatConfig[]> {
  const { rules, settings, ignore } = projectRules(
    await resolveProject(options.config, options.cwd),
  );
  return [
    {
      name: "brick/project",
      files: FILES,
      ignores: ignore,
      plugins: { brick },
      settings: { brick: settings },
      rules,
    },
  ];
}
brick.configs.fromProject = fromProject;
