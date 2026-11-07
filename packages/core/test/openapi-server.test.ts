import { describe, it, expect, beforeEach } from "bun:test";
import {
  defineService,
  defineAction,
  t,
  resetGlobalRegistry,
  brick,
} from "@brickkit/core";

describe("OpenAPI & documentation pages", () => {
  beforeEach(() => {
    resetGlobalRegistry();
  });

  it("should serve OpenAPI 3.1 JSON at /openapi.json and documentation at /docs & /swagger", async () => {
    const pagesService = defineService("pages", {});

    const createPage = defineAction({
      name: "createPage",
      description: "Create a page in workspace",
      input: t.Object({
        title: t.String(),
        slug: t.String(),
      }),
      output: t.Object({
        id: t.String(),
        title: t.String(),
      }),
      execute: async ({ input }) => ({
        id: "p_1",
        title: input.title,
      }),
    });

    pagesService.action(createPage);

    const app = brick({
      title: "Pages Platform API",
      version: "2.5.0",
      services: [pagesService],
    });

    const specResponse = await app.handle(
      new Request("http://localhost/openapi.json"),
    );
    expect(specResponse.status).toBe(200);
    const spec = await specResponse.json();

    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Pages Platform API");
    expect(spec.info.version).toBe("2.5.0");
    expect(spec.paths["/api/pages/create-page"]).toBeDefined();
    expect(spec.paths["/api/pages/create-page"].post).toBeDefined();
    expect(spec.paths["/api/pages/create-page"].post.summary).toBe(
      "pages.createPage",
    );
    expect(spec.paths["/api/pages/create-page"].post.requestBody).toBeDefined();

    const docsResponse = await app.handle(new Request("http://localhost/docs"));
    expect(docsResponse.status).toBe(200);
    expect(docsResponse.headers.get("content-type")).toContain("text/html");
    const docsHtml = await docsResponse.text();
    expect(docsHtml).toContain("@scalar/api-reference");
    expect(docsHtml).toContain('data-url="/openapi.json"');
    expect(docsHtml).toContain("Pages Platform API — API Reference");

    const swaggerResponse = await app.handle(
      new Request("http://localhost/swagger"),
    );
    expect(swaggerResponse.status).toBe(200);
    expect(swaggerResponse.headers.get("content-type")).toContain("text/html");
    const swaggerHtml = await swaggerResponse.text();
    expect(swaggerHtml).toContain("swagger-ui");
    expect(swaggerHtml).toContain('url: "/openapi.json"');
  });

  it("should allow disabling documentation via docs: false", async () => {
    const s = defineService("empty");
    const app = brick({
      docs: false,
      services: [s],
    });

    const specResponse = await app.handle(
      new Request("http://localhost/openapi.json"),
    );
    expect(specResponse.status).toBe(404);

    const docsResponse = await app.handle(new Request("http://localhost/docs"));
    expect(docsResponse.status).toBe(404);
  });

  it("lists the app's OpenAPI document, then the ones given to reference", async () => {
    const s = defineService("empty");
    const app = brick({
      services: [s],
      title: "Orders API",
      reference: {
        documents: [
          { title: "Auth", document: { openapi: "3.1.0", paths: {} } },
          {
            title: "Billing",
            document: async () => ({ openapi: "3.1.0", paths: { "/pay": {} } }),
          },
        ],
      },
    });

    const documents = await app.referenceDocuments();
    expect(documents.map((item) => item.title)).toEqual([
      "Orders API",
      "Auth",
      "Billing",
    ]);
    expect(documents[0]!.document).toMatchObject({
      openapi: "3.1.0",
      info: { title: "Orders API" },
    });
    expect(documents[2]!.document.paths).toEqual({ "/pay": {} });
    // Documents for the dashboard are not served as pages.
    expect(
      (await app.handle(new Request("http://localhost/reference"))).status,
    ).toBe(404);
  });

  it("leaves out the app's own document when docs is false, and skips ones that fail", async () => {
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    try {
      const app = brick({
        services: [defineService("empty")],
        docs: false,
        reference: {
          documents: [
            { title: "Auth", document: { openapi: "3.1.0" } },
            {
              title: "Broken",
              document: () => {
                throw new Error("no schema");
              },
            },
          ],
        },
      });
      expect(
        (await app.referenceDocuments()).map((item) => item.title),
      ).toEqual(["Auth"]);
      expect(warnings.join("\n")).toContain(
        'Skipping the "Broken" API document: no schema',
      );
      expect(
        await brick({
          services: [defineService("empty")],
          docs: false,
        }).referenceDocuments(),
      ).toEqual([]);
    } finally {
      console.warn = warn;
    }
  });

  it("records where the developer documentation is on the app definition", () => {
    const services = [defineService("empty")];
    expect(brick({ services }).definition.documentation).toBeUndefined();
    expect(
      brick({ services, documentation: "./docs" }).definition.documentation,
    ).toEqual({ dir: "./docs" });
    expect(
      brick({
        services,
        documentation: { dir: "./guide", components: "./guide/parts.tsx" },
      }).definition.documentation,
    ).toEqual({ dir: "./guide", components: "./guide/parts.tsx" });
    // It is a plain setting, so it never changes what the app serves.
    expect(
      Object.isFrozen(
        brick({ services, documentation: "./docs" }).definition.documentation,
      ),
    ).toBe(true);
    expect(() => brick({ services, documentation: "" })).toThrow(
      "documentation needs a folder",
    );
    expect(() => brick({ services, documentation: { dir: "" } })).toThrow(
      "documentation needs a folder",
    );
  });
});
