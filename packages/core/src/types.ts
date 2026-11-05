import type {
  InstalledPlugin,
  ResourcePlugin,
  ResourcePluginAPI,
  ServicePlugin,
} from "./plugin-types";
import type {
  TSchema,
  Static,
  TIntersect,
  TObject,
  TNumber,
  TString,
  TUnion,
} from "@sinclair/typebox";
import type { BunSQLiteDatabase } from "./db/sqlite";
import type { DatabaseHandle } from "./db/define";
import type { Ports } from "./deps";
import type { HttpMethod } from "./http";
import type { StandardErrorCode } from "./protocol";
import type { ServiceEvents } from "./events/types";
import type { EventCatalog, EventRefs } from "./events/catalog";
import type { EventsDefinition } from "./events/hub";
import type {
  BrickSocketConfig,
  BrickSocketHandle,
  BrickSocketSchema,
  SocketPayloads,
  SocketSchemas,
  RegisteredSocket,
} from "./socket-types";

/**
 * The logger on action, tool, and endpoint contexts. While a dashboard is on
 * (`brick dev`, or `brick start` with the `dashboard` option) a line logged
 * during a traced request appears in the dashboard with that request, instead
 * of on the console (as does a plain `console.log`); anywhere else it prints
 * to the console.
 */
export interface Logger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug: (...args: any[]) => void;
}

/**
 * Base framework context supplied to all service resolvers and action executions.
 */
export interface BaseContext<TDb = any> {
  request: Request;
  db: TDb;
  logger: Logger;
  traceId: string;
  requestId?: string;
  caller?: string;
  tenantId?: string;
  services?: Record<string, any>;
  metadata?: Record<string, unknown>;
}

/**
 * Default fallback service context for untyped or simple services.
 */
export interface DefaultServiceContext {
  user?: any;
  session?: any;
  [key: string]: any;
}

/**
 * The combined execution context: BaseContext & TServiceContext.
 */
export type ActionContext<
  TDb = any,
  TServiceContext = DefaultServiceContext,
> = BaseContext<TDb> & TServiceContext;

/**
 * Type utility that automatically narrows ctx.user from User | null to User
 * in execute() when authorize() is declared on the action.
 */
export type NarrowAuthorizedContext<TCtx> = TCtx extends { user: infer U }
  ? [U] extends [null | undefined]
    ? TCtx
    : Omit<TCtx, "user"> & { user: NonNullable<U> }
  : TCtx;

export interface ActionErrorDefinition {
  status?: number;
  message: string;
  /** Schema of the `details` the error carries. Checked in types only, not at runtime. */
  details?: TSchema;
}

/** The `details` type of a declared error: its schema's type, or `unknown` when it has none. */
export type ErrorDetails<TDef> = TDef extends {
  details: infer D extends TSchema;
}
  ? Static<D>
  : unknown;

export interface ValidationErrorItem {
  path: string;
  message: string;
  value?: unknown;
  type?: number;
}

export class ValidationError extends Error {
  readonly code = "VALIDATION_FAILED";
  readonly status: number;
  readonly errors: ValidationErrorItem[];

  constructor(
    message: string,
    errors: ValidationErrorItem[] = [],
    status = 400,
  ) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
    this.errors = errors;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      errors: this.errors,
    };
  }
}

export class ActionExecutionError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: string,
    message: string,
    status = 400,
    details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ActionExecutionError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
    };
  }
}

export interface StandardErrorMap {
  BAD_REQUEST: (
    overrideMessage?: string,
    details?: unknown,
    options?: ErrorOptions,
  ) => never;
  UNAUTHORIZED: (
    overrideMessage?: string,
    details?: unknown,
    options?: ErrorOptions,
  ) => never;
  FORBIDDEN: (
    overrideMessage?: string,
    details?: unknown,
    options?: ErrorOptions,
  ) => never;
  NOT_FOUND: (
    overrideMessage?: string,
    details?: unknown,
    options?: ErrorOptions,
  ) => never;
  CONFLICT: (
    overrideMessage?: string,
    details?: unknown,
    options?: ErrorOptions,
  ) => never;
  INTERNAL_SERVER_ERROR: (
    overrideMessage?: string,
    details?: unknown,
    options?: ErrorOptions,
  ) => never;
  [key: string]:
    | ((
        overrideMessage?: string,
        details?: unknown,
        options?: ErrorOptions,
      ) => never)
    | undefined;
}

