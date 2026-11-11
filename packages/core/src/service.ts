import { installPlugin, isInstallingPlugin } from "./plugin";
import type { ServicePlugin } from "./plugin-types";
import type { BunSQLiteDatabase } from "./db/sqlite";
import type {
  Service,
  ServiceOptions,
  Action,
  Tool,
  ActionErrorDefinition,
  ServiceSchema,
  BaseContext,
  Resource,
  PreparationContribution,
} from "./types";
import { defineTool, isTool } from "./tool";
import { defineAction } from "./action";
import { claimName, definitionSite } from "./definition-site";
import { getGlobalRegistry } from "./registry";
import { getTableName, isDatabaseHandle, type DatabaseHandle } from "./db";
import { checkRecordAccess, defineResource } from "./resource";
import { actionMeta } from "./action-meta";
import { actionOwners } from "./routes";
import type { ServicePort } from "./service-port";
import { isOutboxTable, type OutboxTable } from "./events/outbox";
import { isScheduleTable, type ScheduleTable } from "./schedules/table";
import type { ServiceEvents } from "./events/types";
import {
  checkEvent,
  eventRefs,
  type EventCatalog,
  type EventRef,
} from "./events/catalog";
import { getActionAccess } from "./access";
import { pluginOwner } from "./plugin-tables";
import { baseContext, pickContextEnvelope } from "./context";
import type { DepsOf, Ports } from "./deps";
import type { NamedService } from "./rpc";
import { defineServiceSocket } from "./socket";
import type {
  BrickSocketConfig,
  BrickSocketHandle,
  SocketPayloads,
  SocketSchemas,
  RegisteredSocket,
} from "./socket-types";

// Symbol to tie context resolution to a specific service instance and invocation
const RESOLVED_SYMBOL = Symbol("resolved");
/** The deps a resolved context was resolved with, to restore them when a plugin's copy comes back. */
const OWN_DEPS = Symbol("ownDeps");

// The public overloads of `action`, `tool` and `resource`; the class implements them once, untyped.
// Safe: the interface only adds signatures of methods the class defines.
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging
export interface ServiceImpl<
  TDb = BunSQLiteDatabase<Record<string, unknown>>,
  TServiceContext extends Record<string, any> = Record<string, any>,
> extends Pick<Service<TDb, TServiceContext>, "action" | "tool" | "resource"> {}
export class ServiceImpl<
  TDb = BunSQLiteDatabase<Record<string, unknown>>,
  TServiceContext extends Record<string, any> = Record<string, any>,
