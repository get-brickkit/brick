import type { EventRef } from "./events/catalog";
import {
  DEFAULT_PREFIX,
  actionOwners,
  pathParamNames,
  toOpenApiPath,
} from "./routes";
import { analyzeDeclaredApplication } from "./compiler/ir";
import { getActionAccess } from "./access";
import { fileFields } from "./typebox";
import { getGlobalRegistry } from "./registry";
import type { Service, ActionErrorDefinition } from "./types";

/** The OpenAPI document's defaults, shared by `brick()` and `generateOpenApiSpec`. */
export const OPENAPI_DEFAULTS = Object.freeze({
  title: "Brick-TS API Mesh",
  version: "1.0.0",
  path: "/openapi.json",
});

export interface OpenApiGeneratorOptions {
  title?: string;
  version?: string;
  description?: string;
  prefix?: string;
  services?: Service<any, any>[];
}

function isAnchor(
  node: unknown,
): node is { $id: string } & Record<string, any> {
  return (
    typeof node === "object" &&
    node !== null &&
    typeof (node as Record<string, any>).$id === "string"
  );
}

function isBareRef(node: unknown): node is { $ref: string } {
  return (
    typeof node === "object" &&
    node !== null &&
    typeof (node as Record<string, any>).$ref === "string" &&
    !(node as { $ref: string }).$ref.startsWith("#")
  );
}

function toComponentKey(id: string): string {
  return id.replace(/[^A-Za-z0-9.\-_]+/g, "_");
}

/**
 * TypeBox expresses recursive schemas with bare `$id`/`$ref` anchors
 * (`{ $id: "T0", ..., { $ref: "T0" } }`). OpenAPI interprets a bare `$ref`
 * as an external file reference, so downstream tooling tries to load a
 * file named `T0` and fails. Hoist every anchored subschema into
 * `#/components/schemas/` and rewrite the refs to local pointers.
 * First definition wins when one `$id` is declared twice.
 */
function hoistAnchoredSchemas(spec: Record<string, any>): void {
  const anchored = new Map<string, any>();

  const collect = (node: any): any => {
    if (Array.isArray(node)) return node.map(collect);
    if (typeof node !== "object" || node === null) return node;
    if (isAnchor(node)) {
      const id = node.$id;
      const { $id: _dropped, ...rest } = node;
      const collected = collect(rest);
      if (!anchored.has(id)) anchored.set(id, collected);
      return { $ref: `#/components/schemas/${toComponentKey(id)}` };
    }
    for (const key of Object.keys(node)) {
      node[key] = collect(node[key]);
    }
    return node;
  };

  const rewrite = (node: any): void => {
    if (Array.isArray(node)) {
      for (const child of node) rewrite(child);
      return;
    }
    if (typeof node !== "object" || node === null) return;
    if (isBareRef(node)) {
      node.$ref = `#/components/schemas/${toComponentKey(node.$ref)}`;
    }
    for (const key of Object.keys(node)) rewrite(node[key]);
  };

  collect(spec);

  const components = (spec.components ??= {}) as Record<string, any>;
  const schemas = (components.schemas ??= {}) as Record<string, any>;
  for (const [id, schema] of anchored) {
    schemas[toComponentKey(id)] = schema;
  }

  // Second pass covers refs inside the hoisted copies themselves
  // (e.g. the self-recursive JSON-value schema).
  rewrite(spec);
}

/**
 * Build the OpenAPI 3.1 document for the services: one path per action route,
 * with request and response schemas from the actions' TypeBox schemas, their
 * declared errors, tags by service, and a bearer security scheme where any
 * action needs authorization. Declared events are listed under `x-brick-events`,
 * by wire name, with their service and payload schema.
 *
 * `brick()` calls this for `/openapi.json`; call it yourself to write the
 * document to a file or feed another tool.
 *
 * @param options - `title`, `version`, and `description` for the `info` block,
 * `prefix` (default `/api`), and the `services` to describe (the global
 * registry's by default).
 * @returns The document as a plain object.
 */
