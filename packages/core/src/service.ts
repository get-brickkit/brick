import {
  installPlugin,
  isInstallingPlugin,
  type ServicePlugin,
} from "./plugin";
import type { TSchema } from "@sinclair/typebox";
import type { BunSQLiteDatabase } from "./db/sqlite";
import type {
  Service,
  ServiceOptions,
  Action,
  Tool,
  ToolConfigWithAuthorize,
  ToolConfigWithoutAuthorize,
  ActionConfigWithAuthorize,
  ActionConfigWithoutAuthorize,
  ActionErrorDefinition,
  ServiceSchema,
  BaseContext,
  Logger,
  Resource,
  ResourceConfig,
  ResourceTypeOptions,
  ResourceIdentity,
  PreparationContribution,
} from "./types";
import { defineTool, isTool } from "./tool";
import { defineAction } from "./action";
import { claimName, definitionSite, getGlobalRegistry } from "./registry";
import { getTableName, isDatabaseHandle, type DatabaseHandle } from "./db";
import { checkRecordAccess, defineResource } from "./resource";
import type { ResourceActionInfo } from "./routes";
import { isOutboxTable, type OutboxTable } from "./events/outbox";
import type { ServiceEvents } from "./events/types";
import {
  checkEvent,
  eventRefs,
  type EventCatalog,
  type EventRef,
} from "./events/catalog";
import { getActionAccess } from "./access";
import { pluginOwner } from "./define-plugin";
import { pickContextEnvelope } from "./context";
import { PLUGIN_DEPS, type DepsOf, type Ports } from "./deps";
import type { NamedService } from "./rpc";
import { createLogger, DEFAULT_LOG_PREFIXES } from "./logger";
import { defineServiceSocket, type RegisteredSocket } from "./socket";
import type {
  BrickSocketConfig,
  BrickSocketHandle,
  SocketPayloads,
  SocketSchemas,
} from "./socket-types";

const defaultLogger: Logger = createLogger(DEFAULT_LOG_PREFIXES);

const DEFAULT_REQUEST = new Request("http://localhost");
const EMPTY_SERVICES = Object.freeze({});
const EMPTY_METADATA = Object.freeze({});
const EMPTY_DEPS = Object.freeze({});
let _ctxSeq = 0;

// Symbol to tie context resolution to a specific service instance and invocation
const RESOLVED_SYMBOL = Symbol("resolved");
/** The deps a resolved context was resolved with, to restore them when a plugin's copy comes back. */
const OWN_DEPS = Symbol("ownDeps");

export class ServiceImpl<
  TDb = BunSQLiteDatabase<Record<string, unknown>>,
  TServiceContext extends Record<string, any> = Record<string, any>,
