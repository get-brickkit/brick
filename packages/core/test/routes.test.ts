import { beforeEach, expect, it } from "bun:test";
import {
  brick,
  defineDatabase,
  defineResourcePlugin,
  defineService,
  defineServicePlugin,
  getActionRoute,
  kebabCase,
  resetGlobalRegistry,
  sqliteTable,
  t,
  text,
} from "../src";

beforeEach(resetGlobalRegistry);

const items = sqliteTable("route_items", { id: text("id").primaryKey() });

const routesOf = (app: ReturnType<typeof brick>) =>
  app.definition.routes.map((route) => `${route.method} ${route.path}`);

it("turns declared names into kebab-case segments", () => {
  expect(kebabCase("orderBilling")).toBe("order-billing");
  expect(kebabCase("getSummary")).toBe("get-summary");
  expect(kebabCase("importCSV")).toBe("import-csv");
  expect(kebabCase("orderItem")).toBe("order-item");
  expect(kebabCase("already-kebab")).toBe("already-kebab");
  expect(kebabCase("admin.resetAll")).toBe("admin.reset-all");
});

it("mounts service actions, explicit relative paths, sockets and plugin scopes on the owner tree", () => {
  const service = defineService("orderBilling", {
    database: defineDatabase({ tables: { items } }),
  });
  const summary = service.action({
    name: "getSummary",
    method: "GET",
    execute: () => 1,
  });
  service.action({
    name: "byId",
    method: "GET",
    path: "/:id/summary",
    input: t.Object({ id: t.String() }),
    execute: () => 1,
  });
  service.socket({ name: "liveFeed", input: {}, output: {}, handlers: {} });
  service.use(
    defineServicePlugin({
      name: "scopes",
      setup({ routes }) {
        routes.action({
          name: "status",
          method: "GET",
          path: "/status",
          execute: () => 1,
        });
        routes.action({
          name: "ping",
          method: "GET",
          path: "/ping",
          scope: "app",
          execute: () => 1,
        });
        return {};
      },
    }),
  );
  service.resource({ name: "orderItem", table: items }).use(
    defineResourcePlugin({
      name: "tags",
      setup({ routes }) {
        routes.action({
          name: "tags",
          method: "GET",
          path: "/tags",
          execute: () => 1,
        });
        return {};
      },
    }),
  );
  expect(getActionRoute(summary)).toEqual({
    method: "GET",
    path: "/api/order-billing/get-summary",
  });
  const app = brick({ services: [service], docs: false });
  expect(routesOf(app)).toEqual([
    "GET /api/order-billing/get-summary",
    "GET /api/order-billing/:id/summary",
    "GET /api/order-billing/status",
    "GET /api/ping",
    "GET /api/order-billing/order-item/tags",
  ]);
  expect(app.definition.sockets[0]?.path).toBe("/api/order-billing/live-feed");
});

it("fails at startup when an action, a resource and a socket share a segment", () => {
  const actionAndResource = defineService("shop", {
    database: defineDatabase({ tables: { items } }),
  });
  actionAndResource.resource({ name: "orderItem", table: items });
  actionAndResource.action({ name: "order-item", execute: () => 1 });
  expect(() => brick({ services: [actionAndResource] })).toThrow(
    'duplicate name "order-item" in service "shop"',
  );

  resetGlobalRegistry();
  const socketAndAction = defineService("chat");
  socketAndAction.socket({ name: "live", input: {}, output: {}, handlers: {} });
  socketAndAction.action({ name: "live", execute: () => 1 });
  expect(() => brick({ services: [socketAndAction] })).toThrow(
    /duplicate name "live" in service "chat": socket "live" and action "live"/,
  );
});
