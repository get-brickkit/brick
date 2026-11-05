import { existsSync, readFileSync } from "node:fs";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveWorkflowPaths,
  WORKFLOW_BUNDLE,
  type BrickApp,
} from "@brickkit/core";

interface Builders {
  StandaloneBuilder: new (config: Record<string, unknown>) => {
    build(): Promise<void>;
    getInputFiles(): Promise<string[]>;
    findTsConfigPath(): Promise<string | undefined>;
  };
  detectWorkflowPatterns(source: string): {
    hasDirective: boolean;
    hasSerde: boolean;
  };
  applySwcTransform(
    filename: string,
    source: string,
    mode: "step" | "workflow" | "detect" | false,
    absolutePath: string,
    projectRoot: string,
    moduleSpecifierRoot?: string,
  ): Promise<{ code: string }>;
}

type BunPlugin = Parameters<typeof Bun.plugin>[0];

const DIRECTIVE = /["']use (?:step|workflow)["']/;

/**
 * Every project source file. Not the generated bundle: it holds the directives as
 * text inside the SDK's own code and is already built. Not `.cjs` and `.cts`
 * either: Bun drops `module.exports` from a file a plugin loads.
 */
const TRANSFORMED = new RegExp(
  String.raw`^(?!.*(?:node_modules|${WORKFLOW_BUNDLE.dir.replaceAll(".", "\\.")}/)).*\.(?:m?[jt]s|[jt]sx)$`,
);

/** Bun's own loader for each extension: JSX is allowed in `.js` but not in `.mjs`. */
function loaderFor(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (path.endsWith(".tsx")) return "tsx";
  if (/\.m?ts$/.test(path)) return "ts";
  return path.endsWith(".mjs") ? "js" : "jsx";
}

async function loadBuilders(
  root: string,
): Promise<{ builders: Builders; path: string } | undefined> {
  let path: string;
  try {
    path = createRequire(join(root, "package.json")).resolve(
      "@workflow/builders",
    );
  } catch {
    // Not installed: the app uses no workflows. A broken install throws below.
    return undefined;
  }
  return {
    builders: (await import(pathToFileURL(path).href)) as Builders,
    path,
  };
}

/**
 * The plugin that turns `"use workflow"` and `"use step"` files into workflows and
 * steps. `registerWorkflowTransform` installs it for the running process;
 * `brick build` hands it to `Bun.build`.
 *
 * @param root - The project root, where the SDK is installed. Default: the working directory.
 * @returns The plugin, or `undefined` when the Workflow SDK and its builders are not
 * installed in the project.
 */
export async function workflowTransformPlugin(
  root: string = process.cwd(),
): Promise<BunPlugin | undefined> {
  const projectRoot = resolve(root);
  const builders = (await loadBuilders(projectRoot))?.builders;
  if (!builders) return undefined;
  return {
    name: "brick:workflows",
    setup(build) {
      // Not async: Bun treats a module whose load returns a promise as async, and
      // `require()` refuses it. Only a file with a directive waits for SWC.
      build.onLoad({ filter: TRANSFORMED }, (args) => {
        const source = readFileSync(args.path, "utf8");
        if (!DIRECTIVE.test(source))
          return { contents: source, loader: loaderFor(args.path) };
        // SWC strips the types but leaves JSX as it is.
        return builders
          .applySwcTransform(
            relative(projectRoot, args.path).replaceAll("\\", "/"),
            source,
            "step",
            args.path,
            projectRoot,
            projectRoot,
          )
          .then(({ code }) => ({ contents: code, loader: "jsx" as const }));
      });
    },
  };
}

let installed = false;

/**
 * Make files marked `"use workflow"` or `"use step"` load as workflows and steps.
 *
 * A workflow function gets the `workflowId` that `defineListener({ workflow })`
 * needs, and a step registers itself so the runtime can run it in this process.
 * `brick dev`, `brick start` and `brick worker` call it before they load the app.
 * Call it in a script or test before importing the files, with the project root.
 *
 * It does nothing, and returns `false`, when the Workflow SDK and its builders are
 * not installed in the project. Bun allows plugins once per process, so a second
 * call is ignored.
 *
 * @param root - The project root, where the SDK is installed. Default: the working directory.
 * @returns Whether the transform is active.
 */
export async function registerWorkflowTransform(
  root: string = process.cwd(),
): Promise<boolean> {
  if (installed) return true;
  const plugin = await workflowTransformPlugin(root);
  if (!plugin) return false;
  installed = true;
  Bun.plugin(plugin);
  return true;
}

/** The state of the last build, kept beside the bundle it describes. */
const STATE_FILE = ".brick-build.json";
/** Bump it when what the state records changes, so an older state is not trusted. */
const STATE_VERSION = 2;
/**
 * esbuild starts each module of a bundle with a `// <path>` comment, whatever
 * the file (`data.json` too). The other comments it keeps name no file.
 */
const MODULE_COMMENT = /^\/\/ (.+)$/gm;
const LOCKFILES = [
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

/** A file's modification time and size, or an empty string when it is gone. */
type Stamps = Record<string, string>;

interface BuildState {
  key: string;
  /** Every source file the builder looks at. */
  sources: Stamps;
  /** The files the bundle holds or was built with; the bundle is stale when one changes. */
  inputs: Stamps;
}

async function stamps(paths: Iterable<string>): Promise<Stamps> {
  const list = [...paths];
  const all = await Promise.all(
    list.map(async (path) => {
      try {
        const { mtimeMs, size } = await stat(path);
        return `${mtimeMs}:${size}`;
      } catch {
        return "";
      }
    }),
  );
  return Object.fromEntries(list.map((path, index) => [path, all[index]]));
}

function lockfileOf(root: string): string | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    for (const name of LOCKFILES)
      if (existsSync(join(dir, name))) return join(dir, name);
    if (dirname(dir) === dir) return undefined;
  }
}