> implements Service<TDb, TServiceContext> {
  readonly name: string;
  readonly options: ServiceOptions<TServiceContext, TDb>;
  readonly actions = new Map<string, Action<any, any, any, any>>();
  readonly tools = new Map<string, Tool<any, any, any, any>>();
  readonly tables = new Map<string, any>();
  private readonly sockets = new Map<string, RegisteredSocket>();
  readonly resources = new Map<
    string,
    Resource<any, BaseContext<TDb> & TServiceContext>
  >();
  readonly preparations = new Map<string, PreparationContribution>();
  /** Where each `kind:name` was defined, to reject duplicates from another file. */
  private readonly sites = new Map<string, string | undefined>();
  private database?: DatabaseHandle<TDb>;
  private _isBuilt = false;
  /** The declared events: `service.events.<name>`. */
  readonly events: Readonly<Record<string, EventRef>>;

  constructor(
    name: string,
    options: ServiceOptions<TServiceContext, TDb> = {},
  ) {
    this.name = name;
    this.options = options;
    this.events = eventRefs(name, options.events);
    for (const key of Object.keys(this.events)) this.claim("event", key);
    if (options.database !== undefined && !isDatabaseHandle(options.database)) {
      throw new Error("Service database must be created with defineDatabase()");
    }
    this.database = options.database;
  }

  use<A>(plugin: ServicePlugin<this, A>): A {
    return installPlugin(this, undefined, plugin) as A;
  }

  get db(): TDb | undefined {
    return this.getDb();
  }

  get isBuilt(): boolean {
    return this._isBuilt;
  }

  /**
   * Closes declarations after plugins have registered their actions and preparations.
   */
  build(): this {
    if (isInstallingPlugin(this))
      throw new Error("Cannot build a service during plugin setup");
    if (this._isBuilt) return this;
    for (const action of this.actions.values()) {
      const info = (action as { resourceAction?: ResourceActionInfo })
        .resourceAction;
      const resource = info?.record && this.resources.get(info.resource);
      if (resource) checkRecordAccess(resource, info);
    }
    this._isBuilt = true;
    return this;
  }

  private claim(kind: string, name: string): void {
    claimName(
      this.sites,
      `${kind} "${name}" in service "${this.name}"`,
      `${kind}:${name}`,
      definitionSite(),
    );
  }

  contributePreparation(contribution: PreparationContribution): void {
    if (this._isBuilt)
      throw new Error("Preparations must be registered before service build");
    if (this.preparations.has(contribution.name))
      throw new Error(`Duplicate preparation '${contribution.name}'`);
    this.preparations.set(contribution.name, contribution);
    getGlobalRegistry().touch();
  }

  listPreparations(): PreparationContribution[] {
    return [...this.preparations.values()];
  }
  prepareContributions(): void {
    for (const contribution of this.preparations.values())
      contribution.prepare();
  }

  registerTable(table: any): this {
    try {
      const tableName = getTableName(table);
      this.tables.set(tableName, table);
    } catch {
      const fallbackName =
        (table as any)._?.name ?? `table_${this.tables.size + 1}`;
      this.tables.set(fallbackName, table);
    }

    return this;
  }

  // The public signature preserves config literals; runtime registration stores
  // resources with different tables in the same map.
  resource = <
    TTable = any,
    const TOptions extends ResourceTypeOptions = ResourceTypeOptions,
  >(
    config: ResourceConfig<TTable, BaseContext<TDb> & TServiceContext> &
      TOptions &
      Record<Exclude<keyof TOptions, keyof ResourceConfig>, never>,
  ): Resource<
    TTable,
    BaseContext<TDb> & TServiceContext,
    ResourceIdentity<TTable, TOptions>
  > => {
    if (this._isBuilt)
      throw new Error("Resources must be registered before service build");
    this.claim("resource", config.name);
    const resourceInstance = defineResource(this, config);
    this.resources.set(resourceInstance.name, resourceInstance);
    getGlobalRegistry().touch();
    return resourceInstance as Resource<
      TTable,
      BaseContext<TDb> & TServiceContext,
      ResourceIdentity<TTable, TOptions>
    >;
  };

  getResource(
    name: string,
  ): Resource<any, BaseContext<TDb> & TServiceContext> | undefined {
    return this.resources.get(name);
  }

  listResources(): Resource<any, BaseContext<TDb> & TServiceContext>[] {
    return Array.from(this.resources.values());
  }

  action<
    TIn extends TSchema | undefined = undefined,
    TOut extends TSchema | undefined = undefined,
    TErr extends Record<string, ActionErrorDefinition> = Record<
      string,
      ActionErrorDefinition
    >,
  >(action: Action<TIn, TOut, TErr, BaseContext<TDb> & TServiceContext>): this;
  action<
    TIn extends TSchema | undefined = undefined,
    TOut extends TSchema | undefined = undefined,
    TErr extends Record<string, ActionErrorDefinition> = Record<
      string,
      ActionErrorDefinition
    >,
  >(
    config: ActionConfigWithAuthorize<
      TIn,
      TOut,
      TErr,
      BaseContext<TDb> & TServiceContext
    >,
  ): Action<TIn, TOut, TErr, BaseContext<TDb> & TServiceContext>;
  action<
    TIn extends TSchema | undefined = undefined,
    TOut extends TSchema | undefined = undefined,
    TErr extends Record<string, ActionErrorDefinition> = Record<
      string,
      ActionErrorDefinition
    >,
  >(
    config: ActionConfigWithoutAuthorize<
      TIn,
      TOut,
      TErr,
      BaseContext<TDb> & TServiceContext
    >,
  ): Action<TIn, TOut, TErr, BaseContext<TDb> & TServiceContext>;
  action(actionOrConfig: any): any {
    let actionInstance: Action<any, any, any, any>;
    const isActionFunction =
      typeof actionOrConfig === "function" && "config" in actionOrConfig;

    if (isActionFunction) {
      actionInstance = actionOrConfig;
    } else {
      actionInstance = defineAction(actionOrConfig);
    }

    if (
      isInstallingPlugin(this) &&
      this.actions.has(actionInstance.name) &&
      this.actions.get(actionInstance.name) !== actionInstance
    )
      throw new Error(`Duplicate plugin action: ${actionInstance.name}`);
    if (this.actions.get(actionInstance.name) !== actionInstance)
      this.claim("action", actionInstance.name);
    if (isTool(actionInstance)) actionInstance.config.http = true;
    actionInstance.serviceName = this.name;
    (actionInstance as any).service = this;
    this.actions.set(actionInstance.name, actionInstance);
    getGlobalRegistry().touch();

    if (isActionFunction) {
      return this;
    }
    return actionInstance;
  }

  tool<
    TIn extends TSchema | undefined = undefined,
    TOut extends TSchema | undefined = undefined,
    TErr extends Record<string, ActionErrorDefinition> = Record<
      string,
      ActionErrorDefinition
    >,
  >(action: Tool<TIn, TOut, TErr, BaseContext<TDb> & TServiceContext>): this;
  tool<
    TIn extends TSchema | undefined = undefined,
    TOut extends TSchema | undefined = undefined,
    TErr extends Record<string, ActionErrorDefinition> = Record<
      string,
      ActionErrorDefinition
    >,
  >(
    config: ToolConfigWithAuthorize<
      TIn,
      TOut,
      TErr,
      BaseContext<TDb> & TServiceContext
    >,
  ): Tool<TIn, TOut, TErr, BaseContext<TDb> & TServiceContext>;
  tool<
    TIn extends TSchema | undefined = undefined,
    TOut extends TSchema | undefined = undefined,
    TErr extends Record<string, ActionErrorDefinition> = Record<
      string,
      ActionErrorDefinition
    >,
  >(
    config: ToolConfigWithoutAuthorize<
      TIn,
      TOut,
      TErr,
      BaseContext<TDb> & TServiceContext
    >,
  ): Tool<TIn, TOut, TErr, BaseContext<TDb> & TServiceContext>;
  tool(toolOrConfig: any): any {
    const existing = isTool(toolOrConfig);
    const tool = existing ? toolOrConfig : defineTool(toolOrConfig);
    this.claim("tool", tool.name);
    tool.serviceName = this.name;
    (tool as any).service = this;
    this.tools.set(tool.name, tool);
    if (tool.config.http) this.action(tool);
    getGlobalRegistry().touch();
    return existing ? this : tool;
  }

  getTool(name: string): Tool<any, any, any, any> | undefined {
    return this.tools.get(name);
  }

  socket<const I extends SocketSchemas, const O extends SocketSchemas>(
    config: BrickSocketConfig<I, O, BaseContext<TDb> & TServiceContext>,
  ): BrickSocketHandle<SocketPayloads<O>> {
    if (this._isBuilt)
      throw new Error("Sockets must be declared before service build");
    this.claim("socket", config.name);
    const socket: RegisteredSocket = defineServiceSocket(
      this.name,
      config,
      async (request) => {
        const ctx = await resolveServiceContext(this, { request });
        // A socket a plugin declared runs with the plugin's deps.
        const deps = (socket as unknown as Record<symbol, unknown>)[
          PLUGIN_DEPS
        ];
        return deps ? { ...ctx, deps } : ctx;
      },
    );
    this.sockets.set(config.name, socket);
    getGlobalRegistry().touch();
    return socket.handle;
  }

  listSockets(): RegisteredSocket[] {
    return [...this.sockets.values()];
  }

  listTools(): Tool<any, any, any, any>[] {
    return Array.from(this.tools.values());
  }

  getAction(name: string): Action<any, any, any, any> | undefined {
    return this.actions.get(name);
  }

  listActions(): Action<any, any, any, any>[] {
    return Array.from(new Set(this.actions.values()));
  }

  getDb(): TDb | undefined {
    return this.database?.getDb();
  }

  /** The handle from `defineDatabase`, without connecting. */
  getDatabaseHandle(): DatabaseHandle<TDb> | undefined {
    return this.database;
  }

  /** What a write needs to record events. Set by `brick({ events })`. */
  recorder?: ServiceEvents;

  getOutbox(): OutboxTable | undefined {
    return Object.values(this.database?.tables ?? {}).find(isOutboxTable);
  }

  setRecorder(recorder: ServiceEvents | undefined): void {
    this.recorder = recorder;
  }

  /** Whether the service declares an event catalog. */
  get hasCatalog(): boolean {
    return this.options.events !== undefined;
  }

  /** @throws When the event is not in the catalog or its payload does not match. */
  checkEvent(name: string, payload: unknown): void {
    checkEvent(this, name, payload);
  }

  /** The values of this service's `deps`. Set by `brick({ deps })`. */
  deps?: Readonly<Record<string, unknown>>;

  setDeps(deps: Readonly<Record<string, unknown>>): void {
    this.deps = deps;
  }

  setDb(database: DatabaseHandle<TDb>): void {
    if (!isDatabaseHandle(database))
      throw new Error("Use defineDatabase() to set a service database");
    this.database = database;
    getGlobalRegistry().touch();
  }

  /**
   * Resolves the complete service execution context once per incoming request.
   * Merges framework BaseContext with the service's custom context hook.
   * Always rebuilds context for this service to prevent caller context from overriding.
   */
  resolveContext(
    callCtx?: Partial<BaseContext<TDb> & TServiceContext>,
  ): Promise<BaseContext<TDb> & TServiceContext> {
    return resolveServiceContext(this, callCtx);
  }

  introspect(): ServiceSchema {
    const databaseConfig = this.database
      ? {
          name: this.database.name,
          engine: this.database.engine,
          tables: Object.keys(this.database.tables),
          ...pluginTables(this.database.tables),
        }
      : undefined;
    // The schema is data. A function among the options (such as `context`)
    // cannot cross to the dev dashboard: structured clone
    // refuses the whole architecture. JSON keeps the data and drops the rest.
    const { database: _database, events: _events, ...config } = this.options;
    const options: ServiceSchema["options"] = JSON.parse(
      JSON.stringify(config),
    );
    return {
      name: this.name,
      options,
      hasDatabase: Boolean(this.database),
      sockets: this.listSockets().map((socket) => socket.schema),
      databaseConfig,
      actions: this.listActions().map((act) => {
        const access = getActionAccess(act);
        return {
          name: act.name,
          serviceName: this.name,
          ...((act as { plugin?: string }).plugin
            ? { plugin: (act as { plugin?: string }).plugin }
            : {}),
          ...((act as { resource?: string }).resource
            ? { resource: (act as { resource?: string }).resource }
            : {}),
          description: act.config.description,
          inputSchema: act.config.input,
          outputSchema: act.config.output,
          hasAuthorize: access.hasAuthorize,
          hasScope: access.hasScope,
          accessPolicy: access.policy,
          errors: act.config.errors,
          emits: act.config.emits,
          tags: act.config.tags,
        };
      }),
      tools: this.listTools().map((tool) => ({ name: tool.name })),
      ...(this.hasCatalog || Object.keys(this.events).length
        ? {
            events: Object.values(this.events).map((ref) => ({
              name: ref.name,
              schema: JSON.parse(JSON.stringify(ref.schema)),
              ...(ref.plugin ? { plugin: ref.plugin } : {}),
            })),
          }
        : {}),
      resources: this.listResources().map((res) => ({
        name: res.name,
      })),
    };
  }
}

