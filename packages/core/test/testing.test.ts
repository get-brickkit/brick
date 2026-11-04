import { expect, it, spyOn } from "bun:test";
import { defineListener, defineService, getGlobalRegistry, t } from "../src";
import { compileBrickApplication } from "../src/compiler";
import { createTestApp } from "../src/testing";

it("defines services in an empty registry and calls them through a typed client", async () => {
  defineService("leftover");
  const { app, client, fetch, cleanup } = createTestApp(() => {
    const orders = defineService("orders");
    const ship = orders.action({
      name: "ship",
      input: t.Object({ id: t.String() }),
      output: t.Object({ tracking: t.String() }),
      execute: ({ input }) => ({ tracking: `trk_${input.id}` }),
    });
    return { prefix: "/v1", contract: { orders: { ship } } };
  });
  // Without `services`, the app takes the registry, which holds only `orders`.
  expect(app.definition.services.map((service) => service.name)).toEqual([
    "orders",
  ]);
  expect(await client.orders.ship({ id: "o1" })).toEqual({
    tracking: "trk_o1",
  });
  const response = await fetch("/v1/orders/ship", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "o2" }),
  });
  expect(await response.json()).toEqual({ tracking: "trk_o2" });

  app.listen(0);
  await cleanup();
  expect(app.server).toBeFalsy();
  expect(getGlobalRegistry().list()).toEqual([]);
});

it("points the client at the prefix a compilation gives the app", async () => {
  const { app, client, cleanup } = createTestApp(() => {
    const orders = defineService("orders");
    const ship = orders.action({ name: "ship", execute: () => "shipped" });
    return {
      services: [orders],
      compilation: compileBrickApplication({
        services: [orders],
        prefix: "/v1",
      }),
      contract: { orders: { ship } },
    };
  });
  expect(app.definition.prefix).toBe("/v1");
  expect(await client.orders.ship()).toBe("shipped");
  await cleanup();
});

it("stops the events hub on cleanup", async () => {
  const { app, cleanup } = createTestApp({
    services: [],
    events: {
      dispatch: { timer: false },
      listeners: [defineListener({ name: "h", on: "x", run: () => {} })],
    },
  });
  app.events!.start();
  const stop = spyOn(app.events!, "stop");
  await cleanup();
  expect(stop).toHaveBeenCalledTimes(1);
});
