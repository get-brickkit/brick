import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getTableName, type Table } from "drizzle-orm";
import {
  integer as sqliteInteger,
  real as sqliteReal,
  sqliteTable,
  text as sqliteText,
  type SQLiteColumnBuilderBase,
} from "drizzle-orm/sqlite-core";
import {
  boolean as pgBoolean,
  doublePrecision,
  integer as pgInteger,
  jsonb,
  pgTable,
  text as pgText,
  timestamp as pgTimestamp,
} from "drizzle-orm/pg-core";
import { PLUGIN_DEPS, runWithDeps, type DepsOf, type Ports } from "./deps";
import type { EventCatalog, EventRef, EventRefs } from "./events/catalog";
import type { EventListener } from "./events/types";
import {
  hasPlugin,
  pluginFinish,
  type PluginRouteRegistrar,
  type ResourcePlugin,
  type ServicePlugin,
} from "./plugin";
import { definitionSite } from "./registry";
import type { SecretRef } from "./secrets";
import { validateWithSchema } from "./typebox";
import type { ActionContext, BaseContext, Resource, Service } from "./types";

/*
 * definePlugin: one plugin with a manifest Brick checks (name, supported Brick
 * versions, required plugins, typed options, secrets) and a place for each
 * capability: owned tables, catalog events, host CRUD hooks, routes, and an
 * app part with start/stop lifecycle, middleware and listeners. Installing on
 * a service or resource reuses `installPlugin`, so route registration,
 * collision checks and rollback are the same as for the older two kinds.
 */

// ---------------------------------------------------------------- versions

let runningVersion: string | undefined;
/** The version of this @brickkit/core, read from its package.json; `""` when unknown. */
export function brickVersion(): string {
  if (runningVersion !== undefined) return runningVersion;
  // src/ and dist/ sit one level down, a shared chunk two.
  for (const relative of ["../package.json", "../../package.json"]) {
    try {
      const json = JSON.parse(
        readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"),
      );
      if (json.name === "@brickkit/core")
        return (runningVersion = json.version);
    } catch {
      // Not there; try the next one.
    }
  }
  // shortcut: a bundle that inlined core has no package.json; the check then passes.
  return (runningVersion = "");
}

type Triple = [number, number, number];
function parseVersion(version: string): Triple {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, "")
    .split(/[-+]/)[0]!
    .split(".")
    .map(Number);
  return [major, minor, patch];
}
function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Whether `version` is in a semver `range`: `^0.11.0`, `~0.11.2`, `>=0.11 <0.13`,
 * `0.11.x`, `*`, and `||` between alternatives. Prerelease tags are ignored.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const current = parseVersion(version);
  return range.split("||").some((set) =>
    set
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((comparator) => {
        const match =
          /^(\^|~|>=|<=|>|<|=)?v?([\dx*]+(?:\.[\dx*]+){0,2})?/i.exec(
            comparator,
          );
        const operator = match?.[1] ?? "";
        const raw = match?.[2] ?? "*";
        const parts = raw.split(".");
        const wild = parts.findIndex((part) => /^[x*]$/i.test(part));
        const given = wild === -1 ? parts.length : wild;
        const low = parseVersion(parts.slice(0, given).join(".") || "0");
        if (given === 0) return true;
        const cmp = compare(current, low);
        if (operator === ">=") return cmp >= 0;
        if (operator === ">") return cmp > 0;
        if (operator === "<") return cmp < 0;
        if (operator === "<=") return cmp <= 0;
        let high: Triple;
        if (operator === "^")
          high =
            low[0] > 0 || given === 1
              ? [low[0] + 1, 0, 0]
              : low[1] > 0 || given === 2
                ? [0, low[1] + 1, 0]
                : [0, 0, low[2] + 1];
        else if (operator === "~" || given < 3)
          high = given === 1 ? [low[0] + 1, 0, 0] : [low[0], low[1] + 1, 0];
        else return cmp === 0;
        return cmp >= 0 && compare(current, high) < 0;
      }),
  );
}

// ------------------------------------------------------------------ tables

const OWNER = Symbol.for("brickkit.plugin.owner");
/** The plugin that owns a table, for tables a `definePlugin` contributed. */
export function pluginOwner(table: unknown): string | undefined {
  return table && typeof table === "object"
    ? (table as Record<symbol, string | undefined>)[OWNER]
    : undefined;
}