/** `plugins`: which plugin owns each table it contributed, by table key. */
function pluginTables(tables: Record<string, unknown>) {
  const owners = Object.entries(tables).flatMap(([key, table]) => {
    const plugin = pluginOwner(table);
    return plugin ? [[key, plugin] as const] : [];
  });
  return owners.length ? { plugins: Object.fromEntries(owners) } : {};
}

async function resolveServiceContext<
  TDb,
  TServiceContext extends Record<string, any>,
>(
  service: ServiceImpl<TDb, TServiceContext>,
  callCtx?: Partial<BaseContext<TDb>> & { user?: unknown },
): Promise<BaseContext<TDb> & TServiceContext> {
  // Only a context this service resolved itself is accepted as it is.
  if ((callCtx as any)?.[RESOLVED_SYMBOL] === service) {
    // A plugin action's copy carries the plugin's deps; this service's own actions get their own back.
    const own = (callCtx as any)[OWN_DEPS];
    return (
      (callCtx as { deps?: unknown }).deps === own
        ? callCtx
        : { ...callCtx, deps: own }
    ) as BaseContext<TDb> & TServiceContext;
  }
  const seq = ++_ctxSeq;
  const req = callCtx?.request ?? DEFAULT_REQUEST;
  // Always use this service's own database, never the caller's
  const db = service.getDb() as TDb;
  const logger = callCtx?.logger ?? defaultLogger;
  const traceId = callCtx?.traceId ?? `tr_${seq.toString(36)}`;
  const requestId = callCtx?.requestId ?? `req_${seq.toString(36)}`;
  const services = callCtx?.services ?? EMPTY_SERVICES;
  const metadata = callCtx?.metadata ?? EMPTY_METADATA;
  // The app's deps for this service; a direct call with no app (a unit test) may pass its own,
  // but never those of a context another service (or a plugin) resolved.
  const deps =
    service.deps ??
    ((callCtx as any)?.[RESOLVED_SYMBOL]
      ? undefined
      : (callCtx as { deps?: unknown } | undefined)?.deps) ??
    EMPTY_DEPS;

  const fullBaseCtx: BaseContext<TDb> = {
    request: req,
    db,
    logger,
    traceId,
    requestId,
    services,
    metadata,
    // Only the envelope fields a caller may set, never the framework's own.
    ...pickContextEnvelope(callCtx),
  };

  const resolvedExtra = service.options.context
    ? await service.options.context(fullBaseCtx)
    : {};
  const finalCtx: any = {
    ...fullBaseCtx,
    ...resolvedExtra,
    deps,
    [RESOLVED_SYMBOL]: service,
    [OWN_DEPS]: deps,
  };
  return finalCtx;
}

