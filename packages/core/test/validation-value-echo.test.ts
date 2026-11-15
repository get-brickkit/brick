import { beforeEach, expect, it } from "bun:test";
import { brick, defineService, resetGlobalRegistry, t } from "@brickkit/core";

const SECRET = "hunter2-SECRET-9f3a";

beforeEach(resetGlobalRegistry);

// The output side (500 body and log) is covered in typed-errors.test.ts.
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