const sqliteBuilders = {
  /** A table. Its name gets the plugin's prefix (`page_comments`). */
  table: <C extends Record<string, SQLiteColumnBuilderBase>>(
    name: string,
    columns: C,
  ) => sqliteTable(name, columns),
  text: (name: string) => sqliteText(name),
  integer: (name: string) => sqliteInteger(name, { mode: "number" }),
  real: (name: string) => sqliteReal(name),
  boolean: (name: string) => sqliteInteger(name, { mode: "boolean" }),
  /** A `Date`, stored as epoch milliseconds or `timestamptz`. */
  timestamp: (name: string) => sqliteInteger(name, { mode: "timestamp_ms" }),
  json: (name: string) => sqliteText(name, { mode: "json" }),
};

/**
 * Engine-neutral column builders for `tables`. Brick passes the SQLite or
 * Postgres ones to match the host database; the types follow SQLite's, and the
 * JavaScript values are the same on both (a `Date` for `timestamp`).
 */
export type PluginTableBuilders = typeof sqliteBuilders & {
  /** The host database's engine. */
  readonly engine: "sqlite" | "postgres";
};

function builders(
  engine: "sqlite" | "postgres",
  tableName: (name: string) => string,
): PluginTableBuilders {
  if (engine === "postgres")
    return {
      engine,
      table: (name, columns) =>
        pgTable(tableName(name), columns as never) as never,
      text: (name) => pgText(name) as never,
      integer: (name) => pgInteger(name) as never,
      real: (name) => doublePrecision(name) as never,
      boolean: (name) => pgBoolean(name) as never,
      timestamp: (name) =>
        pgTimestamp(name, { mode: "date", withTimezone: true }) as never,
      json: (name) => jsonb(name) as never,
    };
  return {
    ...sqliteBuilders,
    engine,
    table: (name, columns) => sqliteTable(tableName(name), columns),
  };
}

// ------------------------------------------------------------------- hooks

/** Where `hooks.*` stores a plugin's hooks; `@brickkit/crud` runs them. */
const HOST_HOOKS = Symbol.for("brickkit.plugin.hooks");

interface HookBase<C> {
  ctx: C;
  /** The write's open transaction: write other tables through it. */
  tx: any;
}
/**
 * Subscribe to the host's CRUD writes (resources with `crud()`). `before*` and
 * `after*` run inside the write's transaction, after the host's own crud hooks;
 * a hook that throws rolls the write back. `afterCommit` runs after the commit.
 */
export interface PluginHooks<C = ActionContext> {
  beforeCreate(
    hook: (args: HookBase<C> & { data: Record<string, unknown> }) => unknown,
  ): void;
  afterCreate(
    hook: (args: HookBase<C> & { row: Record<string, unknown> }) => unknown,
  ): void;
  beforeUpdate(
    hook: (
      args: HookBase<C> & { id: unknown; data: Record<string, unknown> },
    ) => unknown,
  ): void;
  afterUpdate(
    hook: (
      args: HookBase<C> & { id: unknown; row: Record<string, unknown> },
    ) => unknown,
  ): void;
  beforeDelete(hook: (args: HookBase<C> & { id: unknown }) => unknown): void;
  afterDelete(hook: (args: HookBase<C> & { id: unknown }) => unknown): void;
  afterCommit(
    hook: (args: {
      operation: "create" | "update" | "delete";
      id: unknown;
      row?: Record<string, unknown>;
      ctx: C;
    }) => unknown,
  ): void;
}
const HOOK_NAMES = [
  "beforeCreate",
  "afterCreate",
  "beforeUpdate",
  "afterUpdate",
  "beforeDelete",
  "afterDelete",
  "afterCommit",
] as const;

// ---------------------------------------------------------------- manifest

type Secrets = Record<string, SecretRef<any>>;
type OptionsOf<O> = O extends TSchema ? Static<O> : {};

/**
 * The context of a plugin's actions, endpoints and hooks: the host's request
 * context, loosely typed, with `deps` set to the plugin's own declared deps.
 */
export type PluginContext<P extends Ports = {}> = BaseContext<any> &
  PluginServiceContext<P>;
/** A plugin's view of its host's service context: loose, except `deps`, which is the plugin's. */
export type PluginServiceContext<P extends Ports = {}> = {
  [key: string]: any;
  /** The values passed for the plugin's `deps` when it was installed. */
  deps: DepsOf<P>;
};