export type ErrorBuilder<
  TErrors extends Record<string, ActionErrorDefinition>,
> = StandardErrorMap & {
  [K in keyof TErrors]: TErrors[K] extends { details: TSchema }
    ? (
        overrideMessage: string | undefined,
        details: ErrorDetails<TErrors[K]>,
        options?: ErrorOptions,
      ) => never
    : (
        overrideMessage?: string,
        details?: unknown,
        options?: ErrorOptions,
      ) => never;
};

export interface BaseActionConfig<
  TInputSchema extends TSchema | undefined = undefined,
  TOutputSchema extends TSchema | undefined = undefined,
  TErrors extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
> {
  name: string;
  description?: string;
  /**
   * HTTP path relative to the action's owner (`/api/<service>` for a service
   * action, `/api/<service>/<resource>` for a resource action); replaces the
   * default `/<action>` segment. Path parameters (`/:id/summary`) are merged
   * into the input.
   */
  path?: string;
  /** Single HTTP method exposed for this action (default POST). */
  method?: HttpMethod;
  input?: TInputSchema;
  output?: TOutputSchema;
  errors?: TErrors;
  emits?: string[];
  tags?: string[];
}

export interface ActionConfigWithAuthorize<
  TInputSchema extends TSchema | undefined = undefined,
  TOutputSchema extends TSchema | undefined = undefined,
  TErrors extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  TContext extends ActionContext = ActionContext,
> extends BaseActionConfig<TInputSchema, TOutputSchema, TErrors> {
  authorize: (params: {
    user?: TContext extends { user: infer U } ? U : any;
    input: TInputSchema extends TSchema ? Static<TInputSchema> : any;
    ctx: TContext;
  }) => boolean | Promise<boolean>;
  execute: (params: {
    input: TInputSchema extends TSchema ? Static<TInputSchema> : any;
    ctx: NarrowAuthorizedContext<TContext>;
    error: ErrorBuilder<TErrors>;
  }) =>
    | Promise<TOutputSchema extends TSchema ? Static<TOutputSchema> : any>
    | (TOutputSchema extends TSchema ? Static<TOutputSchema> : any);
}

export interface ActionConfigWithoutAuthorize<
  TInputSchema extends TSchema | undefined = undefined,
  TOutputSchema extends TSchema | undefined = undefined,
  TErrors extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  TContext extends ActionContext = ActionContext,
> extends BaseActionConfig<TInputSchema, TOutputSchema, TErrors> {
  authorize?: undefined;
  execute: (params: {
    input: TInputSchema extends TSchema ? Static<TInputSchema> : any;
    ctx: TContext;
    error: ErrorBuilder<TErrors>;
  }) =>
    | Promise<TOutputSchema extends TSchema ? Static<TOutputSchema> : any>
    | (TOutputSchema extends TSchema ? Static<TOutputSchema> : any);
}

export type ActionConfig<
  TInputSchema extends TSchema | undefined = any,
  TOutputSchema extends TSchema | undefined = any,
  TErrors extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  TContext extends ActionContext = ActionContext,
> =
  | ActionConfigWithAuthorize<TInputSchema, TOutputSchema, TErrors, TContext>
  | ActionConfigWithoutAuthorize<
      TInputSchema,
      TOutputSchema,
      TErrors,
      TContext
    >;

export interface Action<
  TInputSchema extends TSchema | undefined = any,
  TOutputSchema extends TSchema | undefined = any,
  TErrors extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  TContext extends ActionContext = ActionContext,
