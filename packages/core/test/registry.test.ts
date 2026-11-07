import { beforeEach, expect, it } from "bun:test";
import {
  brick,
  defineDatabase,
  defineService,
  DuplicateNameError,
  getGlobalRegistry,
  resetGlobalRegistry,
  sqliteTable,
  text,
} from "../src";
import {
  defineElsewhere,
  defineServiceElsewhere,
} from "./fixtures/define-elsewhere";

beforeEach(resetGlobalRegistry);

it("exports default routes and a single database config before an app is created", () => {
  const service = defineService("records", { database: defineDatabase() });
  service.action({ name: "save", execute: () => true });
  const schema = getGlobalRegistry().exportArchitecture().services[0]!;
  expect(schema.actions[0]).toMatchObject({
    name: "save",
    method: "POST",
    path: "/api/records/save",
  });
  expect(schema.options).not.toHaveProperty("database");
  expect(schema.databaseConfig).toMatchObject({ engine: "sqlite" });
});

it("lists a service's tools next to its actions", () => {
  const service = defineService("records");
  service.action({ name: "save", execute: () => true });
  service.tool({ name: "lookup", execute: () => true });
  service.tool({ name: "publish", http: true, execute: () => true });

  const schema = getGlobalRegistry().exportArchitecture().services[0]!;
  expect(schema.tools).toEqual([{ name: "lookup" }, { name: "publish" }]);
  // A tool with an HTTP route is also an action.
  expect(schema.actions.map((action) => action.name)).toEqual([
    "save",
    "publish",
  ]);
});

it("exports only an app's mounted HTTP routes", async () => {
  const service = defineService("records");
  service.action({
    name: "first",
    method: "GET",
    path: "/same",
    execute: () => true,
  });
  service.action({
    name: "shadowed",
    method: "GET",
    path: "/same",
    execute: () => false,
  });
  service.action({ name: "save", execute: () => true });
  service.action({
    name: "health",
    method: "GET",
    path: "/_health",
    execute: () => false,
  });
  service.action({
    name: "raw",
    method: "GET",
    path: "/raw",
    execute: () => false,
  });
  service.tool({ name: "internal", execute: () => true });
  const first = brick({
    services: [service],
    prefix: "/v2",
    requestLogging: false,
    endpoints: [
      { method: "GET", path: "/v2/records/raw", handler: () => true },
    ],
  });
  const registry = getGlobalRegistry();
  const architecture = registry.exportArchitecture(first.definition);
  expect(
    architecture.services[0]!.actions.find((action) => action.name === "save"),
  ).toMatchObject({ method: "POST", path: "/v2/records/save" });
  // An explicit path is relative to its service, so it can't take `/_health`.
  expect(
    architecture.services[0]!.actions.find(
      (action) => action.name === "health",
    ),
  ).toMatchObject({ method: "GET", path: "/v2/records/_health" });
  expect(
    architecture.services[0]!.actions.some(
      (action) => action.name === "internal",
    ),
  ).toBe(false);
  for (const name of ["shadowed", "raw"]) {
    const action = architecture.services[0]!.actions.find(
      (action) => action.name === name,
    );
    expect(action).toBeDefined();
    expect(action).not.toHaveProperty("method");
    expect(action).not.toHaveProperty("path");
  }
  const second = brick({
    services: [service],
    prefix: "/v3",
    requestLogging: false,
  });
  expect(
    registry
      .exportArchitecture(second.definition)
      .services[0]!.actions.find((action) => action.name === "save"),
  ).toMatchObject({ method: "POST", path: "/v3/records/save" });
  const response = await first.handle(
    new Request("http://localhost/_brick/services"),
  );
  expect(await response.json()).toEqual(
    JSON.parse(JSON.stringify(architecture)),
  );
  resetGlobalRegistry();
  expect(getGlobalRegistry().exportArchitecture().services).toEqual([]);
});

it("keeps declarations open when exporting before app construction", () => {
  const service = defineService("setup");
  service.action({ name: "first", execute: () => true });
  getGlobalRegistry().exportArchitecture();
  expect(service.isBuilt).toBe(false);
  const table = sqliteTable("later", { id: text("id").primaryKey() });
  expect(() => service.resource({ name: "later", table })).not.toThrow();
  expect(() =>
    service.contributePreparation({
      name: "later",
      describe: () => undefined,
      prepare: () => undefined,
    }),
  ).not.toThrow();
  service.action({ name: "second", method: "GET", execute: () => true });
  const architecture = getGlobalRegistry().exportArchitecture();
  expect(
    architecture.services[0]!.actions.find(
      (action) => action.name === "second",
    ),
  ).toMatchObject({ method: "GET", path: "/api/setup/second" });
  expect(service.isBuilt).toBe(false);
  brick({ services: [service], requestLogging: false });
  expect(service.isBuilt).toBe(true);
});

it("throws on a duplicate action from another file and names both sites", () => {
  const service = defineService("orders");
  service.action({ name: "ship", execute: () => 1 });
  let message = "";
  try {
    defineElsewhere(service, "action", { name: "ship", execute: () => 2 });
  } catch (error) {
    message = (error as Error).message;
  }
  const [title, first, second] = message.split("\n");
  expect(title).toBe('Brick: duplicate action "ship" in service "orders"');
  expect(first).toMatch(/registry\.test\.ts:\d+$/);
  expect(second).toMatch(/define-elsewhere\.ts:\d+$/);
});

it("replaces an action defined again from the same file", async () => {
  const service = defineService("orders");
  for (const value of [1, 2])
    service.action({ name: "ship", execute: () => value });
  expect(service.listActions()).toHaveLength(1);
  expect(await service.getAction("ship")!({})).toBe(2);
});

it("throws on a duplicate service name from another file", () => {
  defineService("orders");
  expect(() => defineServiceElsewhere("orders")).toThrow(
    'Brick: duplicate service "orders"',
  );
});

it("throws on two services with the same name in one app", () => {
  const first = defineService("orders");
  const second = defineService("orders");
  const create = () => brick({ services: [first, second] });
  expect(create).toThrow('Brick: duplicate service "orders" in brick()');
  expect(create).toThrow(DuplicateNameError);
});