/** What every setup callback receives. */
export interface PluginSetupContext<
  O,
  S,
  T,
  E extends EventCatalog,
  P extends Ports = {},
> {
  /** The validated options, defaults filled in. */
  options: O;
  /** The declared secrets, to read when they are needed. */
  secrets: S;
  /** The tables this plugin owns, by the keys `tables` returned. */
  tables: T;
  /** The plugin's events, as `emitEvent` and `defineListener` take them. */
  events: EventRefs<E>;
  /** The values passed for `deps` when the plugin was installed. */
  deps: DepsOf<P>;
  /** The host service. Actions registered on it read the plugin's deps as `ctx.deps`. */
  service: Service<any, PluginServiceContext<P>>;
  routes: PluginRouteRegistrar<PluginContext<P>>;
  /** The host's CRUD writes: on a service, those of all its resources. */
  hooks: PluginHooks<PluginContext<P>>;
}

/** The lifecycle context of `on("start")` and `on("stop")`. */
export interface PluginLifecycleContext<O, S, P extends Ports = {}> {
  options: O;
  secrets: S;
  deps: DepsOf<P>;
}

/** What `app` receives: the app-wide part of a plugin. */
export interface PluginAppContext<O, S, P extends Ports = {}> {
  options: O;
  secrets: S;
  /** The values passed for `deps` when the plugin was installed. */
  deps: DepsOf<P>;
  /**
   * Run when the app starts (`app.start()`, which `listen`, `brick dev` and
   * `brick start` call) in install order, and when it stops in reverse order.
   */
  on(
    event: "start" | "stop",
    handler: (context: PluginLifecycleContext<O, S, P>) => void | Promise<void>,
  ): void;
  /**
   * Run before every request is routed. Return a `Response` (or any value) to
   * answer it here; return nothing to let it through.
   */
  middleware(
    handler: (context: {
      request: Request;
      set: { status?: number | string; headers: Record<string, string> };
    }) => unknown,
  ): void;
  /**
   * Event listeners to add to the app's `events`. `useDeps()` in their `run`,
   * and in the steps of their `workflow`, returns the plugin's deps.
   */
  listeners(...listeners: EventListener[]): void;
}

export interface PluginManifest<
  O extends TSchema | undefined = undefined,
  S extends Secrets = {},
  T extends Record<string, Table> = {},
  E extends EventCatalog = {},
  RA extends object = {},
  SA = unknown,
  P extends Ports = {},
> {
  /** The npm package name, scoped: `@acme/brick-comments`. */
  name: string;
  description?: string;
  /** The Brick versions it supports, as a semver range: `^0.11.0`. */
  brick?: string;
  /** Plugins that must be installed on the same host first, by name. */
  requires?: readonly string[];
  /** A TypeBox schema for the options; defaults fill what the user leaves out. */
  options?: O;
  /** Secrets it reads, from `defineSecret`. */
  secrets?: S;
  /**
   * What it needs from the app, declared with `port<T>()`. The user passes the
   * values when installing: `notify(options, { deps: { mailer } })`. Setup
   * parts read them as `deps`, the plugin's actions as `ctx.deps`.
   */
  deps?: P;
  /**
   * Tables it owns. They are created in the host service's database for its
   * engine, named `<host>_<table>` (or with the install's `prefix`), and join
   * schema sync and migrations through `database.tables`.
   */
  tables?: (builders: PluginTableBuilders) => T;
  /** Events it emits; they join the host catalog as `<plugin>.<event>`. */
  events?: E;
  /** Installed with `resource.use()`; returns what the resource gains. */
  resource?: (
    context: PluginSetupContext<OptionsOf<O>, S, T, E, P> & {
      resource: Resource<any, PluginContext<P>, any>;
    },
  ) => RA & (RA extends PromiseLike<unknown> ? never : unknown);
  /** Installed with `service.use()`; returns what `use` hands back. */
  service?: (
    context: PluginSetupContext<OptionsOf<O>, S, T, E, P>,
  ) => SA & (SA extends PromiseLike<unknown> ? never : unknown);
  /**
   * The app-wide part: lifecycle, middleware and listeners. Runs once per
   * plugin instance when `brick()` creates the app, whether the plugin was
   * installed with `brick({ plugins })`, `service.use()` or `resource.use()`.
   */
  app?: (context: PluginAppContext<OptionsOf<O>, S, P>) => void;
  /**
   * A dashboard extension module (`defineDashboard`), relative to the file
   * that calls `definePlugin`. `brick dev` merges it with the app's own.
   */
  dashboard?: string;
}