> {
  (params: {
    input?: TInputSchema extends TSchema ? Static<TInputSchema> : any;
    ctx?: Partial<TContext>;
  }): Promise<TOutputSchema extends TSchema ? Static<TOutputSchema> : any>;

  name: string;
  serviceName?: string;
  config: ActionConfig<TInputSchema, TOutputSchema, TErrors, TContext>;
  /**
   * Optional runtime-only output schema. When present, `validateOutput` and
   * HTTP output checking validate against it instead of `config.output`,
   * while `config.output` remains the published contract (client types,
   * OpenAPI). Lets projected/subset responses validate at runtime without
   * leaking optionality into the generated contract.
   */
  outputValidationSchema?: TSchema;
  run(
    input?: TInputSchema extends TSchema ? Static<TInputSchema> : any,
    ctx?: Partial<TContext>,
  ): Promise<TOutputSchema extends TSchema ? Static<TOutputSchema> : any>;
  execute(params: {
    input?: TInputSchema extends TSchema ? Static<TInputSchema> : any;
    ctx?: Partial<TContext>;
  }): Promise<TOutputSchema extends TSchema ? Static<TOutputSchema> : any>;
  validateInput(
    input: unknown,
  ):
    | { success: true; data: any }
    | { success: false; errors: ValidationErrorItem[] };
  validateOutput(
    output: unknown,
  ):
    | { success: true; data: any }
    | { success: false; errors: ValidationErrorItem[] };
  errorHelpers?: ErrorBuilder<TErrors>;
}

/** MCP tool metadata, kept with the executable definition. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}
export interface ToolOptions {
  title?: string;
  annotations?: ToolAnnotations;
  /** Also register HTTP routes and OpenAPI. Defaults to false. */
  http?: boolean;
}
export type ToolConfigWithAuthorize<
  I extends TSchema | undefined = undefined,
  O extends TSchema | undefined = undefined,
  E extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  C extends ActionContext = ActionContext,
> = ActionConfigWithAuthorize<I, O, E, C> & ToolOptions;
export type ToolConfigWithoutAuthorize<
  I extends TSchema | undefined = undefined,
  O extends TSchema | undefined = undefined,
  E extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  C extends ActionContext = ActionContext,
> = ActionConfigWithoutAuthorize<I, O, E, C> & ToolOptions;
export interface Tool<
  I extends TSchema | undefined = any,
  O extends TSchema | undefined = any,
  E extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  C extends ActionContext = ActionContext,
> extends Action<I, O, E, C> {
  readonly kind: "tool";
  config:
    | ToolConfigWithAuthorize<I, O, E, C>
    | ToolConfigWithoutAuthorize<I, O, E, C>;
}

/** A resource declares identity and a table; plugins supply behavior. */
export interface ResourceConfig<TTable = any, _TCtx = any> {
  name: string;
  table: TTable;
  id?: import("drizzle-orm").Column;
  /**
   * Child tables of this resource, by name. A command can load them with its
   * row (`load: { children: ["items"] }`) and insert, update and delete their
   * rows in the same transaction.
   */
  children?: Record<string, ResourceChild>;
}

/** A child table: rows that belong to one row of their resource. */
export interface ResourceChild<TTable = any> {
  table: TTable;
  /** The child's column that holds the parent row's id. */
  parent: import("drizzle-orm").Column;
  /** The child's id column. Defaults to its single primary key. */
  id?: import("drizzle-orm").Column;
}

export type InferTableRow<TTable> = TTable extends { $inferSelect: infer S }
  ? S
  : any;
export type InferTableInsert<TTable> = TTable extends { $inferInsert: infer S }
  ? S
  : any;
export type ResourceTypeOptions = Pick<
  ResourceConfig,
  "name" | "id" | "children"
>;

type PrimaryColumn<T> = T extends { _: { columns: infer C } }
  ? {
      [K in keyof C]: C[K] extends { _: { isPrimaryKey: true } } ? C[K] : never;
    }[keyof C]
  : import("drizzle-orm").Column;
