import { beforeEach, describe, expect, it } from "bun:test";
import {
  brick,
  defineDatabase,
  defineService,
  defineServicePlugin,
  defineResourcePlugin,
  getPluginActionRoute,
  getPluginEndpoints,
  generateOpenApiSpec,
  resetGlobalRegistry,
  sqliteTable,
  text,
  t,
  type ServicePluginContext,
  type ResourcePluginContext,
} from "../src";

beforeEach(resetGlobalRegistry);
const pages = sqliteTable("plugin_pages", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
function makeHost() {
  return defineService("pages", {
    database: defineDatabase({ tables: { pages } }),
    context: () => ({ user: { id: "alice" } }),
  });
}
function greeting(
  routes?:
    | false
    | { hello?: false | { path?: string; scope?: "app" | "service" } },
) {
  return defineServicePlugin({
    name: "greeting",
    routes,
    setup({ routes }) {
      const hello = routes.action({
        name: "hello",
        method: "GET",
        path: "/hello",
        input: t.Object({ name: t.String() }),
        output: t.Object({ message: t.String() }),
        execute: ({ input }) => ({ message: `Hello ${input.name}` }),
      });
      return { hello };
    },
  });
}

describe("plugin installation", () => {
  it("allows a parent to catch a failed dependency and return a successful dependency API", async () => {
    const service = makeHost();
    const broken = defineServicePlugin({
      name: "broken",
      setup() {
        throw new Error("broken");
      },
    });
    const child = greeting();
    const parent = defineServicePlugin({
      name: "parent",
      setup({ service }) {
        try {
          service.use(broken);
        } catch {}
        return { child: service.use(child) };
      },
    });
    const api = service.use(parent);
    expect(await api.child.hello({ input: { name: "Ada" } })).toEqual({
      message: "Hello Ada",
    });
    expect(service.use(parent)).toBe(api);
    expect(
      (getPluginActionRoute(api.child.hello) || undefined)?.clientPath,
    ).toEqual(["pages", "hello"]);
    expect(() => service.build()).not.toThrow();
  });
  it("rejects undeclared action path parameters and builds during setup", () => {
    const service = makeHost();
    const incompatible = defineServicePlugin({
      name: "path",
      routes: { get: { path: "/:other" } },
      setup({ routes }) {
        return {
          get: routes.action({
            name: "get",
            method: "GET",
            path: "/:id",
            input: t.Object({ id: t.String() }),
            execute: ({ input }) => input.id,
          }),
        };
      },
    });
    expect(() => service.use(incompatible)).toThrow("input schema");
    expect(() =>
      service.use(
        defineServicePlugin({
          name: "build",
          setup({ service }) {
            service.build();
          },
        }),
      ),
    ).toThrow("during plugin setup");
    expect(() => service.build()).not.toThrow();
  });

  it("reuses descriptor identity per host, rejects conflicting configured instances and freezes registration", async () => {
    const service = makeHost();
    const plugin = greeting();
    const api = service.use(plugin);
    expect(service.use(plugin)).toBe(api);
    expect(await api.hello({ input: { name: "Ada" } })).toEqual({
      message: "Hello Ada",
    });
    expect(() => service.use(greeting())).toThrow("different descriptor");
    service.build();
    expect(() => service.use(plugin)).toThrow("before service build");
  });
  it("supports independent resource hosts with typed named contributions", async () => {
    const service = makeHost();
    const first = service.resource({ name: "page", table: pages });
    const second = service.resource({ name: "post", table: pages });
    const plugin = defineResourcePlugin({
      name: "labels",
      setup({ resource, routes }) {
        const label = routes.action({
          name: "label",
          method: "GET",
          path: "/label",
          output: t.String(),
          execute: () => resource.name,
        });
        return { labels: { label } };
      },
    });
    const page = first.use(plugin);
    const post = second.use(plugin);
    expect(page === first).toBe(true);
    expect(first.use(plugin)).toBe(page);
    expect(await page.labels.label({})).toBe("page");
    expect(await post.labels.label({})).toBe("post");
    expect(getPluginActionRoute(page.labels.label, "/v2")).toEqual({
      method: "GET",
      path: "/v2/pages/page/label",
      clientPath: ["pages", "page", "labels", "label"],
      plugin: "labels",
      resource: "page",
    });
    expect(page.table).toBe(pages);
  });
  it("keeps disabled routes callable locally and applies prefix-aware overrides", async () => {
    const service = makeHost();
    const local = service.use(greeting(false));
    expect(getPluginActionRoute(local.hello)).toBe(false);
    expect(await local.hello({ input: { name: "Ada" } })).toEqual({
      message: "Hello Ada",
    });
    expect(
      JSON.stringify(generateOpenApiSpec({ services: [service] })),
    ).not.toContain("greeting");
    const other = defineService("other");
    const api = other.use(
      greeting({ hello: { scope: "app", path: "/welcome" } }),
    );
    expect(getPluginActionRoute(api.hello, "/v3")).toEqual({
      method: "GET",
      path: "/v3/welcome",
      clientPath: ["other", "hello"],
      plugin: "greeting",
      resource: undefined,
    });
  });
  it("stores bindings on the action for bundler-duplicated core copies", async () => {
    // SSR runtimes (Vite, Nitro) may load a second copy of core whose
    // WeakMaps miss; the binding travels on the action via a global symbol.
    const key = Symbol.for("brickkit.action.meta");
    type Meta = Record<symbol, { route?: { enabled: boolean } }>;
    const service = makeHost();
    const api = service.use(greeting());
    expect((api.hello as unknown as Meta)[key]?.route?.enabled).toBe(true);
    const disabled = defineService("muted").use(greeting({ hello: false }));
    expect((disabled.hello as unknown as Meta)[key]?.route?.enabled).toBe(
      false,
    );
    expect(getPluginActionRoute(disabled.hello)).toBe(false);
  });
  it("rolls back registrations, dependencies, and resource contributions when setup fails", () => {
    const service = makeHost();
    const resource = service.resource({ name: "page", table: pages });
    const baseline = service.listActions();
    const label = defineResourcePlugin({
      name: "label",
      setup: () => ({ labels: "ok" }),
    });
    const dependency = greeting();
    const broken = defineServicePlugin({
      name: "broken",
      setup({ service, routes }) {
        service.use(dependency);
        resource.use(label);
        routes.endpoint({
          name: "raw",
          method: "GET",
          path: "/raw",
          handler: () => "raw",
        });
        throw new Error("failed setup");
      },
    });
    expect(() => service.use(broken)).toThrow("failed setup");
    expect(service.listActions()).toEqual(baseline);
    expect("labels" in resource).toBe(false);
    expect(getPluginEndpoints(service)).toEqual([]);
    expect(service.use(dependency).hello).toBeDefined();
    expect(resource.use(label).labels).toBe("ok");
  });
  it("rejects cycles, contribution collisions, duplicate route names and unknown overrides", () => {
    const service = makeHost();
    const cyclic = defineServicePlugin({
      name: "cycle",
      setup({ service }): void {
        service.use(cyclic);
      },
    });
    expect(() => service.use(cyclic)).toThrow("cycle");
    const resource = service.resource({ name: "page", table: pages });
    expect(() =>
      resource.use(
        defineResourcePlugin({
          name: "invalid",
          setup: () => ({ name: "replace" }),
        }),
      ),
    ).toThrow("collides");
    const duplicate = defineServicePlugin({
      name: "duplicate",
      setup({ routes }) {
        routes.endpoint({
          name: "raw",
          method: "GET",
          path: "/raw",
          handler: () => "one",
        });
        routes.endpoint({
          name: "raw",
          method: "GET",
          path: "/other",
          handler: () => "two",
        });
      },
    });
    expect(() => service.use(duplicate)).toThrow("Duplicate plugin route name");
    expect(() =>
      service.use(greeting({ hello: { path: "/../escape" } })),
    ).toThrow("Invalid plugin route path");
    expect(() =>
      service.use(
        defineServicePlugin({
          name: "unknown",
          routes: { missing: false },
          setup: () => ({}),
        }),
      ),
    ).toThrow("unknown route");
  });
  it("resolves typed service context for raw endpoints and closes the route registrar after setup", async () => {
    const service = makeHost();
    let saved:
      | Parameters<
          Parameters<typeof defineServicePlugin>[0]["setup"]
        >[0]["routes"]
      | undefined;
    service.use(
      defineServicePlugin({
        name: "raw",
        setup({ routes }) {
          saved = routes;
          routes.endpoint({
            name: "who",
            method: "GET",
            path: "/who",
            handler: ({ ctx }) => ctx.user.id,
          });
        },
      }),
    );
    const app = brick({ services: [service], requestLogging: false });
    const response = await app.handle(
      new Request("http://localhost/api/pages/who"),
    );
    expect(await response.text()).toBe("alice");
    expect(() =>
      saved!.endpoint({
        name: "late",
        method: "GET",
        path: "/late",
        handler: () => "late",
      }),
    ).toThrow("during setup");
  });
  it("exports scoped resource-plugin actions under public names with plugin/resource metadata (issue #27)", async () => {
    const { getGlobalRegistry } = await import("../src");
    const service = makeHost();
    const resource = service.resource({ name: "page", table: pages });
    const api = resource.use(
      defineResourcePlugin({
        name: "@brickkit/crud",
        setup({ routes }) {
          const list = routes.action({
            name: "list",
            method: "POST",
            path: "/query",
            output: t.Object({ items: t.Array(t.String()) }),
            execute: () => ({ items: [] }),
          });
          const get = routes.action({
            name: "get",
            method: "GET",
            path: "/:id",
            input: t.Object({ id: t.String() }),
            output: t.String(),
            execute: ({ input }) => input.id,
          });
          return { list, get };
        },
      }),
    );
    expect(api.list.name).toBe("page.list");
    expect(api.get.name).toBe("page.get");
    expect(
      service
        .listActions()
        .map((action) => action.name)
        .sort(),
    ).toEqual(["page.get", "page.list"]);
    expect(getPluginActionRoute(api.list)).toMatchObject({
      plugin: "@brickkit/crud",
      resource: "page",
    });
    const architecture = getGlobalRegistry().exportArchitecture();
    const names = architecture.services.flatMap((s) =>
      s.actions.map((a) => a.name),
    );
    expect(names).toContain("page.list");
    expect(names).toContain("page.get");
    expect(names.some((n) => n.includes("@brickkit/crud"))).toBe(false);
    const listed = architecture.services
      .flatMap((s) => s.actions)
      .filter((a) => a.name === "page.list");
    expect(listed[0]?.plugin).toBe("@brickkit/crud");
    expect(listed[0]?.resource).toBe("page");
    const svc = makeHost();
    const helloApi = svc.use(
      defineServicePlugin({
        name: "@brickkit/greeting",
        setup({ routes }) {
          const hello = routes.action({
            name: "hello",
            method: "GET",
            path: "/hello",
            output: t.String(),
            execute: () => "hi",
          });
          return { hello };
        },
      }),
    );
    expect(helloApi.hello.name).toBe("hello");
    expect(
      svc.listActions().some((n) => n.name.includes("@brickkit/greeting")),
    ).toBe(false);
    const spec = generateOpenApiSpec({ services: [service] });
    const ops = Object.values(spec.paths).flatMap((p) =>
      Object.values(p as Record<string, any>),
    ) as any[];
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(op.operationId).not.toContain("@brickkit/crud");
      expect(op.summary).not.toContain("@brickkit/crud");
    }
    expect(JSON.stringify(ops).includes("page.list")).toBe(true);
  });
});

