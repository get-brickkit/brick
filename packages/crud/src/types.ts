import type {
  Action,
  ErrorBuilder,
  ActionContext,
  ResourcePlugin,
  PluginRoutes,
} from "@brickkit/core";
import type { TSchema, TUnsafe, Static } from "@sinclair/typebox";
import type { Table, SQL, Column, GetColumnData } from "drizzle-orm";

import type { OPERATORS } from "./where";

export type FilterOperator = keyof typeof OPERATORS;
export interface ColumnFieldPolicy {
  read?: boolean;
  create?: boolean;
  update?: boolean;
  filter?: readonly FilterOperator[];
  sort?: boolean;
  schema?: TSchema;
  resolve?: never;
  scrub?: (args: {
    value: any;
    ctx: ActionContext;
  }) => unknown | Promise<unknown>;
}
export interface DerivedFieldPolicy {
  read: true;
  schema: TSchema;
  /** One value per authorized parent row, in the same order. */
  resolve: (args: {
    rows: readonly Readonly<Record<string, unknown>>[];
    ctx: ActionContext;
  }) => readonly unknown[] | Promise<readonly unknown[]>;
  create?: false;
  update?: false;
  filter?: readonly [];
  sort?: false;
  scrub?: ColumnFieldPolicy["scrub"];
}
export type FieldPolicy = ColumnFieldPolicy | DerivedFieldPolicy;
export type Fields = Readonly<Record<string, FieldPolicy>>;
export type Operation =
  | "list"
  | "get"
  | "create"
  | "update"
  | "delete"
  | "findOne"
  | "count"
  | "exists";
/** Batch writes. Off unless `operations` sets them to `true`. */
export type BulkOperation = "bulkCreate" | "bulkUpdate" | "bulkDelete";
export type Operations =
  | false
  | Partial<Record<Operation | BulkOperation, boolean>>;
/** What `afterCommit` receives for each written row. */
export type CrudCommitArgs = {
  id: unknown;
  ctx: ActionContext;
} & (
  | { operation: "create" | "update"; row: Record<string, unknown> }
  | { operation: "delete"; row?: undefined }
);
/** A write hook: it gets `args` plus the call's context and transaction. */
type WriteHook<A> = (
  args: A & {
    ctx: ActionContext;
    error: ErrorBuilder<Record<string, never>>;
    /** The operation's open transaction: write other tables through it. */
    tx: any;
  },
) => void | Promise<void>;
export interface CrudOptions<
  F extends Fields = Fields,
  O extends Operations = Operations,
> {
  fields: F;
  operations?: O;
  routes?: PluginRoutes;
  defaultLimit?: number;
  maxLimit?: number;
  /** Most items one bulk call accepts. Default 100. */
  maxBatchSize?: number;
  /**
   * Whether writes through this resource emit events: `<resource>.create`,
   * `<resource>.update` and `<resource>.delete`. Default `true`. It has an effect
   * once the app sets `brick({ events })`, the service's database holds an
   * `outboxTable()`, and a listener wants the event. Reads never emit.
   *
   * The payload carries the fields the resource lets you read, not hidden
   * columns: `{ id, row }` for create and delete, `{ id, before, after }` for
   * update. The write and its event are committed in one transaction.
   */
  events?: boolean;
  access:
    | "public"
    | {
        authorize?: (args: CrudAuthorizeArgs<F>) => boolean | Promise<boolean>;
        scope?: (args: {
          operation: Operation;
          ctx: ActionContext;
        }) => SQL | undefined | Promise<SQL | undefined>;
      };
  /**
   * Write hooks run inside the operation's transaction, once per row (bulk
   * operations included): a hook that throws rolls the whole operation back.
   * `afterCommit` runs after the commit, for side effects that must not happen
   * when the write is undone; an error it throws is logged, not returned.
   */
  hooks?: {
    afterCommit?: (args: CrudCommitArgs) => void | Promise<void>;
    beforeCreate?: WriteHook<{ data: Record<string, unknown> }>;
    afterCreate?: WriteHook<{ row: Record<string, unknown> }>;
    afterUpdate?: WriteHook<{ id: unknown; row: Record<string, unknown> }>;
    beforeDelete?: WriteHook<{ id: unknown }>;
    afterDelete?: WriteHook<{ id: unknown }>;
    beforeUpdate?: WriteHook<{ id: unknown; data: Record<string, unknown> }>;
  };
}
type Row<T extends Table> = T["$inferSelect"];
type Keys<F, P extends string> = {
  [K in keyof F]: F[K] extends Record<P, true> ? K : never;
}[keyof F];
type ReadKeys<T extends Table, F> = Extract<Keys<F, "read">, keyof Row<T>>;
type IncludeKeys<F> = {
  [K in keyof F]: F[K] extends {
    resolve: (...args: any[]) => any;
    schema: TSchema;
  }
    ? K
    : never;
}[keyof F];
type FieldValue<T extends Table, F, K extends keyof F> = F[K] extends {
  schema: infer S extends TSchema;
}
  ? Static<S>
  : F[K] extends { scrub: (...args: any[]) => infer V }
    ? Awaited<V>
    : K extends keyof Row<T>
      ? Row<T>[K]
      : never;
