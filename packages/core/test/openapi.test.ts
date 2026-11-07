import { describe, it, expect, beforeEach } from "bun:test";
import {
  brick,
  defineService,
  defineDatabase,
  defineAction,
  t,
  Type,
  resetGlobalRegistry,
  generateOpenApiSpec,
} from "../src";
import { postJson } from "./helpers";

describe("OpenAPI 3.1 Specification Generator", () => {
  beforeEach(() => {
    resetGlobalRegistry();
  });

  it("should generate a complete OpenAPI 3.1.0 specification from service registry", () => {
    const pagesService = defineService("pages", { database: defineDatabase() });

    const createPage = defineAction({
      name: "createPage",
      description: "Create a new page",
      tags: ["content", "pages"],
      input: t.Object({
        title: t.String({ description: "Page title" }),
        slug: t.String({ pattern: "^[a-z0-9-]+$" }),
        isPublic: t.Optional(t.Boolean()),
      }),
      output: t.Object({
        id: t.String(),
        title: t.String(),
        slug: t.String(),
      }),
      errors: {
        SLUG_EXISTS: {
          status: 409,
          message: "Slug is already taken",
        },
      },
      authorize: () => true,
      execute: async ({ input }) => ({
        id: "p_1",
        title: input.title,
        slug: input.slug,
      }),
    });

    const getPage = defineAction({
      name: "getPage",
      method: "GET",
      description: "Get page by id",
      input: t.Object({
        id: t.String({ description: "Target page ID" }),
      }),
      output: t.Object({
        id: t.String(),
        title: t.String(),
      }),
      execute: async ({ input }) => ({
        id: input.id,
        title: "Test",
      }),
    });

    pagesService.action(createPage).action(getPage);

    const spec = generateOpenApiSpec({
      title: "Pages Publishing Mesh",
      version: "1.2.0",
      description: "Production API specification",
    });

    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Pages Publishing Mesh");
    expect(spec.info.version).toBe("1.2.0");
    expect(spec.info.description).toBe("Production API specification");

    expect(spec.tags).toBeDefined();
    expect(spec.tags.some((t: any) => t.name === "pages")).toBe(true);

    const createPath = spec.paths["/api/pages/create-page"];
    expect(createPath).toBeDefined();
    expect(createPath.post).toBeDefined();
    expect(createPath.post.operationId).toBe("pages_createPage_post");
    expect(createPath.post.tags).toEqual(["pages", "content"]);
    expect(createPath.post.summary).toBe("pages.createPage");
    expect(createPath.post.description).toBe("Create a new page");

    expect(createPath.post.requestBody.required).toBe(true);
    expect(
      createPath.post.requestBody.content["application/json"].schema.properties
        .title,
    ).toBeDefined();
    expect(
      createPath.post.requestBody.content["application/json"].schema.properties
        .slug,
    ).toBeDefined();

    expect(
      createPath.post.responses["200"].content["application/json"].schema
        .properties.id,
    ).toBeDefined();
    expect(createPath.post.responses["400"]).toBeDefined();
    expect(createPath.post.responses["403"]).toBeDefined();
    expect(createPath.post.responses["409"]).toBeDefined();
    expect(createPath.post.responses["409"].description).toBe(
      "Slug is already taken",
    );
    expect(createPath.post.responses["500"]).toBeDefined();

    expect(createPath.post.security).toEqual([{ bearerAuth: [] }]);
    expect(spec.components.securitySchemes.bearerAuth).toBeDefined();
    expect(spec.components.securitySchemes.bearerAuth.type).toBe("http");
    expect(spec.components.securitySchemes.bearerAuth.scheme).toBe("bearer");

    const getPath = spec.paths["/api/pages/get-page"];
    expect(getPath).toBeDefined();
    expect(getPath.post).toBeUndefined();
    expect(getPath.get).toBeDefined();
    expect(getPath.get.operationId).toBe("pages_getPage_get");
    expect(getPath.get.parameters).toBeDefined();
    expect(getPath.get.parameters[0].name).toBe("id");
    expect(getPath.get.parameters[0].in).toBe("query");
    expect(getPath.get.parameters[0].required).toBe(true);
  });

  it("should handle actions without inputs, outputs, or authorization cleanly", () => {
    const healthService = defineService("system");
    const ping = defineAction({
      name: "ping",
      execute: async () => ({ status: "ok" }),
    });

    healthService.action(ping);

    const spec = generateOpenApiSpec({ services: [healthService] });

    expect(spec.openapi).toBe("3.1.0");
    const path = spec.paths["/api/system/ping"];
    expect(path.post).toBeDefined();
    expect(path.post.requestBody).toBeUndefined();
    expect(path.post.security).toBeUndefined();
    expect(path.post.responses["200"]).toBeDefined();
    expect(spec.components.schemas.ErrorEnvelope).toBeDefined();
    expect(spec.components.securitySchemes).toBeUndefined();
  });
});