async function tsconfigInputs(path: string | undefined): Promise<string[]> {
  const files = new Set<string>();
  async function visit(file: string) {
    if (files.has(file)) return;
    files.add(file);
    let config: unknown;
    try {
      config = Bun.JSONC.parse(await readFile(file, "utf8"));
    } catch {
      return;
    }
    if (!config || typeof config !== "object" || !("extends" in config)) return;
    const parents = Array.isArray(config.extends)
      ? config.extends
      : [config.extends];
    const require = createRequire(file);
    for (const parent of parents) {
      if (typeof parent !== "string") continue;
      // esbuild's order, which builds the bundle: a path as written, then with
      // .json; for a package, its tsconfig.json before `${parent}.json`, never `main`.
      const isPath =
        isAbsolute(parent) ||
        parent.startsWith("./") ||
        parent.startsWith("../");
      const candidates = isPath
        ? [parent, `${parent}.json`]
        : [`${parent}/tsconfig.json`, `${parent}.json`, parent];
      let found: string | undefined;
      for (const specifier of candidates) {
        try {
          found = require.resolve(specifier);
        } catch {
          continue;
        }
        if (found.endsWith(".json")) break;
        found = undefined;
      }
      // esbuild still reads the tsconfig.json of a package whose `exports` hides it.
      found ??= isPath
        ? undefined
        : require.resolve
            .paths(parent)
            ?.map((dir) => join(dir, parent, "tsconfig.json"))
            .find(existsSync);
      if (found) await visit(found);
    }
  }
  if (path) await visit(path);
  return [...files];
}

/**
 * Whether the bundle on disk still matches its sources: nothing it was built
 * from has changed, and no other source has come to hold a workflow, a step or a
 * serializable class that the bundle would need to know.
 */
async function isCurrent(
  statePath: string,
  key: string,
  sources: string[],
  builders: Builders,
  outputs: string[],
): Promise<boolean> {
  let state: BuildState;
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as BuildState;
  } catch {
    return false;
  }
  if (state.key !== key || !outputs.every((file) => existsSync(file)))
    return false;
  // A file added or removed can change what an import resolves to.
  if (
    sources.length !== Object.keys(state.sources).length ||
    sources.some((path) => !(path in state.sources))
  )
    return false;
  const inputs = await stamps(Object.keys(state.inputs));
  if (
    Object.entries(state.inputs).some(([path, stamp]) => inputs[path] !== stamp)
  )
    return false;
  const others = sources.filter((path) => !(path in state.inputs));
  const now = await stamps(others);
  const changed = others.filter((path) => now[path] !== state.sources[path]);
  const holds = await Promise.all(
    changed.map(async (path) => {
      const found = builders.detectWorkflowPatterns(
        await readFile(path, "utf8"),
      );
      return found.hasDirective || found.hasSerde;
    }),
  );
  return !holds.some(Boolean);
}

/**
 * Write down what the bundle was built from: the files esbuild bundled (it names
 * each one in a comment), every file with a directive or a serializable class, and
 * the files that decide how imports resolve. Writes nothing when one of them
 * changed while the build ran, because the bundle may then not match what was
 * recorded.
 */
