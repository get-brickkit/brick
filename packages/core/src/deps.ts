import { AsyncLocalStorage } from "node:async_hooks";
import type { Service } from "./types";
import { portOf } from "./service-port";

/** Where a listener a plugin added keeps the plugin's deps, for its handler and workflow steps; global so a second core copy finds it. */
export const PLUGIN_DEPS: unique symbol = Symbol.for("brickkit.plugin.deps");

const running = new AsyncLocalStorage<Record<string, unknown>>();

/** Run `fn` with the deps of one app, so `useDeps()` inside it finds them. */
export function runWithDeps<T>(deps: Record<string, unknown>, fn: () => T): T {
  return running.run(deps, fn);
}

/**
 * The deps of the services of the app that is running the current listener,
 * schedule or workflow step. Actions, tools and socket handlers read `ctx.deps`
 * instead.
 *
 * A workflow step is a plain function the Workflow SDK calls by name, so it
 * cannot close over the service or app that started it. Brick runs every
 * listener and every step inside its app, and this returns the `deps` of all
 * the app's services, by name. A name two services give different values has
 * no single answer, so reading it throws.
 *
 * @returns The deps, typed as `T`.
 * @throws When called outside a listener, schedule or workflow step of a Brick
 * app, or on reading a name two services give different values.
 * @example
 * async function bookCarrier(orderId: string) {
 *   "use step";
 *   return useDeps<{ carrier: Carrier }>().carrier.book(orderId);
 * }
 */
export function useDeps<T = Record<string, unknown>>(): T {
  const deps = running.getStore();
  if (!deps)
    throw new Error(
      "useDeps() was called outside a Brick app: call it from a listener, a schedule or a workflow step (actions read ctx.deps).",
    );
  return deps as T;
}

/** What `useDeps()` returns in an app's own listeners, schedules and workflow steps: every service's deps, by name. */
export function appDeps(
  services: readonly Service<any, any>[],
): Record<string, unknown> {
  const deps: Record<string, unknown> = {};
  const first = new Map<string, { service: string; value: unknown }>();
  for (const service of services)
    for (const [name, value] of Object.entries(portOf(service).deps)) {
      const seen = first.get(name);
      if (!seen) {
        first.set(name, { service: service.name, value });
        deps[name] = value;
      } else if (seen.value !== value)
        Object.defineProperty(deps, name, {
          enumerable: true,
          configurable: true,
          get() {
            throw new Error(
              `useDeps().${name} is ambiguous: services "${seen.service}" and "${service.name}" both declare dep "${name}" with different values. Give one of them another name.`,
            );
          },
        });
    }
  return Object.freeze(deps);
}