/** Where the plugin is installed, besides its options. */
export interface PluginInstallOptions {
  /** Table name prefix instead of `<host>_`, such as `"blog_"`; `""` for none. */
  prefix?: string;
}

/** What the plugin's capabilities are, read from its manifest. */
export interface PluginInfo {
  readonly name: string;
  readonly description?: string;
  readonly brick?: string;
  readonly requires: readonly string[];
  readonly options?: TSchema;
  readonly secrets: readonly string[];
  /** The names of the deps it declares, passed when installing. */
  readonly deps: readonly string[];
  readonly capabilities: readonly (
    | "tables"
    | "events"
    | "resource"
    | "service"
    | "app"
    | "dashboard"
  )[];
}

const INTERNALS = Symbol.for("brickkit.plugin.internals");
interface Installation {
  scope: "app" | "service" | "resource";
  service?: string;
  resource?: string;
}
interface Internals {
  manifest: PluginManifest<any, any, any, any, any, any, any>;
  options: Record<string, unknown>;
  deps: Readonly<Record<string, unknown>>;
  install: PluginInstallOptions;
  dashboard?: string;
  installs: Installation[];
  /** When it was first installed, to run `app` parts in install order. */
  order?: number;
}
let installCount = 0;

/** A plugin ready to install: `resource.use(p)`, `service.use(p)` or `brick({ plugins: [p] })`. */
export type PluginInstance<
  RA extends object = {},
  SA = unknown,
> = ResourcePlugin<any, any, RA> &
  ServicePlugin<any, SA> & { readonly info: PluginInfo };

/** `definePlugin`'s result: call it with options to get an instance. */
export type PluginFactory<
  O extends TSchema | undefined,
  RA extends object,
  SA,
  P extends Ports = {},
> = ((
  // shortcut: every option is optional in the type (TypeBox types carry no
  // defaults); a required one without a default fails when installed.
  ...args: {} extends P
    ? [options?: Partial<OptionsOf<O>>, install?: PluginInstallOptions]
    : [
        options: Partial<OptionsOf<O>> | undefined,
        install: PluginInstallOptions & { deps: DepsOf<P> },
      ]
) => PluginInstance<RA, SA>) & { readonly info: PluginInfo };

const toWords = (name: string) =>
  (name.split("/").pop() ?? name)
    .replace(/^brick-/, "")
    .replace(/-plugin$/, "")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
const snake = (value: string) =>
  value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/**
 * Define a plugin: a manifest Brick checks, plus the capabilities the plugin
 * brings. Install its instances with `resource.use()`, `service.use()` or
 * `brick({ plugins })`; scope comes from where it is installed.
 *
 * @param manifest - `name`, `brick` (semver range), `requires`, `options`
 * (TypeBox), `secrets`, `tables`, `events`, the `resource`, `service` and `app`
 * parts, and a `dashboard` extension.
 * @returns A factory: `comments({ maxLength: 500 })` validates the options and
 * the Brick version and returns an instance to install.
 * @throws From the factory, when the running Brick is outside `brick` or an
 * option is invalid; when installed, when a required plugin is missing or the
 * host does not suit the plugin.
 * @example
 * export const audit = definePlugin({
 *   name: "@acme/brick-audit",
 *   brick: "^0.11.0",
 *   requires: ["@brickkit/crud"],
 *   options: t.Object({ table: t.String({ default: "audit" }) }),
 *   tables: ({ table, text, timestamp }) => ({
 *     log: table("log", { id: text("id").primaryKey(), at: timestamp("at").notNull() }),
 *   }),
 *   resource: ({ tables, hooks }) => {
 *     hooks.afterCreate(({ row, tx }) =>
 *       tx.insert(tables.log).values({ id: String(row.id), at: new Date() }));
 *     return {};
 *   },
 * });
 *
 * page.use(audit());
 */
export function definePlugin<
  O extends TSchema | undefined = undefined,
  S extends Secrets = {},
  T extends Record<string, Table> = {},
  const E extends EventCatalog = {},
  RA extends object = {},
  SA = unknown,
  P extends Ports = {},
