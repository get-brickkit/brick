import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { getTableName, type Table } from "drizzle-orm";
import type { DepsOf, Ports } from "./deps";
import { actionMeta } from "./action-meta";
import { portOf } from "./service-port";
import type { EventCatalog, EventRef, EventRefs } from "./events/catalog";
import type { EventListener } from "./events/types";
import { hasPlugin, validateName } from "./plugin";
import {
  PLUGIN_KIND,
  PLUGIN_COMMIT,
  type PluginRouteRegistrar,
  type ResourcePlugin,
  type ServicePlugin,
} from "./plugin-types";
import {
  addHostHooks,
  HOOK_NAMES,
  type HostHooks,
  type PluginHooks,
} from "./plugin-hooks";
import {
  builders,
  setPluginOwner,
  type PluginTableBuilders,
} from "./plugin-tables";
import { brickVersion, satisfiesRange } from "./version";
import { INTERNALS, type Internals } from "./plugin-app";
import { definitionSite } from "./definition-site";
import type { SecretRef } from "./secrets";
import { validateWithSchema } from "./typebox";
import type { Action, BaseContext, Resource, Service } from "./types";

/*
 * definePlugin: one plugin with a manifest Brick checks (name, supported Brick
 * versions, required plugins, typed options, secrets) and a place for each
 * capability: owned tables, catalog events, host CRUD hooks, routes, and an
 * app part with start/stop lifecycle, middleware and listeners. Installing on
 * a service or resource reuses `installPlugin`, so route registration,
 * collision checks and rollback are the same as for the older two kinds.
 */

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
  /** The Brick versions it supports, as a semver range: `^0.12.0`. */
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
 *   brick: "^0.12.0",
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
  validateName(name);
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
    const setup = (context: {
      service: Service<any, any>;
      resource?: Resource<any, any, any>;
      routes: PluginRouteRegistrar<any>;
      [PLUGIN_COMMIT]?: (commit: () => void) => void;
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
          setPluginOwner(table, name);
          portOf(service).registerTable(table);
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
        claim: (segment) => context.routes.claim(segment),
      };
      const before = new Set<unknown>([
        ...service.listActions(),
        ...service.listTools(),
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
      // Every action and socket the setup added (its own, its resources', crud's) runs with the plugin's deps.
      for (const action of [...service.listActions(), ...service.listTools()])
        if (!before.has(action)) bindPluginDeps(name, action, deps, started);
      for (const socket of service.listSockets())
        if (!before.has(socket)) socket.deps ??= deps;

      context[PLUGIN_COMMIT]?.(() => {
        const database = service.getDatabaseHandle?.();
        for (const table of Object.values(tables))
          database?.addTable?.(getTableName(table), table);
        if (Object.keys(events).length)
          portOf(service).addEvents(
            Object.fromEntries(
              Object.entries(events).map(([key, ref]) => [
                `${eventSpace}.${key}`,
                ref,
              ]),
            ),
          );
        addHostHooks(host, added as HostHooks);
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
      [PLUGIN_KIND]: "plugin",
      name,
      info,
      setup,
      [INTERNALS]: internals,
    }) as unknown as PluginInstance<RA, SA>;
  };
  return Object.assign(factory, { info });
}

/** Counts bindings, so a setup can tell a nested install's from an earlier one's. */
let bindings = 0;
/**
 * Run an action with the plugin's deps as `ctx.deps`: context resolution
 * reads them from its metadata. A nested definePlugin binds its own actions
 * first, so they keep its deps.
 *
 * @throws When the action is already bound to another install's deps: one
 * action object shared by two installs could only run with one of them.
 */
function bindPluginDeps(
  plugin: string,
  action: Action<any, any, any, any>,
  deps: Readonly<Record<string, unknown>>,
  started: number,
) {
  const meta = actionMeta(action);
  if (meta.deps) {
    if (meta.deps.values === deps || meta.deps.at > started) return;
    throw new Error(
      `${plugin}: action "${action.name}" is already bound to the deps of another install; create the action inside the setup so each install gets its own`,
    );
  }
  meta.deps = { values: deps, at: ++bindings };
}

/** Check the deps passed at install against the ports the plugin declares. */
function checkDeps(
  plugin: string,
  /** The plugin's factory as the user imports it (its camelCase name), for the hint. */
  camelName: string,
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
      `${plugin} needs ${missing.map((key) => `deps.${key}`).join(", ")}; pass it when installing: ${camelName}(options, { deps: { ${missing.join(", ")} } })`,
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
