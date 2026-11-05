import { and, eq, getTableColumns, inArray, type Column } from "drizzle-orm";
import type { TObject, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { installPlugin, segmentClaimant } from "./plugin";
import type { ResourcePlugin } from "./plugin-types";
import { buildErrorHelpers, defineAction } from "./action";
import { kebabCase } from "./routes";
import { actionMeta, type ResourceActionInfo } from "./action-meta";
import { portOf } from "./service-port";
import { Type } from "./typebox";
import { runInTransaction } from "./events/transaction";
import { crudEventSource, type EventRef } from "./events/catalog";
import {
  ActionExecutionError,
  DuplicateNameError,
  type ActionContext,
  type ActionErrorDefinition,
  type CommandConfig,
  type CommandDecision,
  type Resource,
  type ResourceActionAccess,
  type ResourceActionConfig,
  type ResourceChild,
  type ResourceConfig,
  type ResourceTypeOptions,
  type ResourceIdentity,
  type Service,
} from "./types";

/**
 * Load the row a record action (or command) works on, through its `access`.
 *
 * @returns The row, or `undefined` when it is missing or hidden.
 * @throws When `access` is missing.
 */
export async function loadRecord(
  resource: Resource<any, any, any>,
  args: {
    id: unknown;
    ctx: any;
    db?: any;
    access?: ResourceActionAccess;
  },
): Promise<Record<string, unknown> | undefined> {
  if (!args.access)
    throw new Error(
      `Resource '${resource.name}' has no access rule for loading records: set \`access\` on the record action`,
    );
  const db = args.db ?? args.ctx?.db;
  // An id its column can't hold names no row.
  const id = idValue(resource.id, args.id);
  if (id === undefined) return undefined;
  if (!db) throw new Error("Record actions require a configured database");
  const scope =
    args.access === "public"
      ? undefined
      : await args.access.scope({ ctx: args.ctx });
  const [row] = await db
    .select()
    .from(resource.table)
    .where(and(scope, eq(resource.id, id)))
    .limit(1);
  return row;
}

/** Startup check: a record action needs its own `access`. */
export function checkRecordAccess(
  resource: Resource<any, any, any>,
  info: ResourceActionInfo,
): void {
  const name = `${resource.name}.${info.name}`;
  if (info.access === undefined)
    throw new Error(
      `Record action '${name}' needs \`access\` ("public" or { scope })`,
    );
}

/** The id from the path as its column stores it: a Date or BigInt for those columns, undefined when it can't be one. */
function idValue(column: Column, id: unknown): unknown {
  if (typeof id !== "string") return id;
  if (column.dataType === "date") {
    const date = new Date(id);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (column.dataType === "bigint")
    return /^-?\d+$/.test(id) ? BigInt(id) : undefined;
  return id;
}

function idSchema(column: Column): TSchema {
  return column.dataType === "number" ? Type.Number() : Type.String();
}

function defineResourceAction(
  service: Service<any, any>,
  resource: Resource<any, any, any>,
  config: ResourceActionConfig<any, any, any, any, any, boolean>,
  /** A command's body: it loads the row itself, in its transaction. */
  command?: (args: { input: any; ctx: any; error: any }) => Promise<unknown>,
) {
  const { record = false, access, execute, ...rest } = config;
  if (!config.name || /[./]/.test(config.name))
    throw new Error(`Invalid resource action name '${config.name}'`);
  const name = `${resource.name}.${config.name}`;
  const segment = kebabCase(config.name);
  // A plugin route on this resource (crud's `/count`) owns its first segment.
  const claimant = segmentClaimant(service, resource, segment);
  if (claimant)
    throw new DuplicateNameError(
      `Brick: duplicate name "${name}" in service "${service.name}": "${segment}" is a ${claimant} route`,
    );
  const existing = service.getAction(name);
  if (existing && actionMeta(existing).route)
    throw new DuplicateNameError(
      `Brick: duplicate name "${name}" in service "${service.name}"`,
    );
  if (!record && access !== undefined)
    throw new Error(`Only record actions take \`access\` ('${name}')`);
  if (record && config.path !== undefined && !/\/:id(\/|$)/.test(config.path))
    throw new Error(`Record action '${name}' needs ':id' in its path`);
  let input = config.input as TSchema | undefined;
  if (record) {
    const own = input as TObject | undefined;
    if (own && own.type !== "object")
      throw new Error(`Record action '${name}' input must be an object`);
    input = Type.Object(
      { ...own?.properties, id: idSchema(resource.id) },
      own?.additionalProperties === undefined
        ? {}
        : { additionalProperties: own.additionalProperties },
    );
  }
  const action = defineAction({
    ...rest,
    name,
    input,
    execute: async ({ input, ctx, error }: any) => {
      if (command) return command({ input, ctx, error });
      const row = record
        ? await loadRecord(resource, { id: input.id, ctx, access })
        : undefined;
      if (record && row === undefined)
        error.NOT_FOUND(`${resource.name} '${String(input.id)}' not found`);
      return execute({ input, ctx, error, row } as any);
    },
  } as any);
  const info: ResourceActionInfo = {
    resource: resource.name,
    name: config.name,
    record,
    ...(access === undefined ? {} : { access }),
  };
  actionMeta(action).resourceAction = info;
  service.action(action);
  return action;
}

function primaryColumn(table: unknown): [string, Column] | undefined {
  const primary = Object.entries(
    getTableColumns(table as Parameters<typeof getTableColumns>[0]),
  ).filter(([, column]) => column.primary);
  return primary.length === 1 ? primary[0] : undefined;
}

function fieldOf(table: unknown, column: Column): string | undefined {
  return Object.entries(
    getTableColumns(table as Parameters<typeof getTableColumns>[0]),
  ).find(([, own]) => own === column)?.[0];
}

interface ChildInfo {
  table: any;
  parent: Column;
  parentField: string;
  id: Column;
  idField: string;
}

function childInfo(
  resource: Resource<any, any, any>,
  name: string,
  where: string,
): ChildInfo {
  const child = (
    resource.config as { children?: Record<string, ResourceChild> }
  ).children?.[name];
  if (!child || !Object.hasOwn(resource.config.children ?? {}, name))
    throw new Error(
      `${where}: resource '${resource.name}' has no child table '${name}'`,
    );
  const parentField = fieldOf(child.table, child.parent);
  const id = child.id ?? primaryColumn(child.table)?.[1];
  const idField = id && fieldOf(child.table, id);
  if (!parentField || !id || !idField)
    throw new Error(
      `Resource '${resource.name}' child '${name}' needs a parent column and an id column of its table`,
    );
  return { table: child.table, parent: child.parent, parentField, id, idField };
}

/** The `error` helpers of `decide`: they return the rejection, not throw it. */
function commandErrors(errors?: Record<string, ActionErrorDefinition>) {
  const throwing = buildErrorHelpers(errors) as Record<
    string,
    (message?: string, details?: unknown) => never
  >;
  return Object.fromEntries(
    Object.entries(throwing).map(([code, helper]) => [
      code,
      (message?: string, details?: unknown) => {
        try {
          helper(message, details);
        } catch (rejection) {
          return rejection;
        }
      },
    ]),
  );
}

function defineCommand(
  service: Service<any, any>,
  resource: Resource<any, any, any>,
  name: string,
  config: CommandConfig<any, any, any, any, any, any, any, readonly string[]>,
) {
  const where = `Command '${resource.name}.${name}'`;
  if (typeof config.decide !== "function")
    throw new Error(`${where} needs a decide function`);
  const loaded = (config.load?.children ?? []).map((child) => ({
    name: child,
    ...childInfo(resource, child, where),
  }));
  const error = commandErrors(config.errors);
  const decide = (row: any, input: any) =>
    config.decide(row, input, { error } as any);
  const events = service.events as Record<string, EventRef>;

  const run = async ({ input, ctx }: { input: any; ctx: any }) => {
    const db = ctx.db;
    if (!db) throw new Error(`${where} requires a configured database`);
    const recorder = service.recorder;
    const body = async (
      tx: any,
      record?: (name: string, payload: unknown) => Promise<void>,
    ) => {
      const row = await loadRecord(resource, {
        id: input.id,
        ctx,
        db: tx,
        access: config.access,
      });
      if (row === undefined)
        throw new ActionExecutionError(
          "NOT_FOUND",
          `${resource.name} '${String(input.id)}' not found`,
          404,
        );
      const id = row[resource.idField];
      for (const child of loaded)
        row[child.name] = await tx
          .select()
          .from(child.table)
          .where(eq(child.parent, id));

      const decision = decide(row, input);
      if (decision instanceof ActionExecutionError) throw decision;
      const { set, children, emit } = (decision ?? {}) as CommandDecision<
        any,
        Record<string, unknown>
      >;
      // Every event is checked before anything is written.
      const emits = Object.entries(emit ?? {})
        .filter(([, payload]) => payload !== undefined)
        .map(([key, payload]) => {
          const ref = Object.hasOwn(events, key) ? events[key] : undefined;
          if (!ref)
            throw new Error(
              `${where} emits '${key}', which is not in the event catalog of service '${service.name}'`,
            );
          portOf(service).checkEvent(ref.name, payload);
          return [ref.name, payload] as const;
        });
      if (emits.length && !record)
        throw new Error(
          `${where} emits events, but service '${service.name}' records none: give its database an outbox table and the app \`events\``,
        );

      if (set && Object.keys(set).length)
        await tx.update(resource.table).set(set).where(eq(resource.id, id));
      for (const [childName, changes] of Object.entries(children ?? {})) {
        if (!changes) continue;
        const child = childInfo(resource, childName, where);
        const own = eq(child.parent, id);
        if (changes.insert?.length)
          await tx.insert(child.table).values(
            changes.insert.map((item) => ({
              ...item,
              [child.parentField]: id,
            })),
          );
        for (const item of changes.update ?? []) {
          const { [child.idField]: childId, ...values } = item as Record<
            string,
            unknown
          >;
          if (childId === undefined)
            throw new Error(
              `${where}: an update of child '${childName}' needs its '${child.idField}'`,
            );
          if (Object.keys(values).length)
            await tx
              .update(child.table)
              .set(values)
              .where(and(eq(child.id, childId), own));
        }
        if (changes.delete?.length)
          await tx
            .delete(child.table)
            .where(and(inArray(child.id, changes.delete), own));
      }
      for (const [eventName, payload] of emits)
        await record!(eventName, payload);

      if (!config.output) return { id };
      const [updated] = await tx
        .select()
        .from(resource.table)
        .where(eq(resource.id, id))
        .limit(1);
      for (const child of loaded)
        updated[child.name] = await tx
          .select()
          .from(child.table)
          .where(eq(child.parent, id));
      return Value.Clean(config.output, updated);
    };
    return recorder
      ? recorder.transaction(
          db,
          {
            traceId: ctx.traceId,
            source: crudEventSource(service.name, resource.name),
          },
          body,
        )
      : runInTransaction(db, (tx) => body(tx));
  };

  const action = defineResourceAction(
    service,
    resource,
    {
      name,
      record: true,
      description: config.description,
      tags: config.tags,
      input: config.input,
      output: config.output ?? Type.Object({ id: idSchema(resource.id) }),
      errors: config.errors,
      ...(config.access === undefined ? {} : { access: config.access }),
      ...(config.authorize ? { authorize: config.authorize } : {}),
      execute: () => undefined,
    } as ResourceActionConfig<any, any, any, any, any, boolean>,
    run,
  );
  Object.assign(action, { decide });
  return action;
}

/** Declares a plugin host without registering actions or changing the schema. */
export function defineResource<
  TTable = any,
  TCtx extends ActionContext = ActionContext,
  const O extends ResourceTypeOptions = ResourceTypeOptions,
>(
  service: Service<any, any>,
  config: ResourceConfig<TTable, TCtx> & O,
): Resource<TTable, TCtx, ResourceIdentity<TTable, O>> {
  const columns = getTableColumns(
    config.table as Parameters<typeof getTableColumns>[0],
  );
  const primary = Object.entries(columns).filter(
    ([, column]) => column.primary,
  );
  const id: Column | undefined =
    config.id ?? (primary.length === 1 ? primary[0]?.[1] : undefined);
  const entry = Object.entries(columns).find(([, column]) => column === id);
  if (!entry || !id)
    throw new Error(
      `Resource '${config.name}' requires an id column belonging to its table`,
    );
  if (
    !config.name ||
    config.name.includes("/") ||
    ["__proto__", "constructor", "prototype"].includes(config.name)
  )
    throw new Error(`Invalid resource name '${config.name}'`);
  portOf(service).registerTable(config.table);
  const resource = {
    name: config.name,
    serviceName: service.name,
    table: config.table,
    id,
    idField: entry[0],
    config: Object.freeze({ ...config, id }),
    use(plugin: ResourcePlugin<any, any, any>) {
      return installPlugin(
        service,
        resource as unknown as Resource<
          TTable,
          TCtx,
          ResourceIdentity<TTable, O>
        >,
        plugin,
      );
    },
    action(
      actionConfig: ResourceActionConfig<any, any, any, any, any, boolean>,
    ) {
      return defineResourceAction(
        service,
        resource as unknown as Resource<any, any, any>,
        actionConfig,
      );
    },
    command(name: string, commandConfig: CommandConfig<any, any, any, any>) {
      return defineCommand(
        service,
        resource as unknown as Resource<any, any, any>,
        name,
        commandConfig as CommandConfig<
          any,
          any,
          any,
          any,
          any,
          any,
          any,
          readonly string[]
        >,
      );
    },
  };
  return resource as unknown as Resource<
    TTable,
    TCtx,
    ResourceIdentity<TTable, O>
  >;
}
