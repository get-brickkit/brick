import { beforeEach, expect, test } from "bun:test";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import {
  defineDatabase,
  defineService,
  generateOpenApiSpec,
  getGlobalRegistry,
  getPluginActionRoute,
  resetGlobalRegistry,
} from "@brickkit/core";
import { crud } from "../src";

beforeEach(resetGlobalRegistry);

const pages = sqliteTable("crud_public_pages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title"),
});

function setupPageResource() {
  const database = defineDatabase({ tables: { pages } });
  const service = defineService("pages", { database });
  const resource: any = service
    .resource({ name: "page", table: pages, id: pages.id })
    .use(
      crud({
        access: "public",
        fields: {
          id: { read: true },
          title: { read: true, create: true },
        },
      }),
    );
  return { service, resource };
}

test("crud actions export under public names (issue #27)", () => {
  const { service, resource } = setupPageResource();
  const names = service
    .listActions()
    .map((action) => action.name)
    .sort();
  expect(names).toEqual([
    "page.count",
    "page.create",
    "page.delete",
    "page.exists",
    "page.findOne",
    "page.get",
    "page.list",
    "page.update",
  ]);
  expect(names.some((n) => n.includes("@brickkit/crud"))).toBe(false);
  expect(resource.list.name).toBe("page.list");
  expect(getPluginActionRoute(resource.list)).toMatchObject({
    plugin: "@brickkit/crud",
    resource: "page",
  });

  const architecture = getGlobalRegistry().exportArchitecture();
  const exported = architecture.services
    .flatMap((s) => s.actions.map((a) => a.name))
    .sort();
  expect(exported).toEqual(names);
  expect(exported.some((n) => n.includes("@brickkit/crud"))).toBe(false);
  const listed = architecture.services
    .flatMap((s) => s.actions)
    .find((a) => a.name === "page.list");
  expect(listed?.plugin).toBe("@brickkit/crud");
  expect(listed?.resource).toBe("page");

  const route = getPluginActionRoute(resource.list);
  expect(route).toMatchObject({
    path: "/api/pages/page/query",
    clientPath: ["pages", "page", "list"],
    plugin: "@brickkit/crud",
    resource: "page",
  });

  const spec = generateOpenApiSpec({ services: [service], prefix: "/api" });
  const ops = Object.values(spec.paths).flatMap((p) =>
    Object.values(p as Record<string, unknown>),
  ) as any[];
  expect(ops.length).toBeGreaterThan(0);
  for (const op of ops) {
    expect(op.operationId).not.toContain("@brickkit/crud");
    expect(op.summary).not.toContain("@brickkit/crud");
  }
});