export type ResourceIdentity<T, O> = O & {
  id: O extends { id: infer I extends import("drizzle-orm").Column }
    ? I
    : PrimaryColumn<T>;
};

/** Generic preparation declarations consumed by the application compiler. */
export interface PreparationContribution {
  readonly name: string;
  describe(): unknown;
  prepare(): void;
}

export interface Resource<
  TTable = any,
  TCtx extends ActionContext = ActionContext,
  TOptions = {},
  TEvents extends EventCatalog = EventCatalog,
> {
  use<
    P extends ResourcePlugin<
      Service<TCtx["db"], Omit<TCtx, keyof BaseContext>>,
      this,
      any
    >,
  >(
    plugin: P,
  ): this & ResourcePluginAPI<P, TTable, TCtx, this>;
  readonly name: string;
  readonly serviceName: string;
  readonly table: TTable;
  readonly id: TOptions extends {
    id: infer I extends import("drizzle-orm").Column;
  }
    ? I
    : import("drizzle-orm").Column;
  readonly idField: string;
  readonly config: ResourceConfig<TTable, TCtx> & TOptions;
  /**
   * Declare an action owned by this resource, registered as
   * `<resource>.<name>`. It mounts at `/api/<service>/<resource>/<name>`, or at
   * `/api/<service>/<resource>/:id/<name>` with `record: true`.
   */
  action<
    TIn extends TSchema | undefined = undefined,
    TOut extends TSchema | undefined = undefined,
    TErr extends Record<string, ActionErrorDefinition> = Record<
      string,
      ActionErrorDefinition
    >,
    const TRecord extends boolean = false,
  >(
    config: ResourceActionConfig<
      TIn,
      TOut,
      TErr,
      TCtx,
      InferTableRow<TTable>,
      TRecord
    >,
  ): Action<
    TRecord extends true
      ? TIntersect<
          [
            TIn extends TSchema ? TIn : TObject<{}>,
            TObject<{ id: TUnion<[TString, TNumber]> }>,
          ]
        >
      : TIn,
    TOut,
    TErr,
    TCtx
  >;
  /**
   * Declare a command: a record action whose body is the pure `decide`. Brick
   * loads the row (and the child rows it asks for) in a transaction, runs
   * `decide`, applies the changes it returns, records the events it emits in
   * the same transaction, and commits. Registered as `<resource>.<name>` at
   * `POST /api/<service>/<resource>/:id/<name>`.
   */
  command<
    TIn extends TSchema | undefined = undefined,
    TErr extends Record<string, ActionErrorDefinition> = {},
    const TLoad extends readonly ChildNames<TOptions>[] = [],
    TOut extends TSchema | undefined = undefined,
  >(
    name: string,
    config: CommandConfig<
      TIn,
      TOut,
      TErr,
      TCtx,
      CommandRow<TTable, TOptions, TLoad[number]>,
      CommandChildren<TOptions>,
      TEvents,
      TLoad
    >,
  ): Command<
    TIn,
    TOut,
    TErr,
    TCtx,
    CommandRow<TTable, TOptions, TLoad[number]>,
    CommandChildren<TOptions>,
    TEvents
  >;
}

type ChildNames<TOptions> = TOptions extends {
  children: infer C extends Record<string, ResourceChild>;
}
  ? keyof C & string
  : never;

/** The child tables of a resource, by name. */
export type CommandChildren<TOptions> = TOptions extends {
  children: infer C extends Record<string, ResourceChild>;
}
  ? { [K in keyof C]: C[K]["table"] }
  : {};

/** The row `decide` receives: the resource's row with the children it loads. */
export type CommandRow<
  TTable,
  TOptions,
  TLoaded extends string,
> = InferTableRow<TTable> & {
  [K in TLoaded & keyof CommandChildren<TOptions>]: InferTableRow<
    CommandChildren<TOptions>[K]
  >[];
};