/**
 * Declare a service: a named group of actions, tools, and resources with its own
 * database and request context. It is registered globally, so `brick()`, the
 * OpenAPI generator, and `useService` find it by name.
 *
 * Add actions with `service.action(...)`, tools with `service.tool(...)`,
 * resources with `service.resource(...)`, and plugins with `service.use(...)`.
 *
 * @param name - Unique name. It is the service's segment of every action route
 * (`/api/<name>/<action>`) and appears in OpenAPI and the dashboard. Defining it
 * again from the same file (a dev reload) replaces it; from another file throws.
 * @param options - `database` (a handle from `defineDatabase`), `deps` (typed
 * slots from `port<T>()` that `brick({ deps })` fills, read as `ctx.deps`),
 * `context` (adds fields such as the signed-in user to every action's `ctx`),
 * `events` (the event catalog: a payload schema per event name, recorded as
 * `<service>.<name>` and offered as `service.events.<name>`).
 * @returns The service.
 * @example
 * import { defineDatabase, defineService, t } from "@brickkit/core";
 *
 * const database = defineDatabase({ tables: { pages } });
 *
 * export const pagesService = defineService("pages", {
 *   database,
 *   // Added to `ctx` in every action of this service.
 *   context: async ({ request }) => ({ user: await readUser(request) }),
 * });
 *
 * pagesService.action({
 *   name: "list",
 *   input: t.Object({ limit: t.Optional(t.Number()) }),
 *   output: t.Array(t.Object({ id: t.String(), title: t.String() })),
 *   execute: ({ input, ctx }) =>
 *     ctx.db.select().from(pages).limit(input.limit ?? 20),
 * });
 */
export function defineService<
  TDb = BunSQLiteDatabase<Record<string, unknown>>,
  TServiceContext extends Record<string, any> = Record<string, any>,
  const TEvents extends EventCatalog = {},
  const TName extends string = string,
  TPorts extends Ports = {},
>(
  name: TName,
  options?: ServiceOptions<TServiceContext, TDb> & {
    events?: TEvents;
    deps?: TPorts;
  },
): Service<
  TDb,
  {} extends TPorts
    ? TServiceContext
    : TServiceContext & { deps: DepsOf<TPorts> },
  TEvents
> &
  NamedService<TName> {
  const service = new ServiceImpl<TDb, TServiceContext>(name, options);
  getGlobalRegistry().register(service as any);
  return service as any;
}