export function generateOpenApiSpec(
  options: OpenApiGeneratorOptions = {},
): Record<string, any> {
  const title = options.title ?? OPENAPI_DEFAULTS.title;
  const version = options.version ?? OPENAPI_DEFAULTS.version;
  const description =
    options.description ??
    "Automated OpenAPI 3.1.0 specification for Brick-TS modular service mesh.";
  const prefix = options.prefix ?? DEFAULT_PREFIX;

  const services = options.services ?? getGlobalRegistry().list();

  const paths: Record<string, any> = {};
  const tags = new Map<string, string>();
  let hasAnyAuthorizedAction = false;

  // The routes the server mounts: shadowed ones are left out, as the router leaves them out.
  const { ir, bindings } = analyzeDeclaredApplication([...services], prefix);
  for (const service of services) {
    tags.set(service.name, `Actions exposed by '${service.name}' service`);

    for (const [index, route] of ir.routes.entries()) {
      if (route.service !== service.name) continue;
      const { action } = bindings[index]!;
      const routePath = route.path;
      const method = route.method.toLowerCase();
      const pathParams = pathParamNames(routePath);
      const actionPath = toOpenApiPath(routePath);
      if (!paths[actionPath]) paths[actionPath] = {};

      const { plugin, resource } = actionOwners(action);
      // Resource routes group under `service · resource`.
      const group = resource ? `${service.name} · ${resource}` : service.name;
      if (resource)
        tags.set(
          group,
          `Routes of resource '${resource}' in service '${service.name}'`,
        );

      const hasAuth = getActionAccess(action).hasAuthorize;
      if (hasAuth) {
        hasAnyAuthorizedAction = true;
      }

      const responses: Record<string, any> = {};

      if (action.config.output) {
        responses["200"] = {
          description: "Successful response",
          content: {
            "application/json": {
              schema: action.config.output,
            },
          },
        };
      } else {
        responses["200"] = {
          description: "Successful response",
        };
      }

      const errorAlternatives = new Set<string>();
      const addError = (
        code: string,
        status: number,
        message: string,
        details?: unknown,
      ) => {
        const key = `${status}:${code}`;
        if (errorAlternatives.has(key)) return;
        errorAlternatives.add(key);
        const schema = {
          allOf: [
            { $ref: "#/components/schemas/ErrorEnvelope" },
            {
              type: "object",
              properties: {
                code: { const: code },
                status: { const: status },
                ...(details ? { details } : {}),
              },
            },
          ],
        };
        const existing = responses[String(status)];
        if (existing) {
          existing.description += "; " + message;
          existing.content["application/json"].schema.oneOf.push(schema);
        } else {
          responses[String(status)] = {
            description: message,
            content: { "application/json": { schema: { oneOf: [schema] } } },
          };
        }
      };
      if (action.config.input)
        addError("VALIDATION_FAILED", 400, "Validation error");
      if (hasAuth) {
        addError("UNAUTHORIZED", 401, "Authentication required");
        addError("FORBIDDEN", 403, "Access denied");
      }
      if (action.config.errors) {
        for (const [code, errorDef] of Object.entries(action.config.errors)) {
          const def = errorDef as ActionErrorDefinition;
          addError(code, def.status || 400, def.message || code, def.details);
        }
      }
      addError("INTERNAL_SERVER_ERROR", 500, "Internal server error");
      if (action.config.output)
        addError("VALIDATION_FAILED", 500, "Output validation error");

      const operation: Record<string, any> = {
        operationId: `${service.name}_${action.name}_${method}`,
        summary: `${service.name}.${action.name}`,
        description:
          action.config.description ??
          `Execute action '${action.name}' on service '${service.name}'`,
        tags: [...new Set([group, ...(action.config.tags ?? [])])],
        ...(plugin ? { "x-brick-plugin": plugin } : {}),
        ...(resource ? { "x-brick-resource": resource } : {}),
        responses,
      };

      const inputSchema = action.config.input;
      const properties = inputSchema?.properties ?? {};
      const parameters: any[] = [...new Set(pathParams)].map((key) => ({
        name: key,
        in: "path",
        required: true,
        schema: properties[key] ?? { type: "string" },
      }));
      if (route.inputSource === "query") {
        for (const [key, schema] of Object.entries(properties)) {
          if (pathParams.includes(key)) continue;
          parameters.push({
            name: key,
            in: "query",
            required: inputSchema?.required?.includes(key) ?? false,
            schema,
          });
        }
      } else if (inputSchema) {
        const bodySchema =
          pathParams.length && inputSchema.properties
            ? {
                ...inputSchema,
                properties: Object.fromEntries(
                  Object.entries(properties).filter(
                    ([key]) => !pathParams.includes(key),
                  ),
                ),
                required: (inputSchema.required ?? []).filter(
                  (key: string) => !pathParams.includes(key),
                ),
              }
            : inputSchema;
        operation.requestBody = {
          required: true,
          content: {
            [fileFields(inputSchema).length
              ? "multipart/form-data"
              : "application/json"]: { schema: bodySchema },
          },
        };
      }
      if (parameters.length) operation.parameters = parameters;
      if (hasAuth) operation.security = [{ bearerAuth: [] }];
      paths[actionPath][method] = operation;
    }
  }

  const spec: Record<string, any> = {
    openapi: "3.1.0",
    info: {
      title,
      version,
      description,
    },
    paths,
    tags: Array.from(tags, ([name, description]) => ({ name, description })),
  };

  spec.components = {
    schemas: {
      ErrorEnvelope: {
        type: "object",
        required: ["name", "code", "message", "status", "requestId"],
        properties: {
          name: { type: "string" },
          code: { type: "string" },
          message: { type: "string" },
          status: { type: "integer" },
          requestId: { type: "string" },
          details: {},
          errors: {
            type: "array",
            items: {
              type: "object",
              required: ["path", "message"],
              properties: {
                path: { type: "string" },
                message: { type: "string" },
                value: {},
              },
            },
          },
        },
      },
    },
  };
  if (hasAnyAuthorizedAction) {
    Object.assign(spec.components, {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "Enter your Bearer authentication token",
        },
      },
    });
  }

  const events = Object.fromEntries(
    services.flatMap((service) =>
      Object.values(
        (service as { events?: Record<string, EventRef> }).events ?? {},
      ).map((ref) => [
        ref.name,
        {
          service: service.name,
          payload: ref.schema,
          ...(ref.plugin ? { "x-brick-plugin": ref.plugin } : {}),
        },
      ]),
    ),
  );
  if (Object.keys(events).length) spec["x-brick-events"] = events;

  // Operations reference live TypeBox schemas. Rewrite only the serialized
  // document so OpenAPI pointers cannot corrupt runtime validation schemas.
  const document: Record<string, any> = JSON.parse(JSON.stringify(spec));
  hoistAnchoredSchemas(document);

  return document;
}