/** The changes to one child table. Updates and deletes name rows by child id. */
export interface ChildChanges<TChild = any> {
  /** New rows. Their parent column is set to the parent's id. */
  insert?: Partial<InferTableInsert<TChild>>[];
  /** Partial rows, each with the child id; only rows of this parent change. */
  update?: Partial<InferTableRow<TChild>>[];
  /** Child ids to delete; only rows of this parent are deleted. */
  delete?: (string | number)[];
}

/** What `decide` returns when the command goes ahead. */
export interface CommandDecision<
  TRow = any,
  TChildren = {},
  TEvents extends EventCatalog = EventCatalog,
> {
  /** Columns of the parent row to change. */
  set?: Partial<Omit<TRow, keyof TChildren>>;
  /** Inserts, updates and deletes per child table. */
  children?: { [K in keyof TChildren]?: ChildChanges<TChildren[K]> };
  /** Events to record with the write, by catalog name and payload. */
  emit?: { [K in keyof TEvents]?: Static<TEvents[K]> };
}

/**
 * The `error` helpers `decide` receives. Unlike an action's, they return the
 * rejection instead of throwing, so `decide` stays a pure function.
 */
export type CommandErrors<
  TErrors extends Record<string, ActionErrorDefinition>,
> = {
  [K in keyof TErrors | StandardErrorCode]: (
    overrideMessage?: string,
    details?: unknown,
  ) => ActionExecutionError;
};

/** `resource.command(name, config)`. */
export interface CommandConfig<
  TIn extends TSchema | undefined = undefined,
  TOut extends TSchema | undefined = undefined,
  TErr extends Record<string, ActionErrorDefinition> = {},
  TCtx extends ActionContext = ActionContext,
  TRow = any,
  TChildren = {},
  TEvents extends EventCatalog = EventCatalog,
  TLoad extends readonly string[] = readonly string[],
> {
  description?: string;
  tags?: string[];
  /** The command's own input; `id` from the path joins it. */
  input?: TIn;
  /**
   * The reply: the updated row (with loaded children), cut down to this
   * schema's properties. Without it the reply is `{ id }`.
   */
  output?: TOut;
  errors?: TErr;
  /** Which child tables to load with the row, by their name on the resource. */
  load?: { children?: TLoad };
  /** For a resource without `crud`: which rows the command may load. */
  access?: ResourceActionAccess<TCtx>;
  authorize?: (params: {
    user?: TCtx extends { user: infer U } ? U : any;
    input: ResourceActionInput<TIn, true>;
    ctx: TCtx;
  }) => boolean | Promise<boolean>;
  /**
   * The rules: a pure function of the loaded row and the input. Return
   * `error.CODE()` to reject (nothing is written), or the changes to make.
   */
  decide: (
    row: TRow,
    input: ResourceActionInput<TIn, true>,
    helpers: { error: CommandErrors<TErr> },
  ) => CommandDecision<TRow, TChildren, TEvents> | ActionExecutionError;
}

/** A command: an action with its `decide`, callable without a database. */
export type Command<
  TIn extends TSchema | undefined = undefined,
  TOut extends TSchema | undefined = undefined,
  TErr extends Record<string, ActionErrorDefinition> = {},
  TCtx extends ActionContext = ActionContext,
  TRow = any,
  TChildren = {},
  TEvents extends EventCatalog = EventCatalog,
> = Action<
  TIntersect<
    [
      TIn extends TSchema ? TIn : TObject<{}>,
      TObject<{ id: TUnion<[TString, TNumber]> }>,
    ]
  >,
  TOut extends TSchema ? TOut : TObject<{ id: TUnion<[TString, TNumber]> }>,
  TErr,
  TCtx
> & {
  /**
   * Run the rules alone, with the standard and declared error helpers: for
   * unit tests that need no database.
   */
  decide(
    row: TRow,
    input: ResourceActionInput<TIn, true>,
  ): CommandDecision<TRow, TChildren, TEvents> | ActionExecutionError;
};

/**
 * Which rows a record action may load when its resource has no `crud`:
 * `"public"` loads any row by id, `scope` adds a SQL condition (such as the
 * caller's tenant). With `crud` installed, its `access` always applies instead.
 */