// Compile-time assertions run as part of core's typecheck.
function checkPluginTypes() {
  const service = makeHost();
  type TypedService = typeof service;
  const plugin = defineServicePlugin({
    name: "typed",
    setup({ routes }: ServicePluginContext<TypedService>) {
      const who = routes.action({
        name: "who",
        method: "GET",
        path: "/who",
        input: t.Object({ suffix: t.String() }),
        output: t.String(),
        authorize: ({ ctx }) => ctx.user.id !== "",
        execute: ({ ctx, input }) => {
          const id: string = ctx.user.id;
          const column: typeof pages.title =
            ctx.db._.schema!.pages.columns.title;
          // @ts-expect-error Context preserves the concrete database schema.
          void ctx.db._.schema!.missing;
          // @ts-expect-error Input derives from TypeBox.
          void input.missing;
          void column;
          return id + input.suffix;
        },
      });
      return { who };
    },
  });
  const api = service.use(plugin);
  const output: Promise<string> = api.who({ input: { suffix: "!" } });
  // @ts-expect-error Missing required schema field.
  api.who({ input: {} });
  // @ts-expect-error API inference has no arbitrary property.
  void api.missing;
  const resource = service.resource({ name: "page", table: pages });
  type TypedResource = typeof resource;
  const labeled = resource.use(
    defineResourcePlugin({
      name: "typed-label",
      setup({
        resource,
        routes,
      }: ResourcePluginContext<TypedService, TypedResource>) {
        const table: typeof pages = resource.table;
        void table;
        const count = routes.action({
          name: "count",
          method: "GET",
          path: "/count",
          output: t.Integer(),
          execute: () => 1,
        });
        return { labels: { count } };
      },
    }),
  );
  const count: Promise<number> = labeled.labels.count({});
  // @ts-expect-error Table type survives resource extension.
  void labeled.table.missing;
  // @ts-expect-error Contributions are inferred precisely.
  labeled.labels.missing();
  const plainService = defineService("plain", {
    database: defineDatabase({ tables: { pages } }),
  });
  const plainResource = plainService.resource({ name: "plain", table: pages });
  const requiresUser = defineResourcePlugin({
    name: "requires-user",
    setup({ service }: ResourcePluginContext<TypedService, TypedResource>) {
      return { reveal: async () => (await service.resolveContext()).user.id };
    },
  });
  resource.use(requiresUser);
  // @ts-expect-error A resource plugin requiring user context cannot install on another host.
  plainResource.use(requiresUser);
  // @ts-expect-error Service plugins preserve required service context too.
  plainService.use(plugin);
  defineServicePlugin({
    name: "async",
    // @ts-expect-error Setup registers declarations synchronously.
    setup: async () => ({}),
  });
  defineResourcePlugin({
    name: "async-resource",
    // @ts-expect-error Resource setup is synchronous too.
    setup: async () => ({}),
  });
  void output;
  void count;
}
void checkPluginTypes;