it("deduplicates declared and framework errors with the same code and status", () => {
  const service = defineService("overrides").action(
    defineAction({
      name: "fail",
      input: t.Object({ value: t.String() }),
      output: t.String(),
      authorize: () => false,
      errors: {
        INTERNAL_SERVER_ERROR: { status: 500, message: "Declared failure" },
        VALIDATION_FAILED: { status: 400, message: "Invalid value" },
        UNAUTHORIZED: { status: 401, message: "Sign in" },
        FORBIDDEN: { status: 403, message: "No permission" },
        OTHER: { status: 500, message: "Other failure" },
      },
      execute: () => "ok",
    }),
  );
  const responses = generateOpenApiSpec({ services: [service] }).paths[
    "/api/overrides/fail"
  ].post.responses;
  for (const [status, code] of [
    [400, "VALIDATION_FAILED"],
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [500, "INTERNAL_SERVER_ERROR"],
  ] as const) {
    const alternatives =
      responses[status].content["application/json"].schema.oneOf;
    expect(
      alternatives.filter(
        (schema: {
          allOf: [
            { $ref: string },
            {
              properties: {
                code: { const: string };
                status: { const: number };
              };
            },
          ];
        }) =>
          schema.allOf[1].properties.code.const === code &&
          schema.allOf[1].properties.status.const === status,
      ),
    ).toHaveLength(1);
  }
  expect(responses[500].content["application/json"].schema.oneOf).toHaveLength(
    3,
  );
});

it("hoists TypeBox $id/$ref anchors into components.schemas", () => {
  // TypeBox expresses recursion with bare anchors (`$id: "T0"` plus
  // `$ref: "T0"`). OpenAPI reads a bare `$ref` as an external file, so
  // the raw anchors must never reach the emitted spec.
  const JsonValue = Type.Recursive(
    (This: any) => Type.Union([Type.Null(), Type.String(), Type.Array(This)]),
    { $id: "T0" },
  );
  const LeadWhere = Type.Recursive(
    (This: any) => Type.Object({ and: Type.Optional(Type.Array(This)) }),
    { $id: "CrudWhere:lead" },
  );

  const anchoredService = defineService("anchored", {
    database: defineDatabase(),
  });
  anchoredService.action(
    defineAction({
      name: "echoJson",
      input: t.Object({ filter: LeadWhere }),
      output: t.Object({ value: JsonValue }),
      execute: async ({ input }: any) => ({ value: input.filter }),
    }),
  );

  const spec = generateOpenApiSpec();
  const raw = JSON.stringify(spec);
  expect(raw).not.toContain('"$ref":"T0"');
  expect(raw).not.toContain('"$ref":"CrudWhere:lead"');
  expect(raw).not.toContain('"$id"');

  // Anchors land in components under sanitized keys (`:` is not a
  // valid OpenAPI component key character).
  expect(spec.components.schemas.T0).toBeDefined();
  expect(spec.components.schemas.CrudWhere_lead).toBeDefined();

  // Self-recursion resolves locally (compared through JSON so TypeBox
  // symbol keys don't affect the assertion).
  expect(
    JSON.parse(JSON.stringify(spec.components.schemas.T0)).anyOf[2],
  ).toEqual({
    type: "array",
    items: { $ref: "#/components/schemas/T0" },
  });
  expect(
    spec.paths["/api/anchored/echo-json"].post.requestBody.content[
      "application/json"
    ].schema.properties.filter,
  ).toEqual({ $ref: "#/components/schemas/CrudWhere_lead" });
});

it("keeps runtime schemas intact when hoisting OpenAPI anchors", async () => {
  const tree = t.Recursive(
    (self) => t.Object({ label: t.String(), children: t.Array(self) }),
    { $id: "RuntimeTree" },
  );
  const schema = t.Object({ tree });
  const original = JSON.stringify(schema);
  const service = defineService("schemaIsolation");
  service.action({
    name: "echo",
    input: schema,
    output: schema,
    execute: ({ input }) => input,
  });
  const first = generateOpenApiSpec({ services: [service] });
  expect(JSON.stringify(schema)).toBe(original);
  expect(generateOpenApiSpec({ services: [service] })).toEqual(first);
  const app = brick({ services: [service], requestLogging: false });
  const body = {
    tree: { label: "root", children: [{ label: "leaf", children: [] }] },
  };
  const response = await postJson(app, "/api/schema-isolation/echo", body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(body);
  const invalid = await postJson(app, "/api/schema-isolation/echo", {
    tree: { label: 123, children: [] },
  });
  expect(invalid.status).toBe(400);
});