export type ResourceActionAccess<TCtx = any> =
  | "public"
  | {
      scope: (args: {
        ctx: TCtx;
      }) =>
        | import("drizzle-orm").SQL
        | undefined
        | Promise<import("drizzle-orm").SQL | undefined>;
    };

/** A record action's input: its own fields and the `id` from the path. */
export type ResourceActionInput<
  TIn extends TSchema | undefined,
  TRecord extends boolean,
> = TRecord extends true
  ? (TIn extends TSchema ? Static<TIn> : {}) & { id: string | number }
  : TIn extends TSchema
    ? Static<TIn>
    : any;

/** `resource.action(config)`: an action owned by a resource. */
export interface ResourceActionConfig<
  TIn extends TSchema | undefined = undefined,
  TOut extends TSchema | undefined = undefined,
  TErr extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  TCtx extends ActionContext = ActionContext,
  TRow = any,
  TRecord extends boolean = false,
> extends BaseActionConfig<TIn, TOut, TErr> {
  /**
   * `true` makes it a record action at `/:id/<name>`: `id` joins the input,
   * the row loads through the resource's access, and a missing or hidden row
   * answers 404 before `execute` runs.
   */
  record?: TRecord;
  /** For a record action on a resource without `crud`: which rows it may load. */
  access?: ResourceActionAccess<TCtx>;
  authorize?: (params: {
    user?: TCtx extends { user: infer U } ? U : any;
    input: ResourceActionInput<TIn, TRecord>;
    ctx: TCtx;
  }) => boolean | Promise<boolean>;
  execute: (params: {
    input: ResourceActionInput<TIn, TRecord>;
    ctx: TCtx;
    error: ErrorBuilder<TErr>;
    /** The loaded row of a record action; `undefined` otherwise. */
    row: TRecord extends true ? TRow : undefined;
  }) =>
    | Promise<TOut extends TSchema ? Static<TOut> : any>
    | (TOut extends TSchema ? Static<TOut> : any);
}

export interface ServiceOptions<
  TServiceContext extends Record<string, any> = Record<string, any>,
  TDb = any,
> {
  database?: DatabaseHandle<TDb>;
  /**
   * What the service needs from the app, as typed slots: `{ carrier: port<Carrier>() }`.
   * `brick({ deps })` provides the values, and actions read them as `ctx.deps`.
   */
  deps?: Ports;
  context?: (
    baseCtx: BaseContext<TDb> & { user?: unknown },
  ) => Promise<TServiceContext> | TServiceContext;
  /**
   * The service's event catalog: payload schema by event name. Each becomes
   * `service.events.<name>`, recorded as `<service>.<name>`.
   */
  events?: EventCatalog;
}

export type ActionAccessPolicy = "public" | "authorized" | "scoped";

export interface ActionSchema {
  name: string;
  /** Present only when this action has a registered HTTP route. */
  method?: HttpMethod;
  path?: string;
  serviceName?: string;
  /** Owning plugin descriptor name for plugin actions (e.g. `@brickkit/crud`). */
  plugin?: string;
  /** Owning resource name for resource-plugin actions (e.g. `page`). */
  resource?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  hasAuthorize: boolean;
  hasScope?: boolean;
  accessPolicy?: ActionAccessPolicy;
  errors?: Record<string, ActionErrorDefinition>;
  emits?: string[];
  tags?: string[];
}

export interface ServiceSchema {
  name: string;
  /** The service options as JSON: functions, such as `context` and hooks, are left out. */
  options: Record<string, unknown>;
  hasDatabase: boolean;
  databaseConfig?: {
    name?: string;
    engine: "sqlite" | "postgres";
    tables: string[];
    /** The plugin that owns each table it contributed, by table key. */
    plugins?: Record<string, string>;
  };
  actions: ActionSchema[];
  sockets?: BrickSocketSchema[];
  /** MCP tools. A tool with an HTTP route is also listed under `actions`. */
  tools?: { name: string }[];
  /** The event catalog: each event's wire name and payload JSON Schema. */
  events?: { name: string; schema: unknown; plugin?: string }[];
  resources?: { name: string }[];
}

