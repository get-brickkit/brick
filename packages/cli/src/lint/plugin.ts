import {
  fileRules,
  PRESETS,
  resolveRules,
  rules,
  type PresetName,
  type Severity,
} from "./presets";
import { readProject } from "./project";

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

/** Rules, settings and ignores from brick.config.ts, shared by both linters. */
export async function projectRules(options: { cwd?: string; config?: string }) {
  const project = await readProject(options);
  const lint = project.config.lint ?? {};
  return {
    rules: fileRules(resolveRules(lint.presets, lint.rules)),
    settings: { brick: project.settings },
    ignore: [
      ...(lint.ignore ?? []),
      `${project.settings.generated.replace(/\/$/, "")}/**`,
    ],
  };
}

async function fromProject(
  options: { cwd?: string; config?: string } = {},
): Promise<FlatConfig[]> {
  const { rules, settings, ignore } = await projectRules(options);
  return [
    {
      name: "brick/project",
      files: FILES,
      ignores: ignore,
      plugins: { brick },
      settings,
      rules,
    },
  ];
}
brick.configs.fromProject = fromProject;