>(
  manifest: PluginManifest<O, S, T, E, RA, SA, P>,
): PluginFactory<O, RA, SA, P> {
  const { name } = manifest;
  if (!name || name.trim() !== name)
    throw new Error(
      "Plugin names must be nonempty and have no surrounding whitespace",
    );
  if (!manifest.resource && !manifest.service && !manifest.app)
    throw new Error(
      `Plugin "${name}" needs a resource, service or app part to install`,
    );
  for (const key of Object.keys(manifest.events ?? {}))
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key))
      throw new Error(
        `Event "${key}" of plugin "${name}" must be a plain name such as added`,
      );
  const site = definitionSite()?.replace(/:\d+$/, "");
  const dashboard =
    manifest.dashboard === undefined
      ? undefined
      : manifest.dashboard.startsWith("file:")
        ? fileURLToPath(manifest.dashboard)
        : isAbsolute(manifest.dashboard) || !site
          ? resolve(manifest.dashboard)
          : resolve(dirname(site), manifest.dashboard);
  const info: PluginInfo = Object.freeze({
    name,
    description: manifest.description,
    brick: manifest.brick,
    requires: Object.freeze([...(manifest.requires ?? [])]),
    options: manifest.options,
    secrets: Object.freeze(
      Object.values(manifest.secrets ?? {}).map((secret) => secret.name),
    ),
    deps: Object.freeze(Object.keys(manifest.deps ?? {})),
    capabilities: Object.freeze(
      (
        ["tables", "events", "resource", "service", "app", "dashboard"] as const
      ).filter((key) => manifest[key] !== undefined),
    ),
  });
  const words = toWords(name);
  // `comments` for events (`comments.added`), `comments` for tables.
  const eventSpace = words
    .map((word, index) =>
      index ? word[0]!.toUpperCase() + word.slice(1) : word,
    )
    .join("");
  const tableSpace = snake(words.join("_"));
  if (!eventSpace)
    throw new Error(`Plugin "${name}" needs letters or digits in its name`);

  const factory = (
    input: Partial<OptionsOf<O>> = {},
    install: PluginInstallOptions & { deps?: Record<string, unknown> } = {},
  ): PluginInstance<RA, SA> => {
    const version = brickVersion();
    if (manifest.brick && version && !satisfiesRange(version, manifest.brick))
      throw new Error(
        `${name} supports Brick ${manifest.brick}; this app runs ${version}`,
      );
    const options = checkOptions(name, manifest.options, input);
    const deps = checkDeps(name, eventSpace, manifest.deps, install.deps);
    const secrets = (manifest.secrets ?? {}) as S;
    const internals: Internals = {
      manifest,
      options,
      deps,
      install,
      dashboard,
      installs: [],
    };
    // A stack: a plugin may install another instance of itself during setup.
    const pending: (() => void)[] = [];

    const setup = (context: {
      service: Service<any, any>;
      resource?: Resource<any, any, any>;
      routes: PluginRouteRegistrar<any>;
    }) => {
      const { service, resource } = context;
      const host = resource ?? service;
      const where = resource
        ? `resource "${resource.name}"`
        : `service "${service.name}"`;
      const part = resource ? manifest.resource : manifest.service;
      if (!part)
        throw new Error(
          `${name} cannot be installed on a ${resource ? "resource" : "service"}; ${
            manifest.resource
              ? "use resource.use()"
              : manifest.service
                ? "use service.use()"
                : "add it to brick({ plugins })"
          }`,
        );
      for (const required of manifest.requires ?? [])
        if (!hasPlugin(service, host, required))
          throw new Error(
            `${name} requires ${required}, installed on ${where} before it`,
          );

      // Tables: built for the host's engine, registered with the service now
      // (rolled back with it), added to its database once installed.
      let tables = {} as T;
      if (manifest.tables) {
        const database = service.getDatabaseHandle?.();
        if (!database)
          throw new Error(
            `${name} owns tables, so service "${service.name}" needs a database`,
          );
        const prefix =
          install.prefix ?? `${snake(resource?.name ?? service.name)}_`;
        tables = manifest.tables(
          builders(database.engine, (table) =>
            install.prefix !== undefined || table === tableSpace
              ? `${prefix}${table}`
              : `${prefix}${tableSpace}_${table}`,
          ),
        );
        const taken = new Set(
          [...service.tables.values(), ...Object.values(database.tables)].map(
            (table) => getTableName(table),
          ),
        );
        for (const table of Object.values(tables)) {
          const tableName = getTableName(table);
          if (taken.has(tableName))
            throw new Error(
              `${name} table "${tableName}" clashes with a table service "${service.name}" already has; install it with another prefix`,
            );
          taken.add(tableName);
          Object.defineProperty(table, OWNER, { value: name });
          service.registerTable(table);
        }
      }

      // Events: `<plugin>.<event>` in the host catalog. The same plugin on
      // two resources of one service shares them.
      const catalog = service.events as Record<string, EventRef>;
      const events: Record<string, EventRef> = {};
      for (const [key, schema] of Object.entries(manifest.events ?? {})) {
        const existing = catalog[`${eventSpace}.${key}`];
        if (existing && existing.plugin !== name)
          throw new Error(
            `${name} event "${eventSpace}.${key}" is already in the catalog of service "${service.name}"`,
          );
        events[key] =
          existing ??
          Object.freeze({
            name: `${service.name}.${eventSpace}.${key}`,
            service: service.name,
            schema,
            plugin: name,
          });
      }

      const added: Record<string, ((args: any) => unknown)[]> = {};
      const hooks = Object.fromEntries(
        HOOK_NAMES.map((hook) => [
          hook,
          (fn: (args: any) => unknown) => {
            if (typeof fn !== "function")
              throw new Error(`${name}: hooks.${hook} needs a function`);
            (added[hook] ??= []).push((args) =>
              fn({ ...args, ctx: { ...args.ctx, deps } }),
            );
          },
        ]),
      ) as unknown as PluginHooks<any>;

      const routes: PluginRouteRegistrar<any> = {
        action: (config: any) => context.routes.action(config),
        endpoint: (config) =>
          context.routes.endpoint({
            ...config,
            handler: (args) =>
              config.handler({ ...args, ctx: { ...args.ctx, deps } }),
          }),
      };
      const before = new Set<unknown>([
        ...service.actions.values(),
        ...service.tools.values(),
        ...service.listSockets(),
      ]);
      const started = bindings;
      const api = part({
        options: options as never,
        secrets,
        tables,
        events: events as EventRefs<E>,
        deps: deps as DepsOf<P>,
        service: service as never,
        resource: resource as never,
        routes,
        hooks,
      });
      if (api && typeof (api as { then?: unknown }).then === "function")
        throw new Error("Plugin setup must be synchronous");
      // Every action and socket the setup added (its own, its resources', crud's) runs with the plugin's deps.
      for (const action of [
        ...service.actions.values(),
        ...service.tools.values(),
      ])
        if (!before.has(action)) bindPluginDeps(name, action, deps, started);
      for (const socket of service.listSockets())
        if (!before.has(socket))
          (socket as unknown as Record<symbol, unknown>)[PLUGIN_DEPS] ??= deps;

      pending.push(() => {
        const database = service.getDatabaseHandle?.();
        for (const table of Object.values(tables))
          database?.addTable?.(getTableName(table), table);
        if (Object.keys(events).length)
          // `readonly` for users; the catalog grows only here.
          (service as { events: Record<string, EventRef> }).events =
            Object.freeze({
              ...catalog,
              ...Object.fromEntries(
                Object.entries(events).map(([key, ref]) => [
                  `${eventSpace}.${key}`,
                  ref,
                ]),
              ),
            });
        const store = ((host as unknown as Record<symbol, unknown>)[
          HOST_HOOKS
        ] ??= {}) as Record<string, ((args: any) => unknown)[]>;
        for (const [hook, fns] of Object.entries(added))
          (store[hook] ??= []).push(...fns);
        internals.installs.push({
          scope: resource ? "resource" : "service",
          service: service.name,
          resource: resource?.name,
        });
        internals.order ??= ++installCount;
      });
      return resource ? (api ?? {}) : api;
    };

    return Object.freeze({
      [Symbol.for("brickkit.plugin.kind")]: "plugin",
      name,
      info,
      setup,
      [INTERNALS]: internals,
      [pluginFinish]: (installed: boolean) => {
        const commit = pending.pop();
        if (installed) commit?.();
      },
    }) as unknown as PluginInstance<RA, SA>;
  };
  return Object.assign(factory, { info });
}