export interface ArchitectureSchema {
  version: string;
  services: ServiceSchema[];
  /** Present when the app has an `events` option. */
  events?: EventsDefinition;
  /** Every `definePlugin` installation, with its dashboard extension. */
  plugins?: InstalledPlugin[];
}

export interface Service<
  TDb = BunSQLiteDatabase<Record<string, unknown>>,
  TServiceContext extends Record<string, any> = Record<string, any>,
  TEvents extends EventCatalog = EventCatalog,
> {
  readonly name: string;
  /** The declared events, as handles for `defineListener` and `emitEvent`. */
  readonly events: EventRefs<TEvents>;
  readonly options: ServiceOptions<TServiceContext, TDb>;
  /** The tables of the service's resources and plugins, by table name. */
  readonly tables: Map<string, any>;
  readonly db?: TDb;
  readonly isBuilt?: boolean;

  use<A>(plugin: ServicePlugin<this, A>): A;

  build(): this;

  socket<
    const I extends SocketSchemas,
    const O extends SocketSchemas,
    const E extends Record<string, ActionErrorDefinition> = {},
  >(
    config: BrickSocketConfig<I, O, BaseContext<TDb> & TServiceContext, E>,
  ): BrickSocketHandle<SocketPayloads<O>>;
  listSockets(): RegisteredSocket[];

  action<
    TIn extends TSchema | undefined = undefined,
    TOut extends TSchema | undefined = undefined,
    TErr extends Record<string, ActionErrorDefinition> = Record<
      string,
      ActionErrorDefinition
    >,
  >(
    action: Action<TIn, TOut, TErr, BaseContext<TDb> & TServiceContext>,
  ): this;

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

  tool<
    TIn extends TSchema | undefined = undefined,
    TOut extends TSchema | undefined = undefined,
    TErr extends Record<string, ActionErrorDefinition> = Record<
      string,
      ActionErrorDefinition
    >,
  >(
    action: Tool<TIn, TOut, TErr, BaseContext<TDb> & TServiceContext>,
  ): this;

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

  resource<
    TTable = any,
    const TOptions extends ResourceTypeOptions = ResourceTypeOptions,
  >(
    config: ResourceConfig<TTable, BaseContext<TDb> & TServiceContext> &
      TOptions &
      Record<Exclude<keyof TOptions, keyof ResourceConfig>, never>,
  ): Resource<
    TTable,
    BaseContext<TDb> & TServiceContext,
    ResourceIdentity<TTable, TOptions>,
    TEvents
  >;

  contributePreparation(contribution: PreparationContribution): void;
  getAction(name: string): Action<any, any, any, any> | undefined;
  listActions(): Action<any, any, any, any>[];
  getTool(name: string): Tool<any, any, any, any> | undefined;
  listTools(): Tool<any, any, any, any>[];
  getResource(
    name: string,
  ): Resource<any, BaseContext<TDb> & TServiceContext> | undefined;
  listResources(): Resource<any, BaseContext<TDb> & TServiceContext>[];
  getDb(): TDb | undefined;
  /** The handle from `defineDatabase`, without connecting. */
  getDatabaseHandle(): DatabaseHandle<TDb> | undefined;
  setDb(database: DatabaseHandle<TDb>): void;
  /** What a write needs to record events. Set by `brick({ events })`; absent otherwise. */
  readonly recorder?: ServiceEvents;
  resolveContext(
    callCtx?: Partial<BaseContext<TDb> & TServiceContext>,
  ): Promise<BaseContext<TDb> & TServiceContext>;
  introspect(): ServiceSchema;
}

export interface ProxyOptions {
  /** Name of the service creating this proxy. Populates ctx.caller on the target's envelope. */
  from?: string;
  context?: Partial<ActionContext>;
}