export type ReadRow<T extends Table, F> = {
  [K in ReadKeys<T, F>]: FieldValue<T, F, K>;
};
type IncludedRow<T extends Table, F, I> = I extends readonly (infer K)[]
  ? { [P in Extract<K, IncludeKeys<F> & keyof F>]: FieldValue<T, F, P> }
  : {};
type WriteKeys<T extends Table, F, P extends string> = Extract<
  Keys<F, P>,
  keyof T["$inferInsert"]
>;
type WriteRow<T extends Table, F, P extends string> = Pick<
  T["$inferInsert"],
  WriteKeys<T, F, P>
>;
type AllowedOps<F, K extends keyof F> = F[K] extends {
  filter: readonly (infer O)[];
}
  ? O
  : never;
type Operand<V, O extends FilterOperator> = {
  none: {};
  one: { value: NonNullable<V> };
  list: { value: readonly NonNullable<V>[] };
  pair: { value: readonly [NonNullable<V>, NonNullable<V>] };
}[(typeof OPERATORS)[O]["operand"]];
type Leaf<F, V> = {
  [K in Extract<keyof F, keyof V>]: {
    [O in Extract<AllowedOps<F, K>, FilterOperator>]: {
      field: K;
      op: O;
    } & Operand<V[K], O>;
  }[Extract<AllowedOps<F, K>, FilterOperator>];
}[Extract<keyof F, keyof V>];
type FilterWhere<F, V> =
  | Leaf<F, V>
  | { and: readonly FilterWhere<F, V>[] }
  | { or: readonly FilterWhere<F, V>[] };
export type Where<T extends Table, F> = FilterWhere<F, Row<T>>;
export interface Query<
  T extends Table,
  F,
  S extends readonly ReadKeys<T, F>[] | undefined = undefined,
  I extends readonly IncludeKeys<F>[] | undefined = undefined,
> {
  select?: S;
  include?: I;
  where?: Where<T, F>;
  orderBy?: readonly {
    field: Extract<Keys<F, "sort">, keyof Row<T>>;
    direction: "asc" | "desc";
  }[];
  limit?: number;
  offset?: number;
  includeTotal?: boolean;
}
/** `list` input: a query, plus keyset pagination. */
export type ListQuery<
  T extends Table,
  F,
  S extends readonly ReadKeys<T, F>[] | undefined = undefined,
  I extends readonly IncludeKeys<F>[] | undefined = undefined,
> = Query<T, F, S, I> & {
  /** `null` for the first page, then the previous page's `nextCursor`. */
  cursor?: string | null;
};
type KindQuery<T extends Table, F, S, I, Kind> = Kind extends "list"
  ? ListQuery<
      T,
      F,
      Extract<S, readonly ReadKeys<T, F>[] | undefined>,
      Extract<I, readonly IncludeKeys<F>[] | undefined>
    >
  : Query<
      T,
      F,
      Extract<S, readonly ReadKeys<T, F>[] | undefined>,
      Extract<I, readonly IncludeKeys<F>[] | undefined>
    >;