async function recordState(
  statePath: string,
  key: string,
  sources: string[],
  builders: Builders,
  root: string,
  dir: string,
  bundles: string[],
  extra: (string | undefined)[],
  startedAt: number,
): Promise<void> {
  // Stamped before they are read, so an edit made in between shows on the next reload.
  const sourceStamps = await stamps(sources);
  const found = new Set(extra.filter((path) => path !== undefined));
  for (const bundle of bundles) {
    const text = await readFile(bundle, "utf8");
    for (const [, path] of text.matchAll(MODULE_COMMENT)) {
      // The flow bundle imports the steps bundle as a module; both are outputs.
      const file = resolve(root, path);
      if (!file.startsWith(dir)) found.add(file);
    }
  }
  await Promise.all(
    sources.map(async (path) => {
      const patterns = builders.detectWorkflowPatterns(
        await readFile(path, "utf8"),
      );
      if (patterns.hasDirective || patterns.hasSerde) found.add(path);
    }),
  );
  // A comment that names no file, such as `// see foo.ts`, stamps as empty.
  const inputs = Object.fromEntries(
    Object.entries(await stamps(found)).filter(([, stamp]) => stamp),
  );
  if (
    Object.values(inputs).some((stamp) => Number.parseFloat(stamp) >= startedAt)
  )
    return;
  const state: BuildState = { key, sources: sourceStamps, inputs };
  await writeFile(statePath, JSON.stringify(state));
}

/**
 * Build the bundle that runs an app's workflows: `flow.mjs` and `manifest.json`
 * in `<root>/.well-known/workflow/v1`, from every file under `root` marked
 * `"use workflow"` or `"use step"`.
 *
 * `brick dev` and `brick start` call it before events start. Call it in a script
 * or test before starting events.
 *
 * @param options - `root`: the project root. Default: the working directory.
 * `reuse`: keep the bundle of the last build when nothing it was built from has
 * changed, which saves about a second on each reload of `brick dev`. Default:
 * `false`, always build.
 * @returns Whether it built the bundle; `false` when it kept the last one.
 * @throws When `@workflow/builders` is not installed in the project.
 */
export async function buildWorkflows(
  options: { root?: string; reuse?: boolean } = {},
): Promise<boolean> {
  const { root, dir } = resolveWorkflowPaths(options);
  const loaded = await loadBuilders(root);
  if (!loaded)
    throw new Error(
      `Cannot build workflows: @workflow/builders is not installed in ${root}. Add it with: bun add -d @workflow/builders`,
    );
  const { builders } = loaded;
  const output = (name: string) =>
    `./${relative(root, join(dir, name)).replaceAll("\\", "/")}`;
  const builder = new builders.StandaloneBuilder({
    buildTarget: "standalone",
    dirs: ["."],
    workingDir: root,
    stepsBundlePath: output(WORKFLOW_BUNDLE.steps),
    workflowsBundlePath: output(WORKFLOW_BUNDLE.flow),
    webhookBundlePath: output(WORKFLOW_BUNDLE.webhook),
    suppressCreateWorkflowsBundleLogs: true,
    suppressCreateWebhookBundleLogs: true,
    suppressCreateManifestLogs: true,
  });
  const statePath = join(dir, STATE_FILE);
  const bundles = [WORKFLOW_BUNDLE.flow, WORKFLOW_BUNDLE.steps].map((name) =>
    join(dir, name),
  );
  const outputs = [
    ...bundles,
    join(dir, WORKFLOW_BUNDLE.manifest),
    join(dir, WORKFLOW_BUNDLE.webhook),
  ];
  const configs = await tsconfigInputs(await builder.findTsConfigPath());
  const key = JSON.stringify([
    STATE_VERSION,
    loaded.path,
    // Resolve again on reload so a formerly missing parent also invalidates reuse.
    await stamps(configs),
    // The builder reads these too, and writes a different bundle for each.
    ...[
      "NODE_ENV",
      "WORKFLOW_DISCOVER_NODE_MODULES",
      "WORKFLOW_SOURCEMAP",
      "WORKFLOW_EMIT_SOURCEMAPS_FOR_DEBUGGING",
      "WORKFLOW_PUBLIC_MANIFEST",
    ].map((name) => process.env[name] ?? ""),
  ]);
  const sources = await builder.getInputFiles();
  if (
    options.reuse &&
    (await isCurrent(statePath, key, sources, builders, outputs))
  )
    return false;
  // A build that fails halfway leaves outputs the old state no longer describes.
  await rm(statePath, { force: true });
  const startedAt = Date.now();
  await builder.build();
  try {
    await recordState(
      statePath,
      key,
      sources,
      builders,
      root,
      dir,
      bundles,
      [join(root, "package.json"), lockfileOf(root), ...configs],
      startedAt,
    );
  } catch {
    // Without a state the next reload builds again, which is only slower.
  }
  return true;
}

/**
 * Build the workflow bundle an app needs, if it has workflow listeners.
 *
 * @param app - The loaded app.
 * @param options - `reuse`: keep the last bundle when its sources have not changed.
 * @returns Whether the app has a bundle, built now or kept from the last build.
 */
export async function buildAppWorkflows(
  app: BrickApp,
  options: { reuse?: boolean } = {},
): Promise<boolean> {
  const target = app.events?.workflows;
  if (!target) return false;
  const started = performance.now();
  const built = await buildWorkflows({
    root: target.root,
    reuse: options.reuse,
  });
  if (built)
    console.log(
      `[Brick-TS] Built workflows in ${Math.round(performance.now() - started)}ms`,
    );
  return true;
}
