import { expect, test, spyOn } from "bun:test";
import {
  defineAction,
  defineError,
  defineService,
  t,
  brick,
  generateOpenApiSpec,
  ActionExecutionError,
  ValidationError,
} from "../src";
import { createTestApp } from "../src/testing";
import { postJson } from "./helpers";

for (const scenario of [
  "declared",
  "validation",
  "anonymous",
  "signed-in",
  "unexpected",
] as const) {
  test(`error parity: ${scenario}`, async () => {
    const action = defineAction({
      name: "fail",
      input: t.Object({ value: t.String() }),
      errors: { TAKEN: { message: "Taken", status: 409 } },
      authorize: () => scenario !== "anonymous" && scenario !== "signed-in",
      execute: ({ error }) => {
        if (scenario === "declared") error.TAKEN();
        throw new Error("private database password", {
          cause: new Error("root cause"),
        });
      },
    });
    const service = defineService(`errors_${scenario}`, {
      context: () => ({
        user: scenario === "signed-in" ? { id: "u" } : undefined,
      }),
    }).action(action);
    const { app, client } = createTestApp({
      services: [service],
      contract: { errors: { fail: action } },
    });
    const input = { value: scenario === "validation" ? 1 : "ok" };
    const expected =
      scenario === "declared"
        ? { code: "TAKEN", status: 409 }
        : scenario === "validation"
          ? { code: "VALIDATION_FAILED", status: 400 }
          : scenario === "anonymous"
            ? { code: "UNAUTHORIZED", status: 401 }
            : scenario === "signed-in"
              ? { code: "FORBIDDEN", status: 403 }
              : { code: "INTERNAL_SERVER_ERROR", status: 500 };
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const local = await action
        .execute({ input: input as never })
        .catch((error) => error);
      expect(local).toMatchObject(expected);
      const response = await postJson(app, `/api/${service.name}/fail`, input, {
        "x-request-id": "test-request",
      });
      const envelope = await response.json();
      expect(response.status).toBe(expected.status);
      expect(envelope).toMatchObject({
        ...expected,
        requestId: "test-request",
      });
      const remote = await client.errors
        .fail(input as never)
        .catch((error) => error);
      expect(remote).toMatchObject(expected);
      if (scenario === "validation")
        expect(remote).toBeInstanceOf(ValidationError);
      if (scenario === "unexpected") {
        expect(JSON.stringify(envelope)).not.toContain(
          "private database password",
        );
        expect(log).toHaveBeenCalled();
      }
    } finally {
      log.mockRestore();
    }
  });
}
test("endpoint errors redact internals and include request id", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const cause = new Error("private failure");
  try {
    const app = brick({
      services: [],
      requestLogging: false,
      endpoints: [
        {
          method: "GET",
          path: "/fail",
          handler: () => {
            throw cause;
          },
        },
      ],
    });
    const result = await (
      await app.handle(
        new Request("http://localhost/fail", {
          headers: { "x-request-id": "endpoint-id" },
        }),
      )
    ).json();
    expect(result).toMatchObject({
      name: "InternalServerError",
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal Server Error",
      status: 500,
      requestId: "endpoint-id",
    });
    expect(log.mock.calls.flat()).toContain(cause);
  } finally {
    log.mockRestore();
  }
});
test("declared errors retain causes without serializing them", async () => {
  const cause = new Error("secret");
  const action = defineAction({
    name: "cause",
    execute: ({ error }) => error.CONFLICT("taken", { id: 1 }, { cause }),
  });
  defineService("cause_errors").action(action);
  const failure = await action.execute({}).catch((error) => error);
  expect(failure).toBeInstanceOf(ActionExecutionError);
  expect(failure.cause).toBe(cause);
  expect(JSON.stringify(failure)).not.toContain("secret");
});
test("OpenAPI groups declared errors and uses shared envelopes", () => {
  const service = defineService("spec_errors").action(
    defineAction({
      name: "fail",
      authorize: () => false,
      errors: {
        FIRST: { status: 409, message: "First" },
        SECOND: { status: 409, message: "Second" },
      },
      execute: () => "ok",
    }),
  );
  const spec = generateOpenApiSpec({ services: [service] });
  expect(spec.components.schemas.ErrorEnvelope).toBeDefined();
  const responses = spec.paths["/api/spec_errors/fail"].post.responses;
  expect(responses[401]).toBeDefined();
  expect(responses[409].content["application/json"].schema.oneOf).toHaveLength(
    2,
  );
});

test("actions redact synchronous and asynchronous failures and log causes", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const cause = new Error("private root cause");
  try {
    for (const asynchronous of [false, true]) {
      const failure = new Error("private database password", { cause });
      const action = defineAction({
        name: "failure",
        execute: () => {
          if (asynchronous) return Promise.reject(failure);
          throw failure;
        },
      });
      const service = defineService("route_failure").action(action);
      const response = await postJson(
        brick({ services: [service], requestLogging: false }),
        "/api/route_failure/failure",
        {},
        { "x-request-id": "route-failure-id" },
      );
      expect(response.status).toBe(500);
      const result = await response.json();
      expect(result).toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        status: 500,
        message: "Internal Server Error",
        requestId: "route-failure-id",
      });
      expect(JSON.stringify(result)).not.toContain("private");
      expect(log.mock.calls.flat()).toContain(failure);
      expect(failure.cause).toBe(cause);
    }
  } finally {
    log.mockRestore();
  }
});

