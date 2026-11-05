import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigError } from "./config";
import type { ExtensionPart } from "./dashboard-protocol";
import { bundleComponents } from "./dev-docs";

/*
 * The dashboard's extension: one module of the project's own, built with the
 * dashboard's React and UI kit left external (the page's import map hands it
 * the dashboard's copies), and its Tailwind classes compiled against the
 * dashboard's theme.css. Plus the theme, which needs no code at all.
 */

/** Token values for the dashboard's light and dark themes, its radius and fonts. */
export interface DashboardTheme {
  /** Colour tokens in light mode, by name: `{ primary: "oklch(0.55 0.2 260)" }`. */
  light?: Record<string, string>;
  /** Colour tokens in dark mode. */
  dark?: Record<string, string>;
  /** The base corner radius, such as `"0.5rem"`. */
  radius?: string;
  /** CSS font stacks. The page must be able to load the font. */
  fonts?: { sans?: string; mono?: string };
}

/** What `dashboard` accepts wherever the dashboard starts or is built. */
export interface DashboardExtensionOptions {
  /**
   * A module whose default export is `defineDashboard({ ... })`, or the
   * `dashboard` folder `brick build` wrote it to.
   */
  extension?: string;
  theme?: DashboardTheme;
}

/** The colour tokens of `dashboard/theme.css`; a test keeps the two in step. */
export const THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "positive",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "span-request",
  "span-action",
  "span-rpc",
  "span-sql",
  "span-event",
  "span-other",
] as const;

const THEME_KEYS = new Set(["light", "dark", "radius", "fonts"]);
const FONT_KEYS = new Set(["sans", "mono"]);
const TOKENS = new Set<string>(THEME_TOKENS);

/** A value that cannot close the rule it sits in. */
function cssValue(where: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || /[;{}<>\\]/.test(value))
    throw new ConfigError(
      `Brick: dashboard.theme.${where} must be a CSS value without ; { } < > or \\.`,
    );
  return value.trim();
}

/**
 * The stylesheet for a theme, loaded after the dashboard's own; empty when the
 * theme sets nothing. Throws on a token name theme.css does not have.
 */
export function themeCss(theme: DashboardTheme | undefined): string {
  if (!theme) return "";
  for (const key of Object.keys(theme))
    if (!THEME_KEYS.has(key))
      throw new ConfigError(
        `Brick: dashboard.theme has no "${key}". It takes light, dark, radius and fonts.`,
      );
  const rules: string[] = [];
  const root: string[] = [];
  if (theme.radius !== undefined)
    root.push(`--radius: ${cssValue("radius", theme.radius)};`);
  for (const [name, value] of Object.entries(theme.fonts ?? {})) {
    if (!FONT_KEYS.has(name))
      throw new ConfigError(
        `Brick: dashboard.theme.fonts has no "${name}". It takes sans and mono.`,
      );
    root.push(`--font-${name}: ${cssValue(`fonts.${name}`, value)};`);
  }
  if (root.length) rules.push(`:root {\n  ${root.join("\n  ")}\n}`);
  // theme.css sets light on :root and dark on .dark, both on <html>; these
  // selectors win over both, and each applies only in its own mode.
  for (const [mode, selector] of [
    ["light", ":root:not(.dark)"],
    ["dark", ":root.dark"],
  ] as const) {
    const tokens = theme[mode];
    if (!tokens) continue;
    const lines = Object.entries(tokens).map(([name, value]) => {
      if (!TOKENS.has(name))
        throw new ConfigError(
          `Brick: dashboard.theme.${mode} has no token "${name}". Tokens: ${THEME_TOKENS.join(", ")}.`,
        );
      return `--${name}: ${cssValue(`${mode}.${name}`, value)};`;
    });
    if (lines.length) rules.push(`${selector} {\n  ${lines.join("\n  ")}\n}`);
  }
  return rules.length ? `${rules.join("\n")}\n` : "";
}

