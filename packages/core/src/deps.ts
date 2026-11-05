import { AsyncLocalStorage } from "node:async_hooks";

declare const portType: unique symbol;

/** A typed dependency slot, declared with `port<T>()` and filled by `brick({ deps })`. */
export interface Port<T> {
  readonly [portType]?: T;
}

/** The dependency slots of a service: `{ carrier: port<Carrier>() }`. */
export type Ports = Record<string, Port<unknown>>;

/** The values a set of ports is filled with: `{ carrier: Carrier }`. */
export type DepsOf<P> = {
  [K in keyof P]: P[K] extends Port<infer T> ? T : never;
};

/**
 * Declare a dependency a service needs, without creating it. The app provides
 * the value with `brick({ deps })`, and the service's code reads it as
 * `ctx.deps.<name>` (or `useDeps()` in listeners and workflow steps).
 *
 * @returns A slot typed as `T`. It holds nothing at runtime.
 * @example
 * import { defineService, port } from "@brickkit/core";
 *
 * export const orders = defineService("orders", {
 *   database,
 *   deps: { carrier: port<Carrier>() },
 * });
 *
 * // app.ts
 * export default brick({ services: [orders], deps: { carrier: createCarrier() } });
 */
export function port<T>(): Port<T> {
  return Object.freeze({}) as Port<T>;
}

/** Where a listener a plugin added keeps the plugin's deps, for its workflow steps; global so a second core copy finds it. */
export const PLUGIN_DEPS: unique symbol = Symbol.for("brickkit.plugin.deps");

const running = new AsyncLocalStorage<Record<string, unknown>>();

/** Run `fn` with the deps of one app, so `useDeps()` inside it finds them. */
export function runWithDeps<T>(deps: Record<string, unknown>, fn: () => T): T {
  return running.run(deps, fn);
}

/**
 * The deps of the app that is running the current listener or workflow step.
 * Actions, tools and socket handlers read `ctx.deps` instead.
 *
 * A workflow step is a plain function the Workflow SDK calls by name, so it
 * cannot close over the app that started it. Brick runs every listener and every
 * step inside its app, and this returns that app's `brick({ deps })`.
 *
 * @param ports - Optional: the ports to type the result by (the same object a
 * service passes as its `deps` option). Otherwise pass the type: `useDeps<{ carrier: Carrier }>()`.
 * @returns The app's deps.
 * @throws When called outside a listener or workflow step of a Brick app.
 * @example
 * export const ordersDeps = { carrier: port<Carrier>() };
 *
 * async function bookCarrier(orderId: string) {
 *   "use step";
 *   return useDeps(ordersDeps).carrier.book(orderId);
 * }
 */
export function useDeps<const P extends Ports>(ports: P): DepsOf<P>;
export function useDeps<T = Record<string, unknown>>(): T;
export function useDeps(): Record<string, unknown> {
  const deps = running.getStore();
  if (!deps)
    throw new Error(
      "useDeps() was called outside a Brick app: call it from a listener or a workflow step (actions read ctx.deps).",
    );
  return deps;
}

/**
 * Check `brick({ deps })` against what the services declare, and give each
 * service the values of its own ports.
 *
 * @throws When a service declares a dep the app does not provide, or the app
 * provides one that no service declares.
 */
export function bindDeps(
  services: readonly {
    name: string;
    options: { deps?: Ports };
    setDeps?(deps: Record<string, unknown>): void;
  }[],
  provided: Record<string, unknown> = {},
): void {
  const declared = new Set<string>();
  for (const service of services) {
    const own: Record<string, unknown> = {};
    for (const name of Object.keys(service.options.deps ?? {})) {
      if (!Object.hasOwn(provided, name) || provided[name] === undefined)
        throw new Error(
          `Brick: service "${service.name}" declares dep "${name}", but brick({ deps }) does not provide it`,
        );
      declared.add(name);
      own[name] = provided[name];
    }
    service.setDeps?.(Object.freeze(own));
  }
  for (const name of Object.keys(provided))
    if (!declared.has(name))
      throw new Error(
        `Brick: brick({ deps }) provides "${name}", but no service declares it (services: ${services.map((service) => service.name).join(", ") || "none"})`,
      );
}
