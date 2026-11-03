import { beforeEach, expect, it } from "bun:test";
import {
  defineService,
  defineDatabase,
  defineResourcePlugin,
  sqliteTable,
  text,
  defineServicePlugin,
  resetGlobalRegistry,
  t,
  compileBrickApplication,
  brick,
} from "@brickkit/core";
import { generateClientContract } from "../src/client-contract";

beforeEach(resetGlobalRegistry);

for (const compiler of [false, true]) {
  it(`serves configured plugin routes and keeps hidden actions local (compiler=${compiler})`, async () => {
    const service = defineService("discussion");
    const api = service.use(
      defineServicePlugin({
        name: "example/comments",
        routes: {
          list: false,
          count: { scope: "app", path: "/comments/count" },
        },
        setup({ routes }) {
          const list = routes.action({
            name: "list",
            method: "GET",
            path: "/comments",
            output: t.Array(t.String()),
            execute: () => ["local comment"],
          });
          const count = routes.action({
            name: "count",
            method: "GET",
            path: "/comments/count",
            input: t.Object({ minimum: t.Number() }),
            output: t.Object({ count: t.Number() }),
            execute: ({ input }) => ({ count: input.minimum + 1 }),
          });
          routes.endpoint({
            name: "html",
            method: "GET",
            path: "/comments/html",
            handler: () =>
              new Response("<p>Comments</p>", {
                headers: { "content-type": "text/html" },
              }),
          });
          return { comments: { list, count } };
        },
      }),
    );
    const app = brick({
      services: [service],
      prefix: "/v2",
      compiler,
      requestLogging: false,
    });
    expect(await api.comments.list({})).toEqual(["local comment"]);
    const count = await app.handle(
      new Request("http://localhost/v2/comments/count?minimum=2"),
    );
    expect(count.status).toBe(200);
    expect(await count.json()).toEqual({ count: 3 });
    const html = await app.handle(
      new Request("http://localhost/v2/discussion/comments/html"),
    );
    expect(html.status).toBe(200);
    expect(await html.text()).toBe("<p>Comments</p>");
    for (const path of [
      "/v2/discussion/comments",
      "/v2/discussion/comments/count",
      `/v2/discussion/${api.comments.list.name}`,
    ])
      expect(
        (await app.handle(new Request(`http://localhost${path}`))).status,
      ).toBe(404);
    const compilation = compileBrickApplication({
      services: [service],
      prefix: "/v2",
    });
    expect(compilation.ir.routes.map((route) => route.path)).toEqual([
      "/v2/comments/count",
    ]);
    const spec = await (
      await app.handle(new Request("http://localhost/openapi.json"))
    ).json();
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/v2/comments/count",
      "/v2/discussion/comments/html",
    ]);
    const source = generateClientContract(app);
    expect(source).toContain('"comments"');
    expect(source).toContain('"count"');
    expect(source).not.toContain('"list"');
    expect(source).not.toContain('"html"');
    expect(source).toContain("/v2/comments/count");
  });
}

it("disabling every plugin route also disables raw endpoints", async () => {
  const service = defineService("private");
  const api = service.use(
    defineServicePlugin({
      name: "example/private",
      routes: false,
      setup({ routes }) {
        const value = routes.action({
          name: "value",
          method: "GET",
          path: "/value",
          execute: () => 42,
        });
        routes.endpoint({
          name: "html",
          method: "GET",
          path: "/html",
          handler: () => "private",
        });
        return { value };
      },
    }),
  );
  const app = brick({ services: [service], requestLogging: false });
  expect(await api.value({})).toBe(42);
  expect(compileBrickApplication({ services: [service] }).ir.routes).toEqual(
    [],
  );
  expect(app.listEndpoints()).toEqual([]);
  expect(generateClientContract(app)).not.toContain('"value"');
});

it("rejects plugin routes that collide with ordinary actions or endpoints", () => {
  const service = defineService("discussion");
  service.action({
    name: "ordinary",
    method: "GET",
    path: "/comments/:id",
    execute: () => 1,
  });
  service.use(
    defineServicePlugin({
      name: "example/conflict",
      setup({ routes }) {
        return {
          count: routes.action({
            name: "count",
            method: "GET",
            path: "/comments/:commentId",
            input: t.Object({ commentId: t.String() }),
            execute: () => 2,
          }),
        };
      },
    }),
  );
  expect(() => brick({ services: [service] })).toThrow(
    "duplicate plugin route",
  );
});

it("puts independently configured resource plugins in their browser namespaces", async () => {
  const pages = sqliteTable("plugin_pages", { id: text("id").primaryKey() });
  const posts = sqliteTable("plugin_posts", { id: text("id").primaryKey() });
  const database = defineDatabase({ tables: { pages, posts } });
  const service = defineService("content", { database });
  const comments = (count: number) =>
    defineResourcePlugin({
      name: "example/comments",
      setup({ routes }) {
        return {
          comments: {
            count: routes.action({
              name: "count",
              method: "GET",
              path: "/comments/count",
              output: t.Object({ count: t.Number() }),
              execute: () => ({ count }),
            }),
          },
        };
      },
    });
  service.resource({ name: "page", table: pages }).use(comments(3));
  service.resource({ name: "post", table: posts }).use(comments(7));
  const app = brick({ services: [service], requestLogging: false });
  for (const [resource, count] of [
    ["page", 3],
    ["post", 7],
  ] as const) {
    const response = await app.handle(
      new Request(`http://localhost/api/content/${resource}/comments/count`),
    );
    expect(await response.json()).toEqual({ count });
  }
  const generated = generateClientContract(app);
  const serialized = generated.match(
    /export const contract: AppContract = JSON.parse\((.+)\);/,
  )![1]!;
  const module = { contract: JSON.parse(JSON.parse(serialized)) };
  expect(module.contract.content.page.comments.count.config.path).toBe(
    "/api/content/page/comments/count",
  );
  expect(module.contract.content.post.comments.count.config.path).toBe(
    "/api/content/post/comments/count",
  );
  expect(module.contract.content.comments).toBeUndefined();
  expect(
    database.getDb().all("SELECT name FROM sqlite_master WHERE type = 'table'"),
  ).toEqual([]);
});

it("rejects raw plugin endpoint collisions during startup and later registration", () => {
  const service = defineService("discussion");
  service.use(
    defineServicePlugin({
      name: "example/endpoint",
      setup({ routes }) {
        routes.endpoint({
          name: "html",
          method: "GET",
          path: "/comments",
          handler: () => "plugin",
        });
        return {};
      },
    }),
  );
  expect(() =>
    brick({
      services: [service],
      endpoints: [
        {
          method: "GET",
          path: "/api/discussion/comments",
          handler: () => "ordinary",
        },
      ],
    }),
  ).toThrow("duplicate plugin route");
  const app = brick({ services: [service], requestLogging: false });
  expect(() =>
    app.endpoint({
      method: "GET",
      path: "/api/discussion/comments",
      handler: () => "ordinary",
    }),
  ).toThrow("duplicate plugin route");
});