/** The built React app, next to `src/` in the repo and next to `dist/` when published. */
export function assetsDirectory(): string | undefined {
  for (const relative of ["../dashboard-dist/", "../../dashboard-dist/"]) {
    const directory = fileURLToPath(new URL(relative, import.meta.url));
    if (existsSync(join(directory, "app.js"))) return directory;
  }
  return undefined;
}

export interface BuiltExtension {
  js: string;
  /** The extension's own Tailwind classes; empty when it uses none. */
  css: string;
  /** The `extension-N.js` files `js` lists, by name. */
  parts?: Record<string, string>;
}

let warnedTailwind = false;

/**
 * Tailwind for the classes in the extension's bundle, compiled against the
 * dashboard's theme.css so `bg-primary` and the rest match. Only utilities are
 * emitted: the dashboard's stylesheet already has the base styles and tokens.
 * Tailwind is an optional peer, found from the project first.
 */
async function extensionCss(
  entry: string,
  js: string,
  warn: (message: string) => void,
): Promise<string> {
  let tailwind: string | undefined;
  let main: string | undefined;
  for (const from of [entry, fileURLToPath(import.meta.url)]) {
    try {
      const require = createRequire(from);
      tailwind = require.resolve("tailwindcss/package.json");
      main = require.resolve("tailwindcss");
      break;
    } catch {
      // Not installed there.
    }
  }
  const assets = assetsDirectory();
  const themeFile = assets
    ? join(assets, "theme.css")
    : fileURLToPath(new URL("../dashboard/theme.css", import.meta.url));
  if (!tailwind || !main) {
    if (!warnedTailwind)
      warn(
        "[Brick-TS] tailwindcss is not installed, so the dashboard extension's own Tailwind classes are not compiled. The UI kit is styled either way.",
      );
    warnedTailwind = true;
    return "";
  }
  const root = dirname(tailwind);
  const { compile } = (await import(
    pathToFileURL(main).href
  )) as typeof import("tailwindcss");
  const compiler = await compile(
    `@layer theme, base, components, utilities;
@import "tailwindcss/theme.css" theme(reference inline);
@import "tailwindcss/utilities.css" layer(utilities);
@reference "brick/theme.css";
`,
    {
      base: root,
      async loadStylesheet(id) {
        const path =
          id === "brick/theme.css"
            ? themeFile
            : join(root, id.replace(/^tailwindcss\//, ""));
        return {
          path,
          base: dirname(path),
          content: await readFile(path, "utf8"),
        };
      },
    },
  );
  // Every word in the bundle is a candidate; Tailwind ignores what is not a class.
  const candidates = new Set(js.split(/[\s"'`]+/).filter(Boolean));
  const css = compiler.build([...candidates]);
  return /\{/.test(css) ? css : "";
}

/** Bundle the extension and its styles for the dashboard page. */
export async function buildDashboardExtension(
  entry: string,
  options: { warn?: (message: string) => void } = {},
): Promise<BuiltExtension> {
  const js = await bundleComponents(entry);
  return {
    js,
    css: await extensionCss(
      entry,
      js,
      options.warn ?? ((message) => console.warn(message)),
    ),
  };
}

/**
 * Write the app's extension and its plugins' into `outdir`, where `brick start`
 * can serve them: the app's alone as it is, or with plugins each part apart
 * and `extension.js` loading them, as `brick dev` serves them. Returns false
 * when there is none to write. A plugin's that fails to build throws.
 */
export async function writeDashboardExtension(
  entry: string | undefined,
  plugins: readonly PluginDashboard[],
  outdir: string,
): Promise<boolean> {
  const parts = [
    ...(entry ? [{ name: "app", path: entry, plugin: false }] : []),
    ...[...pluginDashboards(plugins)].map(([path, name]) => ({
      name,
      path,
      plugin: true,
    })),
  ];
  if (!parts.length) return false;
  const built = await Promise.all(
    parts.map((part) =>
      buildDashboardExtension(part.path).catch((error: unknown) => {
        if (!part.plugin) throw error;
        throw new Error(
          `Brick compiler: the dashboard extension of plugin ${part.name} failed to build: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }),
    ),
  );
  const layout = layoutParts(
    parts.map((part, index) => ({ ...part, built: built[index] })),
  )!;
  await mkdir(outdir, { recursive: true });
  await writeFile(join(outdir, "extension.js"), layout.js);
  await writeFile(join(outdir, "extension.css"), layout.css);
  for (const [name, js] of Object.entries(layout.parts ?? {}))
    await writeFile(join(outdir, name), js);
  return true;
}

/**
 * How the extensions are served, by `brick dev` and from a `brick build`
 * folder alike. The app's alone is served as it is. Otherwise each that built
 * is `extension-<index>.js`, `extension.js` lists them for the page to load
 * and merge, and their styles are served together. `version` is added to each
 * part's address, so a rebuilt one is fetched again.
 */
function layoutParts(
  parts: readonly {
    name: string;
    plugin: boolean;
    built: BuiltExtension | undefined;
  }[],
  version = "",
): BuiltExtension | undefined {
  if (parts.length === 1 && !parts[0]!.plugin) return parts[0]!.built;
  const built = parts.flatMap((part, index) =>
    part.built
      ? [{ ...part, built: part.built, file: `extension-${index}.js` }]
      : [],
  );
  if (!built.length) return undefined;
  return {
    js: extensionManifest(
      built.map((part) => ({
        name: part.name,
        src: `./${part.file}${version}`,
        plugin: part.plugin,
      })),
    ),
    css: built.map((part) => part.built.css).join(""),
    parts: Object.fromEntries(built.map((part) => [part.file, part.built.js])),
  };
}

/**
 * The extension as the dashboard serves it. From source it is built here, and
 * rebuilt as its folder changes when watching; from a `brick build` folder it
 * is read as it is. A failed build keeps the error to show on the page.
 */
export class DashboardExtensionHost {
  readonly #path: string;
  readonly #warn: (message: string) => void;
  readonly #listeners = new Set<() => void>();
  #watcher: FSWatcher | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: Promise<void> = Promise.resolve();
  revision = 0;
  built: BuiltExtension | undefined;
  error: string | undefined;

  constructor(path: string, warn: (message: string) => void) {
    this.#path = resolve(path);
    this.#warn = warn;
  }

  load(): Promise<void> {
    this.#pending = this.#pending.then(async () => {
      const before = JSON.stringify([this.built, this.error]);
      try {
        const prebuilt = join(this.#path, "extension.js");
        if (existsSync(prebuilt)) {
          const css = join(this.#path, "extension.css");
          const parts: Record<string, string> = {};
          for (const name of await readdir(this.#path))
            if (/^extension-\d+\.js$/.test(name))
              parts[name] = await readFile(join(this.#path, name), "utf8");
          this.built = {
            js: await readFile(prebuilt, "utf8"),
            css: existsSync(css) ? await readFile(css, "utf8") : "",
            parts,
          };
        } else {
          if (!existsSync(this.#path))
            throw new Error(
              `Brick: the dashboard extension ${this.#path} does not exist.`,
            );
          this.built = await buildDashboardExtension(this.#path, {
            warn: this.#warn,
          });
        }
        this.error = undefined;
      } catch (error) {
        this.built = undefined;
        this.error = error instanceof Error ? error.message : String(error);
        this.#warn(`[Brick-TS] Dashboard extension: ${this.error}`);
      }
      // The folder may hold the app too; its changes leave the bundle as it was.
      if (JSON.stringify([this.built, this.error]) === before) return;
      this.revision++;
      for (const listener of this.#listeners) listener();
    });
    return this.#pending;
  }

  /** Rebuild when a file in the extension's folder changes. */
  watch(): void {
    try {
      this.#watcher = watch(
        dirname(this.#path),
        { recursive: true },
        (_event, file) => {
          if (file && /(^|[\\/])(node_modules|\.)/.test(file)) return;
          clearTimeout(this.#timer);
          this.#timer = setTimeout(() => void this.load(), 100);
        },
      );
    } catch {
      // A folder that cannot be watched still works; it needs a restart.
    }
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    clearTimeout(this.#timer);
    this.#watcher?.close();
    this.#listeners.clear();
  }
}

/** A plugin's dashboard extension, as `app.definition.plugins` lists it. */
export interface PluginDashboard {
  name: string;
  dashboard?: string;
}

/** The plugins' extensions by path, each once, in install order. */
function pluginDashboards(
  plugins: readonly PluginDashboard[],
): Map<string, string> {
  const wanted = new Map<string, string>();
  for (const plugin of plugins)
    if (plugin.dashboard && !wanted.has(resolve(plugin.dashboard)))
      wanted.set(resolve(plugin.dashboard), plugin.name);
  return wanted;
}

/**
 * The module the page loads when several extensions take part: it lists them,
 * and the page imports each apart and merges them (`mergeExtensions` there).
 */
export function extensionManifest(parts: readonly ExtensionPart[]): string {
  return `export const parts = ${JSON.stringify(parts)};\n`;
}

/**
 * The app's extension and those of its plugins, served as one. With only the
 * app's, it is served as it is; with plugins, each is built apart (a failed
 * build leaves the others) and `extension.js` loads them all.
 */
export class DashboardExtensions {
  readonly #warn: (message: string) => void;
  readonly #listeners = new Set<() => void>();
  readonly #parts: {
    name: string;
    path: string;
    host: DashboardExtensionHost;
  }[] = [];
  readonly #own: boolean;
  revision = 0;

  constructor(path: string | undefined, warn: (message: string) => void) {
    this.#warn = warn;
    this.#own = path !== undefined;
    if (path) this.#add("app", path);
  }

  #add(name: string, path: string) {
    const host = new DashboardExtensionHost(path, this.#warn);
    host.onChange(() => this.#changed());
    this.#parts.push({ name, path: resolve(path), host });
    return host;
  }

  #changed() {
    this.revision++;
    for (const listener of this.#listeners) listener();
  }

  /** Whether any extension takes part. */
  get active(): boolean {
    return this.#parts.length > 0;
  }

  get built(): BuiltExtension | undefined {
    return layoutParts(
      this.#parts.map((part, index) => ({
        name: part.name,
        plugin: !(this.#own && index === 0),
        built: part.host.built,
      })),
      `?v=${this.revision}`,
    );
  }

  get error(): string | undefined {
    const errors = this.#parts.flatMap((part) =>
      part.host.error
        ? [
            this.#own && this.#parts.length === 1
              ? part.host.error
              : `${part.name}: ${part.host.error}`,
          ]
        : [],
    );
    return errors.length ? errors.join("\n") : undefined;
  }

  /** A file under `/assets/` this serves, or undefined. */
  asset(name: string): string | undefined {
    if (name === "extension.js") return this.built?.js;
    if (name === "extension.css") return this.built?.css;
    // From the layout, or the `brick build` folder the app's names.
    return this.built?.parts?.[name];
  }

  /** Follow the app's plugins: build the extensions they ship, drop the rest. */
  async setPlugins(plugins: readonly PluginDashboard[]): Promise<void> {
    // A `brick build` folder already holds its plugins' extensions.
    if (this.#own && existsSync(join(this.#parts[0]!.path, "extension.js")))
      return;
    const wanted = pluginDashboards(plugins);
    const start = this.#own ? 1 : 0;
    const current = this.#parts.slice(start);
    if (
      current.length === wanted.size &&
      current.every((part) => wanted.get(part.path) === part.name)
    )
      return;
    for (const part of current) part.host.close();
    this.#parts.splice(start);
    const loads = [...wanted].map(([path, name]) =>
      this.#add(name, path).load(),
    );
    await Promise.all(loads);
    this.#changed();
  }

  load(): Promise<void> {
    return Promise.all(this.#parts.map((part) => part.host.load())).then(
      () => undefined,
    );
  }

  /** Rebuild the app's own as its folder changes; plugins' are packages. */
  watch(): void {
    if (this.#own) this.#parts[0]!.host.watch();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    for (const part of this.#parts) part.host.close();
    this.#listeners.clear();
  }
}