> implements ServicePort<TDb, TServiceContext> {
  readonly name: string;
  readonly options: ServiceOptions<TServiceContext, TDb>;
  private readonly actions = new Map<string, Action<any, any, any, any>>();
  private readonly tools = new Map<string, Tool<any, any, any, any>>();
  readonly tables = new Map<string, any>();
  private readonly sockets = new Map<string, RegisteredSocket>();
  private readonly resources = new Map<
    string,
    Resource<any, BaseContext<TDb> & TServiceContext>
  >();
  private readonly preparations = new Map<string, PreparationContribution>();
  /** Where each `kind:name` was defined, to reject duplicates from another file. */
  private readonly sites = new Map<string, string | undefined>();
  private database?: DatabaseHandle<TDb>;
  private _isBuilt = false;
  private _events: Readonly<Record<string, EventRef>>;
  /** What a write needs to record events. Set by `brick({ events })`. */
  recorder?: ServiceEvents;
  /** The values of this service's `deps`. Set by `brick({ deps })`. */
  deps?: Readonly<Record<string, unknown>>;

  constructor(
    name: string,
    options: ServiceOptions<TServiceContext, TDb> = {},
  ) {
    this.name = name;
    this.options = options;
    this._events = eventRefs(name, options.events);
    for (const key of Object.keys(this._events)) this.claim("event", key);
    if (options.database !== undefined && !isDatabaseHandle(options.database)) {
      throw new Error("Service database must be created with defineDatabase()");
    }
    this.database = options.database;
  }

  /** The declared events: `service.events.<name>`. */
  get events(): Readonly<Record<string, EventRef>> {
    return this._events;
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

  /** Every definition change passes here, so cached architecture and OpenAPI are rebuilt. */
  touch(): void {
    getGlobalRegistry().touch();
  }

  snapshot(): () => void {
    const maps = [
      this.actions,
      this.tools,
      this.tables,
      this.sockets,
      this.resources,
      this.preparations,
      this.sites,
    ] as Map<unknown, unknown>[];
    const saved = maps.map((map) => new Map(map));
    const events = this._events;
    const properties = new Map(
      [...this.resources.values()].map((item) => [
        item,
        Object.getOwnPropertyDescriptors(item),
      ]),
    );
    return () => {
      maps.forEach((map, index) => {
        map.clear();
        for (const [key, value] of saved[index]!) map.set(key, value);
      });
      this._events = events;
      for (const [item, own] of properties) {
        for (const key of Reflect.ownKeys(item))
          if (!Object.hasOwn(own, key)) Reflect.deleteProperty(item, key);
        Object.defineProperties(item, own);
      }
      this.touch();
    };
  }

  addEvents(refs: Readonly<Record<string, EventRef>>): void {
    this._events = Object.freeze({ ...this._events, ...refs });
    this.touch();
  }

  /**
   * Closes declarations after plugins have registered their actions and preparations.
   */
  build(): this {
    if (isInstallingPlugin(this))
      throw new Error("Cannot build a service during plugin setup");
    if (this._isBuilt) return this;
    for (const action of this.actions.values()) {
      const info = actionMeta(action).resourceAction;
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
    this.touch();
  }

  listPreparations(): PreparationContribution[] {
    return [...this.preparations.values()];
  }
  prepareContributions(): void {
    for (const contribution of this.preparations.values())
      contribution.prepare();
  }

  registerTable(table: any): this {
    this.tables.set(getTableName(table), table);
    this.touch();
    return this;
  }

  resource(config: any): any {
    if (this._isBuilt)
      throw new Error("Resources must be registered before service build");
    this.claim("resource", config.name);
    const resourceInstance = defineResource(this, config);
    this.resources.set(resourceInstance.name, resourceInstance as any);
    this.touch();
    return resourceInstance;
  }

  getResource(
    name: string,
  ): Resource<any, BaseContext<TDb> & TServiceContext> | undefined {
    return this.resources.get(name);
  }

  listResources(): Resource<any, BaseContext<TDb> & TServiceContext>[] {
    return Array.from(this.resources.values());
  }

  action(actionOrConfig: any): any {
    const isActionFunction =
      typeof actionOrConfig === "function" && "config" in actionOrConfig;
    const actionInstance: Action<any, any, any, any> = isActionFunction
      ? actionOrConfig
      : defineAction(actionOrConfig);

    if (this.actions.get(actionInstance.name) !== actionInstance)
      this.claim("action", actionInstance.name);
    if (isTool(actionInstance)) actionInstance.config.http = true;
    actionInstance.serviceName = this.name;
    actionMeta(actionInstance).service = this;
    this.actions.set(actionInstance.name, actionInstance);
    this.touch();
    return isActionFunction ? this : actionInstance;
  }

  tool(toolOrConfig: any): any {
    const existing = isTool(toolOrConfig);
    const tool = existing ? toolOrConfig : defineTool(toolOrConfig);
    this.claim("tool", tool.name);
    tool.serviceName = this.name;
    actionMeta(tool).service = this;
    this.tools.set(tool.name, tool);
    if (tool.config.http) this.action(tool);
    this.touch();
    return existing ? this : tool;
  }

  getTool(name: string): Tool<any, any, any, any> | undefined {
    return this.tools.get(name);
  }

  socket<
    const I extends SocketSchemas,
    const O extends SocketSchemas,
    const E extends Record<string, ActionErrorDefinition> = {},
  >(
    config: BrickSocketConfig<I, O, BaseContext<TDb> & TServiceContext, E>,
  ): BrickSocketHandle<SocketPayloads<O>> {
    if (this._isBuilt)
      throw new Error("Sockets must be declared before service build");
    this.claim("socket", config.name);
    const socket: RegisteredSocket = defineServiceSocket(
      this.name,
      config,
      (request) => resolveServiceContext(this, { request }, socket.deps),
    );
    this.sockets.set(config.name, socket);
    this.touch();
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

  getOutbox(): OutboxTable | undefined {
    return Object.values(this.database?.tables ?? {}).find(isOutboxTable);
  }

  getScheduleTable(): ScheduleTable | undefined {
    return Object.values(this.database?.tables ?? {}).find(isScheduleTable);
  }

  setRecorder(recorder: ServiceEvents | undefined): void {
    this.recorder = recorder;
  }

  get hasCatalog(): boolean {
    return this.options.events !== undefined;
  }

  /** @throws When the event is not in the catalog or its payload does not match. */
  checkEvent(name: string, payload: unknown): void {
    checkEvent(this, name, payload);
  }

  setDeps(deps: Readonly<Record<string, unknown>>): void {
    this.deps = deps;
  }

  setDb(database: DatabaseHandle<TDb>): void {
    if (!isDatabaseHandle(database))
      throw new Error("Use defineDatabase() to set a service database");
    this.database = database;
    this.touch();
  }

  /**
   * Resolves the complete service execution context once per incoming request.
   * Merges framework BaseContext with the service's custom context hook.
   * Always rebuilds context for this service to prevent caller context from overriding.
   */
  resolveContext(
    callCtx?: Partial<BaseContext<TDb> & TServiceContext>,
    pluginDeps?: Readonly<Record<string, unknown>>,
  ): Promise<BaseContext<TDb> & TServiceContext> {
    return resolveServiceContext(this, callCtx, pluginDeps);
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
          ...actionOwners(act),
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

/**
 * The context of a call to one of the service's actions or sockets. The one
 * rule for which deps it sees: those of the plugin install that created the
 * action or socket (`pluginDeps`), else the service's own. The service's
 * `context` hook always sees the service's own.
 */
async function resolveServiceContext<
  TDb,
  TServiceContext extends Record<string, any>,
>(
  service: ServiceImpl<TDb, TServiceContext>,
  callCtx?: Partial<BaseContext<TDb>> & { user?: unknown },
  pluginDeps?: Readonly<Record<string, unknown>>,
): Promise<BaseContext<TDb> & TServiceContext> {
  // Only a context this service resolved itself is accepted as it is.
  if ((callCtx as any)?.[RESOLVED_SYMBOL] === service) {
    const deps = pluginDeps ?? (callCtx as any)[OWN_DEPS];
    return (
      (callCtx as { deps?: unknown }).deps === deps
        ? callCtx
        : { ...callCtx, deps }
    ) as BaseContext<TDb> & TServiceContext;
  }
  const framework = baseContext({
    request: callCtx?.request,
    // Always this service's own database, never the caller's.
    db: service.getDb(),
    logger: callCtx?.logger,
    traceId: callCtx?.traceId,
    requestId: callCtx?.requestId,
    services: callCtx?.services,
    metadata: callCtx?.metadata,
    // The app's deps for this service; a direct call with no app (a unit test) may pass its own,
    // but never those of a context another service (or a plugin) resolved.
    deps:
      service.deps ??
      ((callCtx as any)?.[RESOLVED_SYMBOL]
        ? undefined
        : (callCtx as { deps?: Readonly<Record<string, unknown>> } | undefined)
            ?.deps),
  });
  const fullBaseCtx: BaseContext<TDb> = {
    ...framework,
    ...pickContextEnvelope(callCtx),
  };

  const resolvedExtra = service.options.context
    ? await service.options.context(fullBaseCtx)
    : {};
  const finalCtx: any = {
    ...fullBaseCtx,
    ...resolvedExtra,
    deps: pluginDeps ?? framework.deps,
    [RESOLVED_SYMBOL]: service,
    [OWN_DEPS]: framework.deps,
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
