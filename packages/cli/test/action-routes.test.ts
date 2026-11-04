import { beforeEach, expect, it } from "bun:test";
import {
  defineService,
  resetGlobalRegistry,
  t,
  compileBrickApplication,
  brick,
} from "@brickkit/core";

beforeEach(resetGlobalRegistry);

it("exposes only the effective action path and method in both server modes and OpenAPI", async () => {
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
  for (const compiler of [true, false]) {
    for (const customPath of [false, true]) {
      for (const method of [...methods, undefined]) {
        const service = defineService("records");
        service.action({
          name: "get_document",
          method,
          ...(customPath ? { path: "/documents/:name" } : {}),
          input: t.Object({ name: t.String(), field: t.String() }),
          output: t.String(),
          execute: ({ input }) => `${input.name}:${input.field}`,
        });
        const effectiveMethod = method ?? "POST";
        const path = customPath
          ? "/v2/records/documents/CRMDeal"
          : "/v2/records/get_document";
        const compilation = compileBrickApplication({
          services: [service],
          prefix: "/v2",
        });
        expect(compilation.ir.routes).toHaveLength(1);
        expect(compilation.ir.routes[0]!.method).toBe(effectiveMethod);
        expect(compilation.ir.routes[0]!.path).toBe(
          customPath ? "/v2/records/documents/:name" : path,
        );
        const app = brick({
          services: [service],
          prefix: "/v2",
          compiler,
          requestLogging: false,
        });
        for (const requestMethod of methods) {
          const queryOnly =
            requestMethod === "GET" || requestMethod === "DELETE";
          const input = customPath
            ? { field: "title" }
            : { name: "CRMDeal", field: "title" };
          const response = await app.handle(
            new Request(
              `http://localhost${path}${queryOnly ? `?${new URLSearchParams(input)}` : ""}`,
              {
                method: requestMethod,
                ...(queryOnly
                  ? {}
                  : {
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(input),
                    }),
              },
            ),
          );
          expect(response.status).toBe(
            requestMethod === effectiveMethod ? 200 : 404,
          );
          if (response.status === 200)
            expect(await response.text()).toBe("CRMDeal:title");
        }
        if (customPath) {
          for (const requestMethod of methods) {
            expect(
              (
                await app.handle(
                  new Request("http://localhost/v2/records/get_document", {
                    method: requestMethod,
                  }),
                )
              ).status,
            ).toBe(404);
          }
        }
        const spec = await (
          await app.handle(new Request("http://localhost/openapi.json"))
        ).json();
        const specPath = customPath ? "/v2/records/documents/{name}" : path;
        expect(Object.keys(spec.paths)).toEqual([specPath]);
        expect(Object.keys(spec.paths[specPath])).toEqual([
          effectiveMethod.toLowerCase(),
        ]);
        const operation = spec.paths[specPath][effectiveMethod.toLowerCase()];
        if (customPath) {
          expect(operation.parameters).toContainEqual({
            name: "name",
            in: "path",
            required: true,
            schema: { type: "string" },
          });
          expect(
            operation.requestBody?.content["application/json"].schema.properties
              .name,
          ).toBeUndefined();
        }
        if (effectiveMethod === "GET" || effectiveMethod === "DELETE") {
          expect(operation.requestBody).toBeUndefined();
          expect(operation.parameters).toContainEqual({
            name: "field",
            in: "query",
            required: true,
            schema: { type: "string" },
          });
        } else {
          expect(
            operation.requestBody.content["application/json"].schema.properties
              .field,
          ).toEqual({ type: "string" });
        }
      }
    }
  }
});

it("defaults read-like names to POST without inferring additional methods", () => {
  const service = defineService("defaults");
  for (const name of [
    "get_document",
    "list_documents",
    "find_document",
    "read_document",
    "search_link",
  ]) {
    service.action({ name, execute: () => "ok" });
  }
  const { ir } = compileBrickApplication({ services: [service] });
  expect(ir.routes).toHaveLength(5);
  expect(ir.routes.every((route) => route.method === "POST")).toBe(true);
});