// The table is supplied after crud() is configured. Only explicit field
// schemas can supply value types here; column-derived values stay unknown.
type AuthorizeKeys<F, P extends string> = string extends keyof F
  ? keyof F
  : Keys<F, P>;
type AuthorizeValues<F> = {
  [K in keyof F]: F[K] extends { schema: infer S extends TSchema }
    ? Static<S>
    : unknown;
};
type AuthorizeWrite<F, P extends string> = {
  [K in Extract<AuthorizeKeys<F, P>, keyof F>]?: AuthorizeValues<F>[K];
};
type AuthorizeQuery<F> = {
  select?: readonly Exclude<AuthorizeKeys<F, "read">, IncludeKeys<F>>[];
  include?: readonly IncludeKeys<F>[];
  where?: string extends keyof F
    ? FilterWhere<
        Record<string, { filter: readonly FilterOperator[] }>,
        Record<string, unknown>
      >
    : FilterWhere<F, AuthorizeValues<F>>;
  orderBy?: readonly {
    field: AuthorizeKeys<F, "sort">;
    direction: "asc" | "desc";
  }[];
  limit?: number;
  offset?: number;
  includeTotal?: boolean;
};
/** Validated authorization inputs, indexed by CRUD operation. */
export type CrudInputs<F extends Fields = Fields> = {
  list: { [K in keyof AuthorizeQuery<F>]: AuthorizeQuery<F>[K] } & {
    cursor?: string | null;
  };
  findOne: { [K in keyof AuthorizeQuery<F>]: AuthorizeQuery<F>[K] };
  get: {
    id: unknown;
    select?: readonly Exclude<AuthorizeKeys<F, "read">, IncludeKeys<F>>[];
    include?: readonly IncludeKeys<F>[];
  };
  create: AuthorizeWrite<F, "create">;
  update: { id: unknown; data: AuthorizeWrite<F, "update"> };
  delete: { id: unknown };
  count: { where?: AuthorizeQuery<F>["where"] };
  exists: { where?: AuthorizeQuery<F>["where"] };
};
/** Narrow operation and input together in an authorize callback. */
export type CrudAuthorizeArgs<F extends Fields = Fields> = {
  [K in Operation]: {
    operation: K;
    input: CrudInputs<F>[K];
    ctx: ActionContext;
  };
}[Operation];
type Selected<
  T extends Table,
  F,
  S,
  I = undefined,
> = (S extends readonly (infer K)[]
  ? Pick<ReadRow<T, F>, Extract<K, keyof ReadRow<T, F>>>
  : ReadRow<T, F>) &
  IncludedRow<T, F, I>;
/** What `list` returns. */
type ListResult<R> = {
  items: R[];
  total?: number;
  limit: number;
  offset: number;
  nextCursor?: string | null;
};
type QueryResult<Kind, R> = Kind extends "list" ? ListResult<R> : R | null;
type Callable<I, R, C> = Action<
  TUnsafe<I>,
  TUnsafe<R>,
  Record<string, never>,
  C extends ActionContext ? C : ActionContext
>;
export interface QueryAction<
  T extends Table,
  F,
  C,
  Kind extends "list" | "findOne",
> extends Omit<
  Callable<
    KindQuery<
      T,
      F,
      readonly ReadKeys<T, F>[] | undefined,
      readonly IncludeKeys<F>[] | undefined,
      Kind
    >,
    QueryResult<Kind, ReadRow<T, F>>,
    C
  >,
  "run" | "execute"
