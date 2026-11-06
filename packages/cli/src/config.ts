import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  Type as t,
  type Static,
  type TOptional,
  type TSchema,
} from "@sinclair/typebox";
import { Value, ValueErrorType } from "@sinclair/typebox/value";

import type {
  DashboardExtensionOptions,
  DashboardTheme,
} from "./dashboard-extension";

export type { DashboardExtensionOptions, DashboardTheme };

const PRESET_NAMES = ["recommended", "layout", "strict", "plugin"] as const;
const SEVERITIES = ["error", "warn", "off"] as const;
export type LintPreset = (typeof PRESET_NAMES)[number];
export type LintSeverity = (typeof SEVERITIES)[number];

export const DEFAULT_PORT = 4000;
export const DEFAULT_DASHBOARD_PORT = 9400;
export const DEFAULT_HISTORY_DAYS = 90;
export const DEFAULT_OUTDIR = "dist/brick";
/** Project paths a config leaves out, relative to its folder. */
export const PROJECT_DEFAULTS = {
  entry: "src/app.ts",
  services: "src/services",
  generated: "_brick",
} as const;
/** The client contract's name in the generated folder, when `client.output` names none. */
export const CONTRACT_FILE = "contract.ts";
const CONFIG_FILE = "brick.config.ts";

const path = (message: string) => t.String({ minLength: 1, message });
const port = t.Integer({
  minimum: 1,
  maximum: 65535,
  message: "must be a port number",
});
const flag = t.Boolean({ message: "must be true or false" });
const shape = <T extends Record<string, TSchema>>(properties: T) =>
  t.Optional(t.Object(properties, { additionalProperties: false }));
const optional = <T extends Record<string, TSchema>>(properties: T) =>
  Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, t.Optional(value)]),
  ) as { [K in keyof T]: TOptional<T[K]> };
const tokens = t.Record(t.String(), t.String(), {
  message: "must map token names to values",
});

/**
 * Project and tooling settings read by the `brick` CLI and its lint rules.
 * Paths are relative to the folder that holds `brick.config.ts`. Runtime
 * behaviour (prefix, docs, telemetry, events, sockets) stays in `brick()`.
 */
const BrickConfigSchema = t.Object(
  optional({
    /** App entry whose default export is the BrickApp (default `src/app.ts`). */
    entry: path("must be a file path"),
    /** Folder scanned for definition files (default `src/services`). */
    services: path("must be a folder path"),
    /** Folder for `services.gen.ts` and the default contract (default `_brick`). */
    generated: path("must be a folder path"),
    client: shape(optional({ output: path("must be a file path") })),
    openapi: shape(optional({ output: path("must be a file path") })),
    dev: shape(
      optional({
        port,
        /** Frontend command, started once the client contract exists. Needs `client.output`. */
        frontend: path("must be a command"),
        dashboard: t.Union(
          [
            t.Literal(false),
            t.Object(
              optional({
                port,
                historyDays: t.Integer({
                  minimum: 0,
                  maximum: Number.MAX_SAFE_INTEGER,
                  message: "must be a whole number of days, or 0 for none",
                }),
              }),
              { additionalProperties: false },
            ),
          ],
          { message: "must be an object or false" },
        ),
      }),
    ),
    build: shape(
      optional({
        outdir: path("must be a folder path"),
        aot: flag,
        requestLogging: flag,
      }),
    ),
    dashboard: shape(
      optional({
        extension: path("must be a file path"),
        theme: shape(
          optional({
            light: tokens,
            dark: tokens,
            radius: path("must be a CSS length"),
            fonts: shape(
              optional({
                sans: path("must be a font-family value"),
                mono: path("must be a font-family value"),
              }),
            ),
          }),
        ),
      }),
    ),
    lint: shape(
      optional({
        presets: t.Array(t.Union(PRESET_NAMES.map((name) => t.Literal(name))), {
          message: `must list presets from ${PRESET_NAMES.join(", ")}`,
        }),
        rules: t.Record(
          t.String(),
          t.Union(SEVERITIES.map((severity) => t.Literal(severity))),
          { message: 'must map rule names to "error", "warn" or "off"' },
        ),
        ignore: t.Array(t.String({ minLength: 1 }), {
          message: "must be a list of glob patterns",
        }),
      }),
    ),
  }),
  {
    additionalProperties: false,
    message: "must default-export defineConfig({ ... })",
  },
);

export type BrickConfig = Static<typeof BrickConfigSchema>;

/** Types the config file in the editor; the CLI validates it at load. */
export function defineConfig(config: BrickConfig): BrickConfig {
  return config;
}

/** A user's mistake: a missing file, an invalid config, or flags that conflict. `brick` prints the message alone. */
export class ConfigError extends Error {}

