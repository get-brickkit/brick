import { createBrickClient, type BrickClient } from "./client";
import type { BrickApp } from "./endpoints";
import { resetGlobalRegistry } from "./registry";
import { brick, type CreateServerOptions } from "./server";

export interface TestAppOptions<TContract> extends CreateServerOptions {
  /** Actions (or a generated contract) the typed `client` calls, e.g. `{ orders: { ship } }`. */
  contract?: TContract;
}

export interface TestApp<TContract> {
  app: BrickApp;
  /** Typed client whose requests go straight to `app.handle`, without a port. */
  client: BrickClient<TContract>;
  /** `fetch` against the app: `await fetch("/api/orders/ship", { method: "POST" })`. */
  fetch(path: string | URL, init?: RequestInit): Promise<Response>;
  /** Stops the app if it was listening and empties the global registry. */
  cleanup(): Promise<void>;
}

/**
 * Build an app for a test, with a typed client and a cleanup. Pass a function
 * to define the services inside it: the global registry is emptied first, so
 * the app sees only what that function defines.
 *
 * @example
 * const { client, cleanup } = createTestApp(() => {
 *   const orders = defineService("orders");
 *   const ship = orders.action({ name: "ship", execute: () => "shipped" });
 *   return { services: [orders], contract: { orders: { ship } } };
 * });
 * expect(await client.orders.ship()).toBe("shipped");
 * await cleanup();
 */
export function createTestApp<
  TContract extends Record<string, any> = Record<string, any>,
>(
  options: TestAppOptions<TContract> | (() => TestAppOptions<TContract>),
): TestApp<TContract> {
  if (typeof options === "function") {
    resetGlobalRegistry();
    options = options();
  }
  const { contract, ...appOptions } = options;
  const app = brick({ requestLogging: false, ...appOptions });
  const fetch = (path: string | URL, init?: RequestInit) =>
    app.handle(new Request(new URL(path, "http://localhost"), init));
  return {
    app,
    client: createBrickClient<TContract>({
      baseUrl: "http://localhost",
      prefix: app.definition.prefix,
      contract,
      fetch: fetch as typeof globalThis.fetch,
    }),
    fetch,
    async cleanup() {
      if (app.server) await app.stop(true);
      resetGlobalRegistry();
    },
  };
}