for (const status of [400, 404, 422, 429, 499]) {
  test(`raw endpoint preserves client error status ${status}`, async () => {
    const app = brick({
      services: [],
      requestLogging: false,
      endpoints: [
        {
          method: "GET",
          path: "/raw-error",
          handler: () => {
            throw { status, message: "Expected client failure" };
          },
        },
      ],
    });
    const response = await app.handle(
      new Request("http://localhost/raw-error", {
        headers: { "x-request-id": "raw-error-id" },
      }),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      name: "ActionExecutionError",
      code: "HTTP_ERROR",
      message: "Expected client failure",
      status,
      requestId: "raw-error-id",
    });
  });
}

test("raw endpoint rejects invalid statuses and redacts unexpected server failures", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const status of [399, 404.5, NaN, Infinity, "404", 500, 503, 600]) {
      const thrown = { status, message: "private endpoint failure" };
      const app = brick({
        services: [],
        requestLogging: false,
        endpoints: [
          {
            method: "GET",
            path: "/raw-error",
            handler: () => {
              throw thrown;
            },
          },
        ],
      });
      const response = await app.handle(
        new Request("http://localhost/raw-error"),
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal Server Error",
        status: 500,
      });
      expect(log.mock.calls.flat()).toContain(thrown);
    }
  } finally {
    log.mockRestore();
  }
});

test("output validation redacts failing values and logs diagnostics", async () => {
  const action = defineAction({
    name: "invalidOutput",
    output: t.Object({ token: t.Number() }),
    execute: () => ({ token: "private-output-token" }) as any,
  });
  const service = defineService("output_redaction").action(action);
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const app = brick({
      services: [service],
      requestLogging: false,
    });
    const response = await app.handle(
      new Request(`http://localhost/api/${service.name}/invalid-output`, {
        method: "POST",
      }),
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({
      name: "ValidationError",
      code: "VALIDATION_FAILED",
      status: 500,
    });
    expect(body).not.toHaveProperty("errors");
    expect(JSON.stringify(body)).not.toContain("private-output-token");
    const diagnostic = log.mock.calls
      .flat()
      .find((item) => item instanceof ValidationError);
    expect(diagnostic?.errors).toContainEqual(
      expect.objectContaining({ value: "private-output-token" }),
    );
  } finally {
    log.mockRestore();
  }
});

test("input validation keeps caller-provided values and endpoint output validation redacts them", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const status of [400, 500]) {
      const diagnostic = new ValidationError(
        "Validation failed",
        [
          {
            path: "/value",
            message: "Expected number",
            value: "sensitive-value",
          },
        ],
        status,
      );
      const app = brick({
        services: [],
        requestLogging: false,
        endpoints: [
          {
            method: "GET",
            path: "/validation",
            handler: () => {
              throw diagnostic;
            },
          },
        ],
      });
      const response = await app.handle(
        new Request("http://localhost/validation"),
      );
      expect(response.status).toBe(status);
      const body = await response.json();
      if (status === 400)
        expect(body.errors).toEqual([
          {
            path: "/value",
            message: "Expected number",
            value: "sensitive-value",
          },
        ]);
      else {
        expect(body).not.toHaveProperty("errors");
        expect(log.mock.calls.flat()).toContain(diagnostic);
      }
    }
  } finally {
    log.mockRestore();
  }
});

const SlugExists = defineError("SLUG_EXISTS", {
  status: 409,
  message: "Slug is already taken",
  details: t.Object({ slug: t.String(), takenBy: t.String() }),
});

test("defineError types details, keeps plain errors loose, and shows in OpenAPI", async () => {
  const create = defineAction({
    name: "create",
    errors: { ...SlugExists, PLAIN: { status: 400, message: "Plain" } },
    execute: ({ error }) => {
      error.SLUG_EXISTS(undefined, { slug: "a", takenBy: "u_1" });
    },
  });
  const failure = await create.execute({}).catch((e) => e);
  expect(failure).toMatchObject({
    code: "SLUG_EXISTS",
    status: 409,
    message: "Slug is already taken",
    details: { slug: "a", takenBy: "u_1" },
  });
  // Types only: details are not validated at runtime.
  const loose = defineAction({
    name: "loose",
    errors: { ...SlugExists },
    execute: ({ error }) => error.SLUG_EXISTS(undefined, { slug: 1 } as any),
  });
  expect((await loose.execute({}).catch((e) => e)).details).toEqual({
    slug: 1,
  });

  const spec = generateOpenApiSpec({
    services: [defineService("detail_errors").action(create)],
  });
  const alternatives =
    spec.paths["/api/detail_errors/create"].post.responses[409].content[
      "application/json"
    ].schema.oneOf;
  expect(alternatives[0].allOf[1].properties.details).toMatchObject({
    type: "object",
    required: ["slug", "takenBy"],
  });
});
