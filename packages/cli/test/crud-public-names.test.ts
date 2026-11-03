import { beforeEach, expect, it } from "bun:test";
import {
  defineDatabase,
  defineResourcePlugin,
  defineService,
  generateOpenApiSpec,
  getGlobalRegistry,
  resetGlobalRegistry,
  sqliteTable,
  text,
  t,
  compileBrickApplication,
} from "@brickkit/core";
import { generateClientContract } from "../src/client-contract";

beforeEach(resetGlobalRegistry);

it("plugin client contract, OpenAPI and IR use public names (issue #27)", () => {
  const pages = sqliteTable("contract_public_pages", {
    id: text("id").primaryKey(),
  });
  const service = defineService("pages", {
    database: defineDatabase({ tables: { pages } }),
  });
  const resource: any = service.resource({ name: "page", table: pages }).use(
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
        return { list };
      },
    }),
  );
  expect(resource.list.name).toBe("page.list");

  const fakeApp: any = {
    definition: { services: [service], prefix: "/api", sockets: [] },
  };
  const source = generateClientContract(fakeApp);
  const serialized = source.match(
    /export const contract: AppContract = JSON.parse\((.+)\);/,
  )![1]!;
  const contract = JSON.parse(JSON.parse(serialized));
  // Typed client calls api.pages.page.list (public namespace).
  expect(Object.keys(contract.pages.page)).toEqual(["list"]);
  expect(contract.pages.page.list.name).toBe("page.list");
  expect(contract.pages.page.list.plugin).toBe("@brickkit/crud");
  expect(contract.pages.page.list.resource).toBe("page");
  const namesInContract = JSON.stringify(
    Object.values(contract.pages.page as Record<string, any>).map(
      (m: any) => m.name,
    ),
  );
  expect(namesInContract).not.toContain("@brickkit/crud");

  const spec = generateOpenApiSpec({ services: [service], prefix: "/api" });
  const ops = Object.values(spec.paths).flatMap((p) =>
    Object.values(p as Record<string, unknown>),
  ) as any[];
  expect(ops).toHaveLength(1);
  expect(ops[0].operationId).not.toContain("@brickkit/crud");
  expect(ops[0].summary).toBe("pages.page.list");

  const compilation = compileBrickApplication({
    services: [service],
    prefix: "/api",
  });
  expect(compilation.ir.routes.map((r) => r.action)).toEqual(["page.list"]);

  const architecture = getGlobalRegistry().exportArchitecture();
  const exported = architecture.services.flatMap((s) =>
    s.actions.map((a) => a.name),
  );
  expect(exported).toEqual(["page.list"]);
});