/** Counts bindings, so a setup can tell a nested install's from an earlier one's. */
let bindings = 0;
/**
 * Give an action's `execute` and `authorize` the plugin's deps as `ctx.deps`.
 * The config is changed in place: every way an action runs (HTTP, compiled
 * routes, `action.run`, RPC) reads `config.execute` from it. A nested
 * definePlugin binds its own actions first, so they keep its deps.
 *
 * @throws When the action is already bound to another install's deps: one
 * action object shared by two installs could only run with one of them.
 */
function bindPluginDeps(
  plugin: string,
  action: unknown,
  deps: Readonly<Record<string, unknown>>,
  started: number,
) {
  const config = (action as { config?: Record<string | symbol, any> }).config;
  if (!config) return;
  const bound = config[PLUGIN_DEPS] as
    | { deps: Readonly<Record<string, unknown>>; at: number }
    | undefined;
  if (bound) {
    if (bound.deps === deps || bound.at > started) return;
    throw new Error(
      `${plugin}: action "${(action as { name?: string }).name}" is already bound to the deps of another install; create the action inside the setup so each install gets its own`,
    );
  }
  config[PLUGIN_DEPS] = { deps, at: ++bindings };
  const { execute, authorize } = config;
  if (typeof execute === "function")
    config.execute = (args: { ctx?: object }) =>
      execute({ ...args, ctx: { ...args.ctx, deps } });
  if (typeof authorize === "function")
    config.authorize = (args: { ctx?: object }) =>
      authorize({ ...args, ctx: { ...args.ctx, deps } });
}

