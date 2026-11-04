import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  DashboardExtensionOptions,
  DashboardTheme,
} from "./dashboard-extension";

export type { DashboardExtensionOptions, DashboardTheme };

/** @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release. */
export const DEPLOY_TARGETS = [
  "caddy",
  "nginx",
  "traefik",
  "kubernetes",
  "compose",
  "routes",
] as const;
/** @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release. */
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];

/**
 * `deploy` in brick.config.ts.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export interface DeployOptions {
  /** What `brick build` writes into `deploy/<target>/`. */
  targets?: DeployTarget[];
  /** The public host name: Caddy and Traefik get HTTPS for it, Kubernetes a TLS Ingress. */
  domain?: string;
  /** The Bun app in compose and Kubernetes: its build and start commands, and port (default 3000). */
  app?: { build?: string; start?: string; port?: number };
}

export type LintSeverity = "error" | "warn" | "off";
export type LintPreset = "recommended" | "layout" | "strict" | "plugin";

/**
 * Project and tooling settings read by the `brick` CLI and its lint rules.
 * Paths are relative to the folder that holds `brick.config.ts`. Runtime
 * behaviour (prefix, docs, telemetry, events, sockets) stays in `brick()`.
 */
export interface BrickConfig {
  /** App entry whose default export is the BrickApp (default `src/app.ts`). */
  entry?: string;
  /** Folder scanned for definition files (default `src/services`). */
  services?: string;
  /** Folder for `services.gen.ts` and the default contract (default `_brick`). */
  generated?: string;
  client?: { output?: string };
  openapi?: { output?: string };
  dev?: {
    port?: number;
    /** Frontend command, started once the client contract exists. Needs `client.output`. */
    frontend?: string;
    dashboard?: { port?: number; historyDays?: number } | false;
  };
  build?: { outdir?: string; aot?: boolean; requestLogging?: boolean };
  dashboard?: DashboardExtensionOptions;
  /**
   * Production routing `brick build` writes into `deploy/<target>/` (for apps with Go or Rust services).
   *
   * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
   */
  deploy?: DeployOptions;
  lint?: {
    presets?: LintPreset[];
    rules?: Record<string, LintSeverity>;
    ignore?: string[];
  };
}

/** Types the config file in the editor; the CLI validates it at load. */
export function defineConfig(config: BrickConfig): BrickConfig {
  return config;
}

export const CONFIG_FILE = "brick.config.ts";

/** A missing or invalid config file; the message names the file and key. */
export class ConfigError extends Error {}

export interface LoadedConfig {
  /** Absolute path of the config file. */
  file: string;
  /** Folder the config's paths are relative to. */
  root: string;
  config: BrickConfig;
  /** Absolute paths with defaults applied. */
  entry: string;
  services: string;
  generated: string;
}

/** The nearest `brick.config.ts` in `cwd` or its parents. */
export function findConfigFile(cwd = process.cwd()): string | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const file = join(dir, CONFIG_FILE);
    if (existsSync(file)) return file;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * Load and validate the project's config: `explicit` (`--config`) when given,
 * else the nearest `brick.config.ts`. Returns undefined when there is none.
 */
export async function loadConfig(
  explicit?: string,
  cwd = process.cwd(),
): Promise<LoadedConfig | undefined> {
  const file = explicit ? resolve(cwd, explicit) : findConfigFile(cwd);
  if (!file) return undefined;
  if (!existsSync(file))
    throw new ConfigError(`Brick: config file not found: ${file}`);
  const module = await import(pathToFileURL(file).href);
  const config = module.default as BrickConfig;
  validateConfig(config, file.endsWith(CONFIG_FILE) ? CONFIG_FILE : file);
  const root = dirname(file);
  return {
    file,
    root,
    config,
    entry: resolve(root, config.entry ?? "src/app.ts"),
    services: resolve(root, config.services ?? "src/services"),
    generated: resolve(root, config.generated ?? "_brick"),
  };
}

