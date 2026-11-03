import { beforeEach, expect, it } from "bun:test";
import {
  defineService,
  getGlobalRegistry,
  resetGlobalRegistry,
  brick,
} from "@brickkit/core";

beforeEach(resetGlobalRegistry);
const request = (path: string) => new Request("http://localhost" + path);

it("pre-renders built-in pages and reuses identical JSON across repeated requests", async () => {
  const service = defineService("internal");
  service.action({ name: "getReady", execute: () => ({ ok: true }) });
  const settings = {
    services: [service],
    requestLogging: false,
    reference: true,
    title: "Internal API",
  };
  const compiled = brick(settings),
    generic = brick({ ...settings, compiler: false });
  for (const path of [
    "/docs",
    "/swagger",
    "/reference",
    "/openapi.json",
    "/_brick/services",
  ]) {
    const baseline = await generic.handle(request(path));
    const body = await baseline.text();
    for (let i = 0; i < 3; i++) {
      const response = await compiled.handle(request(path));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        baseline.headers.get("content-type"),
      );
      expect(await response.text()).toBe(body);
    }
  }
  const first = await (await compiled.handle(request("/_health"))).json();
  await Bun.sleep(2);
  const second = await (await compiled.handle(request("/_health"))).json();
  expect(second.status).toBe("ok");
  expect(second.timestamp).toBeGreaterThan(first.timestamp);
  expect(second.uptime).toBeGreaterThan(first.uptime);
});

it("invalidates architecture metadata while keeping the mounted app services", async () => {
  const service = defineService("initial");
  const registry = getGlobalRegistry();
  const original = registry.exportArchitecture.bind(registry);
  let exports = 0;
  registry.exportArchitecture = (application) => {
    exports++;
    return original(application);
  };
  const app = brick({ requestLogging: false });
  for (let i = 0; i < 3; i++)
    await (await app.handle(request("/_brick/services"))).json();
  expect(exports).toBe(1);
  service.action({ name: "newAction", execute: () => null });
  const changed = await (await app.handle(request("/_brick/services"))).json();
  expect(changed.services[0].actions[0].name).toBe("newAction");
  expect(changed.services[0].actions[0]).not.toHaveProperty("method");
  expect(changed.services[0].actions[0]).not.toHaveProperty("path");
  expect(exports).toBe(2);
  defineService("newService");
  expect(
    (await (await app.handle(request("/_brick/services"))).json()).services,
  ).toHaveLength(1);
  registry.clear();
  expect(
    (await (await app.handle(request("/_brick/services"))).json()).services,
  ).toHaveLength(1);
  resetGlobalRegistry();
  defineService("replacement");
  expect(
    (await (await app.handle(request("/_brick/services"))).json()).services[0]
      .name,
  ).toBe("initial");
});

it("includes startup endpoints and invalidates OpenAPI when service definitions change", async () => {
  const service = defineService("spec");
  const app = brick({
    services: [service],
    requestLogging: false,
    endpoints: [{ method: "GET", path: "/first", handler: () => "first" }],
  });
  app.endpoint({ method: "GET", path: "/later", handler: () => "later" });
  const initial = await (await app.handle(request("/openapi.json"))).json();
  expect(initial.paths["/first"]).toBeDefined();
  expect(initial.paths["/later"]).toBeDefined();
  service.action({ name: "laterAction", execute: () => "later" });
  const spec = await (await app.handle(request("/openapi.json"))).json();
  expect(spec.paths["/later"]).toBeDefined();
  expect(spec.paths["/api/spec/later-action"]).toBeDefined();
  expect(await (await app.handle(request("/openapi.json"))).json()).toEqual(
    spec,
  );
});

it("keeps endpoint metadata unchanged when Elysia rejects registration after sealing", async () => {
  const app = brick({ requestLogging: false });
  const initial = await (await app.handle(request("/openapi.json"))).json();
  const endpoint = {
    method: "GET" as const,
    path: "/late",
    handler: () => "late",
  };
  // A failed attempt must not mark the route registered or add it to the spec.
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(() => app.endpoint(endpoint)).toThrow("sealed");
    expect(app.listEndpoints()).toEqual([]);
    expect(await (await app.handle(request("/openapi.json"))).json()).toEqual(
      initial,
    );
  }
  expect((await app.handle(request("/late"))).status).toBe(404);
});
