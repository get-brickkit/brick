import { Elysia, type Context } from "elysia";
import { OPENAPI_DEFAULTS } from "./openapi";

/** An OpenAPI document as plain JSON. */
export type OpenApiDocument = Record<string, unknown>;

/** An extra OpenAPI document for the API reference, such as Better Auth's. */
export interface ReferenceDocument {
  /** Name in the reference's list of documents. */
  title: string;
  /** The document, or a function returning it; called each time the app starts. */
  document:
    | OpenApiDocument
    | (() => OpenApiDocument | Promise<OpenApiDocument>);
}

/** A named OpenAPI document ready to render. */
export interface ApiDocument {
  title: string;
  document: OpenApiDocument;
}

/** Developer documentation for the `brick dev` dashboard. */
export interface DocumentationOptions {
  /**
   * Folder of `.md`/`.mdx` pages. A relative path starts at the folder of the
   * app entry, as it reads in the file that sets it.
   */
  dir: string;
  /**
   * Module whose exports are React components for MDX, added to the built-in
   * ones; a relative path starts where `dir` does. A default export or a
   * `components` export holds the name-to-component map. The dashboard bundles
   * it, so it may import anything the project has.
   */
  components?: string;
}

export interface ReferenceOptions {
  /** Also serve a standalone Scalar page here. Without a path, no page is served. */
  path?: string;
  title?: string;
  specUrl?: string;
  /** More OpenAPI documents for the `brick dev` dashboard's APIs view. */
  documents?: ReferenceDocument[];
}

/** Renders the Scalar API reference page for the given OpenAPI URL. */
export function scalarDocsHTML(specUrl: string, title: string): string {
  return `<!doctype html>
<html>
  <head>
    <title>${title} — API Reference</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href="https://scalar.com/favicon.svg" />
    <style>
      body { margin: 0; padding: 0; height: 100vh; }
    </style>
  </head>
  <body>
    <script
      id="api-reference"
      data-url="${specUrl}"
      data-configuration='{"theme": "purple", "layout": "modern"}'
      src="https://cdn.jsdelivr.net/npm/@scalar/api-reference">
    </script>
  </body>
</html>`;
}

/**
 * Standalone Elysia plugin serving GET <path> with the Scalar HTML page.
 *
 * @deprecated Use `brick({ reference: true })` or `reference: { path }`.
 */
export function referencePlugin(opts: ReferenceOptions = {}): Elysia {
  const path = opts.path ?? "/reference";
  const title = opts.title ?? OPENAPI_DEFAULTS.title;
  const specUrl = opts.specUrl ?? OPENAPI_DEFAULTS.path;
  const plugin = new Elysia();
  plugin.get(path, ({ set }: Context) => {
    set.headers["content-type"] = "text/html; charset=utf-8";
    return scalarDocsHTML(specUrl, title);
  });
  return plugin;
}

/**
 * Mounts the Scalar reference route onto an existing app.
 *
 * @deprecated Use `brick({ reference: true })` or `reference: { path }`.
 */
export function registerReferenceRoute(
  app: Elysia,
  opts: ReferenceOptions = {},
): Elysia {
  return app.use(referencePlugin(opts)) as Elysia;
}

/** Renders the Swagger UI page. */
export function swaggerDocsHTML(specUrl: string, title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <title>${title} — Swagger UI</title>
    <link rel="stylesheet" type="text/css" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      html { box-sizing: border-box; overflow: -moz-scrollbars-vertical; overflow-y: scroll; }
      *, *:before, *:after { box-sizing: inherit; }
      body { margin:0; background: #fafafa; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" charset="UTF-8"></script>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-standalone-preset.js" charset="UTF-8"></script>
    <script>
    window.onload = function() {
      SwaggerUIBundle({
        url: "${specUrl}",
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [
          SwaggerUIBundle.presets.apis,
          SwaggerUIStandalonePreset
        ],
        plugins: [
          SwaggerUIBundle.plugins.DownloadUrl
        ],
        layout: "StandaloneLayout"
      });
    };
    </script>
  </body>
</html>`;
}