type Check = (value: unknown) => boolean;
type Shape = { [key: string]: [Check, string] | Shape };

const isString: Check = (v) => typeof v === "string" && v.length > 0;
const isBoolean: Check = (v) => typeof v === "boolean";
const isPort: Check = (v) =>
  Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;
const isRecordOf =
  (check: Check): Check =>
  (v) =>
    isPlainObject(v) && Object.values(v).every(check);
const isArrayOf =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check);
const PRESETS = ["recommended", "layout", "strict", "plugin"];
const SEVERITIES = ["error", "warn", "off"];

const SCHEMA: Shape = {
  entry: [isString, "must be a file path"],
  services: [isString, "must be a folder path"],
  generated: [isString, "must be a folder path"],
  client: { output: [isString, "must be a file path"] },
  openapi: { output: [isString, "must be a file path"] },
  dev: {
    port: [isPort, "must be a port number"],
    frontend: [isString, "must be a command"],
    // `false`, or the shape below, checked in validateConfig.
    dashboard: {
      port: [isPort, "must be a port number"],
      historyDays: [
        (v) => Number.isSafeInteger(v) && (v as number) >= 0,
        "must be a whole number of days, or 0 for none",
      ],
    },
  },
  build: {
    outdir: [isString, "must be a folder path"],
    aot: [isBoolean, "must be true or false"],
    requestLogging: [isBoolean, "must be true or false"],
  },
  dashboard: {
    extension: [isString, "must be a file path"],
    theme: {
      light: [isRecordOf(isString), "must map token names to values"],
      dark: [isRecordOf(isString), "must map token names to values"],
      radius: [isString, "must be a CSS length"],
      fonts: {
        sans: [isString, "must be a font-family value"],
        mono: [isString, "must be a font-family value"],
      },
    },
  },
  deploy: {
    targets: [
      isArrayOf((v) => DEPLOY_TARGETS.includes(v as never)),
      `must list targets from ${DEPLOY_TARGETS.join(", ")}`,
    ],
    domain: [isString, "must be a host name"],
    app: {
      build: [isString, "must be a command"],
      start: [isString, "must be a command"],
      port: [isPort, "must be a port number"],
    },
  },
  lint: {
    presets: [
      isArrayOf((v) => PRESETS.includes(v as string)),
      `must list presets from ${PRESETS.join(", ")}`,
    ],
    rules: [
      isRecordOf((v) => SEVERITIES.includes(v as string)),
      'must map rule names to "error", "warn" or "off"',
    ],
    ignore: [isArrayOf(isString), "must be a list of glob patterns"],
  },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws on an unknown key, a bad type, or `dev.frontend` without `client.output`. */
export function validateConfig(
  config: unknown,
  label = CONFIG_FILE,
): asserts config is BrickConfig {
  const fail = (message: string): never => {
    throw new ConfigError(`${label}: ${message}`);
  };
  if (!isPlainObject(config)) fail("must default-export defineConfig({ ... })");
  const walk = (value: Record<string, unknown>, shape: Shape, path: string) => {
    for (const [key, child] of Object.entries(value)) {
      const keyPath = path + key;
      const rule = shape[key];
      if (!rule) fail(`unknown key ${keyPath}`);
      if (child === undefined) continue;
      if (keyPath === "dev.dashboard" && child === false) continue;
      if (Array.isArray(rule)) {
        if (!rule[0](child)) fail(`${keyPath} ${rule[1]}`);
      } else if (!isPlainObject(child)) {
        fail(
          `${keyPath} must be an object${keyPath === "dev.dashboard" ? " or false" : ""}`,
        );
      } else walk(child, rule as Shape, `${keyPath}.`);
    }
  };
  walk(config as Record<string, unknown>, SCHEMA, "");
  const typed = config as BrickConfig;
  if (typed.dev?.frontend && !typed.client?.output)
    fail("dev.frontend requires client.output");
}