/** The project: its config file, if any, and every path with defaults applied. */
export interface LoadedConfig {
  /** Absolute path of the config file; absent when the project has none. */
  file?: string;
  /** Folder the config's paths are relative to (the working folder without a file). */
  root: string;
  config: BrickConfig;
  /** Absolute paths with defaults applied. */
  entry: string;
  services: string;
  generated: string;
  /** Where the client contract goes: `client.output`, else `<generated>/contract.ts`. */
  contract: string;
  /** Where `brick build` writes: `build.outdir`, else `dist/brick`. */
  outdir: string;
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
 * The project, from `explicit` (`--config`) when given, else the nearest
 * `brick.config.ts`, validated. Without a file, the defaults from `cwd`.
 */
export async function resolveProject(
  explicit?: string,
  cwd = process.cwd(),
): Promise<LoadedConfig> {
  const file = explicit ? resolve(cwd, explicit) : findConfigFile(cwd);
  if (file && !existsSync(file))
    throw new ConfigError(`Brick: config file not found: ${file}`);
  const config: BrickConfig = file
    ? (await import(pathToFileURL(file).href)).default
    : {};
  if (file)
    validateConfig(config, file.endsWith(CONFIG_FILE) ? CONFIG_FILE : file);
  const root = file ? dirname(file) : resolve(cwd);
  const generated = resolve(
    root,
    config.generated ?? PROJECT_DEFAULTS.generated,
  );
  return {
    file,
    root,
    config,
    entry: resolve(root, config.entry ?? PROJECT_DEFAULTS.entry),
    services: resolve(root, config.services ?? PROJECT_DEFAULTS.services),
    generated,
    contract: config.client?.output
      ? resolve(root, config.client.output)
      : join(generated, CONTRACT_FILE),
    outdir: resolve(root, config.build?.outdir ?? DEFAULT_OUTDIR),
  };
}

/**
 * Load and validate the project's config: `explicit` (`--config`) when given,
 * else the nearest `brick.config.ts`. Returns undefined when there is none.
 */
export async function loadConfig(
  explicit?: string,
  cwd = process.cwd(),
): Promise<LoadedConfig | undefined> {
  const project = await resolveProject(explicit, cwd);
  return project.file ? project : undefined;
}

/** The dashboard flags of `brick dev`. */
export interface DevDashboardFlags {
  /** `false` with `--no-dashboard`. */
  dashboard?: boolean;
  dashboardPort?: number;
  historyDays?: number;
  dashboardExtension?: string;
}

/**
 * Whether `brick dev` serves its dashboard, and its port and history, from the
 * config's `dev.dashboard` and the flags. The config can turn it off; a port or
 * history flag turns it back on.
 *
 * @throws ConfigError When a dashboard flag is combined with turning it off.
 */
export function resolveDevDashboard(
  configured: NonNullable<BrickConfig["dev"]>["dashboard"],
  flags: DevDashboardFlags,
): { port?: number; historyDays?: number } | false {
  if (flags.dashboard === false) {
    if (flags.dashboardPort !== undefined)
      throw new ConfigError(
        "Brick: --dashboard-port cannot be combined with --no-dashboard.",
      );
    if (flags.historyDays !== undefined)
      throw new ConfigError(
        "Brick: --history-days cannot be combined with --no-dashboard.",
      );
  }
  const off =
    flags.dashboard === false ||
    (configured === false &&
      flags.dashboardPort === undefined &&
      flags.historyDays === undefined);
  if (off && flags.dashboardExtension)
    throw new ConfigError(
      flags.dashboard === false
        ? "Brick: --dashboard-extension cannot be combined with --no-dashboard."
        : "Brick: --dashboard-extension needs the dashboard, which dev.dashboard: false in the config turns off.",
    );
  if (off) return false;
  const settings = configured || undefined;
  return {
    port: flags.dashboardPort ?? settings?.port,
    historyDays: flags.historyDays ?? settings?.historyDays,
  };
}

/** A port from a flag, else `PORT`, else the config, else 4000; throws outside 1-65535. */
export function resolvePort(
  flag?: number | string,
  configured?: number,
  env = process.env.PORT,
): number {
  const port = Number(flag ?? (env || undefined) ?? configured ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      `Invalid port: ${port}. Port must be an integer between 1 and 65535`,
    );
  return port;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The schema of `key` inside `schema`, looking into the object of a union. */
function child(schema: TSchema, key: string): TSchema | undefined {
  const object: TSchema =
    schema.anyOf?.find((s: TSchema) => s.type === "object") ?? schema;
  return (
    object.properties?.[key] ??
    (object.patternProperties &&
      (Object.values(object.patternProperties)[0] as TSchema)) ??
    object.items
  );
}

/** Throws on an unknown key, a bad type, or `dev.frontend` without `client.output`. */
export function validateConfig(
  config: unknown,
  label = CONFIG_FILE,
): asserts config is BrickConfig {
  const fail = (message: string): never => {
    throw new ConfigError(`${label}: ${message}`);
  };
  let error = Value.Errors(BrickConfigSchema, config).First();
  const keys: string[] = [];
  // `false` or an object: given an object, report what is wrong inside it.
  while (error?.schema.anyOf && isPlainObject(error.value)) {
    const object = error.schema.anyOf.find((s: TSchema) => s.type === "object");
    if (!object) break;
    keys.push(...error.path.split("/").slice(1));
    error = Value.Errors(object, error.value).First();
  }
  if (error) {
    keys.push(...error.path.split("/").slice(1));
    if (error.type === ValueErrorType.ObjectAdditionalProperties)
      fail(`unknown key ${keys.join(".")}`);
    // The message of the deepest schema that has one, at that schema's path.
    let schema: TSchema | undefined = BrickConfigSchema;
    let message: string = schema.message;
    let at = 0;
    keys.forEach((key, index) => {
      schema = schema && child(schema, key);
      if (schema?.message) [message, at] = [schema.message, index + 1];
      else if (schema?.type === "object" && index === keys.length - 1)
        [message, at] = ["must be an object", index + 1];
    });
    fail(at ? `${keys.slice(0, at).join(".")} ${message}` : message);
  }
  const typed = config as BrickConfig;
  if (typed.dev?.frontend && !typed.client?.output)
    fail("dev.frontend requires client.output");
}