/** Check the deps passed at install against the ports the plugin declares. */
function checkDeps(
  plugin: string,
  factory: string,
  ports: Ports | undefined,
  given: unknown = {},
): Readonly<Record<string, unknown>> {
  if (given === null || typeof given !== "object" || Array.isArray(given))
    throw new Error(`${plugin}: deps must be an object`);
  const declared = Object.keys(ports ?? {});
  const provided = given as Record<string, unknown>;
  const extra = Object.keys(provided).filter((key) => !declared.includes(key));
  if (extra.length)
    throw new Error(
      `${plugin} does not declare ${extra.map((key) => `deps.${key}`).join(", ")}; ${
        declared.length ? `it takes ${declared.join(", ")}` : "it takes no deps"
      }`,
    );
  const missing = declared.filter((key) => provided[key] === undefined);
  if (missing.length)
    throw new Error(
      `${plugin} needs ${missing.map((key) => `deps.${key}`).join(", ")}; pass it when installing: ${factory}(options, { deps: { ${missing.join(", ")} } })`,
    );
  return Object.freeze(
    Object.fromEntries(declared.map((key) => [key, provided[key]])),
  );
}

function checkOptions(
  plugin: string,
  schema: TSchema | undefined,
  input: unknown,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error(`${plugin}: options must be an object`);
  if (!schema) {
    if (Object.keys(input).length)
      throw new Error(`${plugin} takes no options`);
    return {};
  }
  const value = Value.Default(schema, structuredClone(input));
  const result = validateWithSchema(schema, value);
  if (!result.success) {
    const [first] = result.errors;
    const option = first!.path.replace(/^\//, "").replaceAll("/", ".");
    throw new Error(
      `${plugin}: option ${option ? `"${option}"` : ""} ${first!.message}`.replace(
        /\s+/g,
        " ",
      ),
    );
  }
  return value as Record<string, unknown>;
}

// --------------------------------------------------------------- app part

/** A plugin as `app.definition.plugins` lists it. */
export interface InstalledPlugin {
  readonly name: string;
  readonly brick?: string;
  readonly scope: "app" | "service" | "resource";
  readonly service?: string;
  readonly resource?: string;
  /** The plugin's dashboard extension, an absolute path. */
  readonly dashboard?: string;
}

export function isPluginInstance(value: unknown): value is PluginInstance {
  return (
    typeof value === "object" &&
    value !== null &&
    INTERNALS in (value as object)
  );
}
function internalsOf(value: unknown): Internals | undefined {
  return isPluginInstance(value)
    ? ((value as unknown as Record<symbol, Internals>)[INTERNALS] ?? undefined)
    : undefined;
}

/**
 * What `brick()` does with plugins: install those given in `plugins` on the
 * app, run every plugin's `app` part in install order, and return the
 * lifecycle, middleware and listeners they contributed.
 */
export function setupAppPlugins(
  installedOnServices: readonly object[],
  appPlugins: readonly unknown[],
) {
  const instances = new Set<PluginInstance>();
  for (const descriptor of installedOnServices)
    if (isPluginInstance(descriptor)) instances.add(descriptor);
  const ordered = [...instances].sort(
    (a, b) => (internalsOf(a)!.order ?? 0) - (internalsOf(b)!.order ?? 0),
  );
  const onApp = new Set<string>();
  for (const plugin of appPlugins) {
    const internals = internalsOf(plugin);
    if (!internals)
      throw new Error(
        "brick({ plugins }) takes instances from definePlugin(), such as audit()",
      );
    const { manifest } = internals;
    if (!manifest.app || manifest.tables || manifest.events)
      throw new Error(
        `${manifest.name} cannot be installed on the app; ${
          manifest.resource ? "use resource.use()" : "use service.use()"
        }`,
      );
    for (const required of manifest.requires ?? [])
      if (!onApp.has(required))
        throw new Error(
          `${manifest.name} requires ${required}, installed in brick({ plugins }) before it`,
        );
    if (onApp.has(manifest.name))
      throw new Error(`Plugin ${manifest.name} is installed on the app twice`);
    // Its `app` part already runs from the service or resource install; running it again would double every hook.
    const installed = ordered.find(
      (other) => internalsOf(other)!.manifest.name === manifest.name,
    );
    if (installed)
      throw new Error(
        `Plugin ${manifest.name} is already installed with ${internalsOf(
          installed,
        )!
          .installs.map((install) =>
            install.scope === "resource"
              ? `${install.service}.${install.resource}.use()`
              : `${install.service}.use()`,
          )
          .join(
            ", ",
          )}, which runs its app part too; remove it from brick({ plugins })`,
      );
    onApp.add(manifest.name);
    if (!internals.installs.some((item) => item.scope === "app"))
      internals.installs.push({ scope: "app" });
    ordered.push(plugin as PluginInstance);
  }

  const lifecycles: Lifecycle[] = [];
  const middleware: ((context: any) => unknown)[] = [];
  const listeners: EventListener[] = [];
  const listed: InstalledPlugin[] = [];
  for (const plugin of ordered) {
    const { manifest, options, deps, installs, dashboard } =
      internalsOf(plugin)!;
    for (const install of installs)
      listed.push(
        Object.freeze({
          name: manifest.name,
          ...(manifest.brick ? { brick: manifest.brick } : {}),
          ...install,
          ...(dashboard ? { dashboard } : {}),
        }),
      );
    if (!manifest.app) continue;
    const lifecycle = { options, secrets: manifest.secrets ?? {}, deps };
    // A plugin's start and stop pair up, so stop runs only after its start did.
    const own = { start: [] as Function[], stop: [] as Function[] };
    manifest.app({
      ...lifecycle,
      on(event, handler) {
        if (event !== "start" && event !== "stop")
          throw new Error(`${manifest.name}: on() takes "start" or "stop"`);
        own[event].push(handler);
      },
      middleware(handler) {
        middleware.push(handler);
      },
      listeners(...items) {
        // `useDeps()` in a plugin's listener returns the plugin's deps, not the app's.
        listeners.push(
          ...items.map((listener) => {
            const run = listener.run;
            // The workflow runtime runs this workflow's steps with these deps.
            if (!run) return { ...listener, [PLUGIN_DEPS]: deps };
            return {
              ...listener,
              run: (delivery: Parameters<typeof run>[0]) =>
                runWithDeps(deps, () => run(delivery)),
            };
          }),
        );
      },
    });
    lifecycles.push({
      start: async () => {
        for (const handler of own.start) await handler(lifecycle);
      },
      stop: async () => {
        for (const handler of own.stop) await handler(lifecycle);
      },
    });
  }
  return { lifecycles, middleware, listeners, plugins: listed };
}

interface Lifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Start in install order. Stop what started, in reverse order; a start that
 * fails stops those before it and rethrows.
 */
export function pluginLifecycle(lifecycles: readonly Lifecycle[]) {
  let started: Promise<void> | undefined;
  const running: Lifecycle[] = [];
  const stopAll = async () => {
    const errors: unknown[] = [];
    for (const item of running.splice(0).reverse())
      try {
        await item.stop();
      } catch (error) {
        errors.push(error);
      }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(errors, "Plugins failed to stop");
  };
  return {
    start(): Promise<void> {
      return (started ??= (async () => {
        for (const item of lifecycles) {
          try {
            await item.start();
          } catch (error) {
            await stopAll().catch(() => undefined);
            started = undefined;
            throw error;
          }
          running.push(item);
        }
      })());
    },
    async stop(): Promise<void> {
      await started?.catch(() => undefined);
      started = undefined;
      await stopAll();
    },
  };
}
