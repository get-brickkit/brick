import { beforeEach, expect, it } from "bun:test";
import {
  brick,
  defineService,
  resetGlobalRegistry,
  t,
  type ValidationError,
} from "@brickkit/core";
import { decodeError } from "../src/protocol";

const SECRET = "hunter2-SECRET-9f3a";

beforeEach(resetGlobalRegistry);

it("does not echo a rejected input value in the 400 body", async () => {
  const service = defineService("auth");
  service.action({
    name: "login",
    method: "POST",
    input: t.Object({ password: t.String({ minLength: 64 }) }),
    execute: () => ({ ok: true }),
  });
  const response = await brick({
    services: [service],
    requestLogging: false,
  }).handle(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: SECRET }),
    }),
  );
  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.errors).toEqual([
    { path: "/password", message: expect.any(String) },
  ]);
  expect(JSON.stringify(body)).not.toContain(SECRET);
});

it("drops the value and any item that is not an object when rebuilding a server's error", () => {
  const error = decodeError(
    {
      name: "ValidationError",
      errors: [null, "x", { path: "/password", message: "bad", value: SECRET }],
    },
    400,
  ) as ValidationError;
  expect(error.errors).toEqual([{ path: "/password", message: "bad" }]);
  expect(JSON.stringify(error)).not.toContain(SECRET);
});
