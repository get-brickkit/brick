import type { ActionContext } from "./types";

/** Where `hooks.*` stores a plugin's hooks on its host; `@brickkit/crud` runs them. */
export const HOST_HOOKS = Symbol.for("brickkit.plugin.hooks");

interface HookBase<C> {
  ctx: C;
  /** The write's open transaction: write other tables through it. */
  tx: any;
}

/** The arguments each host CRUD hook receives, by hook name. */
export interface PluginHookArgs<C = ActionContext> {
  beforeCreate: HookBase<C> & { data: Record<string, unknown> };
  afterCreate: HookBase<C> & { row: Record<string, unknown> };
  beforeUpdate: HookBase<C> & { id: unknown; data: Record<string, unknown> };
  afterUpdate: HookBase<C> & { id: unknown; row: Record<string, unknown> };
  beforeDelete: HookBase<C> & { id: unknown };
  afterDelete: HookBase<C> & { id: unknown };
  afterCommit: {
    operation: "create" | "update" | "delete";
    id: unknown;
    row?: Record<string, unknown>;
    ctx: C;
  };
}

/**
 * Subscribe to the host's CRUD writes (resources with `crud()`). `before*` and
 * `after*` run inside the write's transaction, after the host's own crud hooks;
 * a hook that throws rolls the write back. `afterCommit` runs after the commit.
 */
export type PluginHooks<C = ActionContext> = {
  [K in keyof PluginHookArgs<C>]: (
    hook: (args: PluginHookArgs<C>[K]) => unknown,
  ) => void;
};

export type HostHooks = {
  [K in keyof PluginHookArgs]?: ((args: PluginHookArgs[K]) => unknown)[];
};

// A record, so adding a hook to `PluginHookArgs` without listing it here fails to compile.
const HOOKS: Record<keyof PluginHookArgs, true> = {
  beforeCreate: true,
  afterCreate: true,
  beforeUpdate: true,
  afterUpdate: true,
  beforeDelete: true,
  afterDelete: true,
  afterCommit: true,
};
export const HOOK_NAMES = Object.keys(HOOKS) as (keyof PluginHookArgs)[];

/** The plugin hooks installed on a service or resource, by hook name. */
export function getHostHooks(host: object): HostHooks | undefined {
  return (host as Record<symbol, HostHooks | undefined>)[HOST_HOOKS];
}

/** Add hooks to a host, after those already there. */
export function addHostHooks(host: object, added: HostHooks): void {
  const store = ((host as Record<symbol, HostHooks>)[HOST_HOOKS] ??= {});
  for (const name of HOOK_NAMES)
    if (added[name])
      (store[name] ??= [] as never[]).push(...(added[name] as never[]));
}
