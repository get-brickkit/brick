import { AsyncLocalStorage } from "node:async_hooks";
import type { Service } from "./types";
import { portOf } from "./service-port";

/** Where a listener a plugin added keeps the plugin's deps, for its handler and workflow steps; global so a second core copy finds it. */
export const PLUGIN_DEPS: unique symbol = Symbol.for("brickkit.plugin.deps");

function sharedAcrossCoreCopies<T>(key: string, create: () => T): T {
  const store = globalThis as any;
  return (store[Symbol.for(key)] ??= create());
}

const depsBuiltByBrick = sharedAcrossCoreCopies(
  "brickkit.deps.built",
  () => new WeakSet<object>(),
);

export function freezeAsBuiltDeps<T extends object>(deps: T): Readonly<T> {
  depsBuiltByBrick.add(Object.freeze(deps));
  return deps;
}

export function depsOverride(
  callCtx: unknown,
): Record<string, unknown> | undefined {
  const deps = (callCtx as { deps?: unknown } | undefined)?.deps;
  return deps && typeof deps === "object" && !depsBuiltByBrick.has(deps)
    ? (deps as Record<string, unknown>)
    : undefined;
}

const running = new AsyncLocalStorage<Record<string, unknown>>();

/** Run `fn` with the deps of one app, so `useDeps()` inside it finds them. */
export function runWithDeps<T>(deps: Record<string, unknown>, fn: () => T): T {
  return running.run(deps, fn);
}

export type ServiceDeps<S> =
  S extends Service<any, infer C, any>
    ? C extends { deps: infer D }
      ? Readonly<D>
      : Readonly<Record<string, unknown>>
    : never;

/**
 * The deps of a service, for code that has no `ctx`: listeners, schedules and
 * workflow steps. Actions, tools and socket handlers read `ctx.deps` instead.
 *
 * `useDeps(service)` returns that service's deps, typed from it, anywhere.
 * Without an argument it returns what the running listener, schedule or step
 * sees: in one a plugin added, the deps of that install; in the app's own, the
 * deps of all the app's services by name, for code that cannot import the
 * service (one built in a factory). A name two services give different values
 * has no single answer, so reading it throws.
 *
 * @param service - The service whose deps to return.
 * @returns The deps.
 * @throws Without `service`: when called outside a listener, schedule or
 * workflow step of a Brick app, or on reading a name two services give
 * different values.
 * @example
 * async function bookCarrier(orderId: string) {
 *   "use step";
 *   return useDeps(orders).carrier.book(orderId);
 * }
 */
export function useDeps<S extends Service<any, any, any>>(
  service: S,
): ServiceDeps<S>;
export function useDeps<T = Record<string, unknown>>(): T;
export function useDeps(service?: Service<any, any, any>): unknown {
  if (service) return portOf(service).deps;
  const deps = running.getStore();
  if (!deps)
    throw new Error(
      "useDeps() was called outside a Brick app: call it from a listener, a schedule or a workflow step (actions read ctx.deps), or pass the service: useDeps(service).",
    );
  return deps;
}

function makeAmbiguous(
  deps: Record<string, unknown>,
  name: string,
  firstService: string | undefined,
  otherService: string,
) {
  Object.defineProperty(deps, name, {
    enumerable: false,
    get() {
      throw new Error(
        `useDeps().${name} is ambiguous: services "${firstService}" and "${otherService}" both declare dep "${name}" with different values. Call useDeps(service) with the service you mean.`,
      );
    },
  });
}

export function appDeps(
  services: readonly Service<any, any>[],
): Record<string, unknown> {
  const deps: Record<string, unknown> = {};
  const owner = new Map<string, string>();
  for (const service of services)
    for (const [name, value] of Object.entries(portOf(service).deps)) {
      const seen = Object.getOwnPropertyDescriptor(deps, name);
      const first = owner.get(name);
      if (!seen) {
        owner.set(name, service.name);
        deps[name] = value;
      } else if ("value" in seen && seen.value !== value)
        makeAmbiguous(deps, name, first, service.name);
    }
  return freezeAsBuiltDeps(deps);
}