> {
  <
    const S extends readonly ReadKeys<T, F>[] | undefined = undefined,
    const I extends readonly IncludeKeys<F>[] | undefined = undefined,
  >(params: {
    input: KindQuery<T, F, S, I, Kind>;
    ctx?: Partial<C>;
  }): Promise<QueryResult<Kind, Selected<T, F, S, I>>>;
  run<
    const S extends readonly ReadKeys<T, F>[] | undefined = undefined,
    const I extends readonly IncludeKeys<F>[] | undefined = undefined,
  >(
    input: KindQuery<T, F, S, I, Kind>,
    ctx?: Partial<C>,
  ): Promise<QueryResult<Kind, Selected<T, F, S, I>>>;
  execute<
    const S extends readonly ReadKeys<T, F>[] | undefined = undefined,
    const I extends readonly IncludeKeys<F>[] | undefined = undefined,
  >(params: {
    input: KindQuery<T, F, S, I, Kind>;
    ctx?: Partial<C>;
  }): Promise<QueryResult<Kind, Selected<T, F, S, I>>>;
}
export interface GetAction<T extends Table, F, C, ID> extends Omit<
  Callable<
    {
      id: ID;
      select?: readonly ReadKeys<T, F>[];
      include?: readonly IncludeKeys<F>[];
    },
    ReadRow<T, F>,
    C
  >,
  "run" | "execute"
> {
  <
    const S extends readonly ReadKeys<T, F>[] | undefined = undefined,
    const I extends readonly IncludeKeys<F>[] | undefined = undefined,
  >(params: {
    input: { id: ID; select?: S; include?: I };
    ctx?: Partial<C>;
  }): Promise<Selected<T, F, S, I>>;
  run<
    const S extends readonly ReadKeys<T, F>[] | undefined = undefined,
    const I extends readonly IncludeKeys<F>[] | undefined = undefined,
  >(
    input: { id: ID; select?: S; include?: I },
    ctx?: Partial<C>,
  ): Promise<Selected<T, F, S, I>>;
  execute<
    const S extends readonly ReadKeys<T, F>[] | undefined = undefined,
    const I extends readonly IncludeKeys<F>[] | undefined = undefined,
  >(params: {
    input: { id: ID; select?: S; include?: I };
    ctx?: Partial<C>;
  }): Promise<Selected<T, F, S, I>>;
}
type AllAPI<T extends Table, C, F, ID> = {
  list: QueryAction<T, F, C, "list">;
  findOne: QueryAction<T, F, C, "findOne">;
  get: GetAction<T, F, C, ID>;
  create: Callable<WriteRow<T, F, "create">, ReadRow<T, F>, C>;
  update: Callable<
    { id: ID; data: Partial<WriteRow<T, F, "update">> },
    ReadRow<T, F>,
    C
  >;
  delete: Callable<{ id: ID }, { success: true }, C>;
  count: Callable<{ where?: Where<T, F> }, { count: number }, C>;
  exists: Callable<{ where?: Where<T, F> }, { exists: boolean }, C>;
  bulkCreate: Callable<
    { items: WriteRow<T, F, "create">[] },
    { items: ReadRow<T, F>[] },
    C
  >;
  bulkUpdate: Callable<
    { items: { id: ID; data: Partial<WriteRow<T, F, "update">> }[] },
    { items: ReadRow<T, F>[] },
    C
  >;
  bulkDelete: Callable<{ ids: ID[] }, { count: number }, C>;
};
export type CrudAPI<T extends Table, C, F, O, ID = Row<T>[keyof Row<T>]> = [
  O,
] extends [false]
  ? {}
  : Pick<
      AllAPI<T, C, F, ID>,
      | { [K in Operation]: O extends Record<K, false> ? never : K }[Operation]
      | {
          [K in BulkOperation]: O extends Record<K, true> ? K : never;
        }[BulkOperation]
    >;
export interface CrudTypes<F, O> {
  readonly table: unknown;
  readonly context: unknown;
  readonly resource: unknown;
  readonly api: this["table"] extends Table
    ? CrudAPI<
        this["table"],
        this["context"],
        F,
        O,
        this["resource"] extends { config: { id: infer I extends Column } }
          ? GetColumnData<I, "raw">
          : this["table"]["$inferSelect"][keyof this["table"]["$inferSelect"]]
      >
    : {};
}
export type CrudPlugin<F extends Fields, O extends Operations> = ResourcePlugin<
  any,
  any,
  object
> & { readonly types: CrudTypes<F, O> };
