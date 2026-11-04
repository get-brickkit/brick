// Cross-language conformance: the same actions in TS, Go and Rust behind one
// Bun gateway must answer identically. Needs `go` and `cargo`; skipped without
// them, except under CI.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ActionExecutionError,
  internalToken,
  startRemoteServices,
  useService,
  type RemoteProcesses,
} from "@brickkit/core";
import { buildRemoteServices, writePolyglotContract } from "@brickkit/cli";
import app, { ISSUER, confGo, confRust, signJwt } from "./app";

const dir = import.meta.dir;
const toolchains = Boolean(Bun.which("go") && Bun.which("cargo"));
if (!toolchains && process.env.CI)
  throw new Error("CI must install go and cargo for the conformance test");
const generated = [
  join(dir, "../go/conformance/brickclient/client.go"),
  join(dir, "../rust/conformance/src/brick_client.rs"),
];

let children: RemoteProcesses;
let base: string;

beforeAll(async () => {
  if (!toolchains) return;
  const committed = generated.map((file) => readFileSync(file, "utf8"));
  await writePolyglotContract(join(dir, "app.ts"), undefined, dir);
  // The generated clients are committed: regenerating must not change them.
  expect(generated.map((file) => readFileSync(file, "utf8"))).toEqual(
    committed,
  );
  buildRemoteServices(app, dir);
  app.listen({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${app.server!.port}`;
  children = await startRemoteServices([confGo, confRust], {
    mode: "start",
    appUrl: base,
    services: ["confTs"],
    cwd: dir,
    env: { BRICK_JWT_ISSUER: ISSUER, BRICK_JWKS_URL: `${base}/jwks` },
  });
  await children.ready();
}, 600_000);

afterAll(async () => {
  if (!toolchains) return;
  await children?.stop();
  await app.stop();
});

const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const SERVICES = ["conf-ts", "conf-go", "conf-rust"];

async function sameEverywhere(
  action: string,
  input: unknown,
  headers: Record<string, string> = {},
) {
  const bodies = await Promise.all(
    SERVICES.map(async (service) => {
      const response = await post(`/api/${service}/${action}`, input, {
        "x-request-id": "conf-1",
        ...headers,
      });
      return `${response.status} ${await response.text()}`;
    }),
  );
  expect(bodies[1]).toBe(bodies[0]!);
  expect(bodies[2]).toBe(bodies[0]!);
  return bodies[0]!;
}

describe.skipIf(!toolchains)("polyglot conformance", () => {
  it("rejects bad input with byte-identical envelopes", async () => {
    expect(
      await sameEverywhere("validate", { name: "ab", age: 200, role: "nope" }),
    ).toBe(
      `400 {"name":"ValidationError","code":"VALIDATION_FAILED","message":"Validation failed for action 'validate' input","status":400,"errors":[{"path":"/name","message":"Expected string length greater or equal to 3","value":"ab"},{"path":"/age","message":"Expected integer to be less or equal to 150","value":200},{"path":"/role","message":"Expected union value","value":"nope"}],"requestId":"conf-1"}`,
    );
    await sameEverywhere("validate", {});
    await sameEverywhere("validate", { name: 5, age: 1.5, role: null });
    await sameEverywhere("validate", {
      name: "a".repeat(21),
      age: -1,
      role: "user",
    });
  });

  it("answers valid input the same", async () => {
    expect(
      await sameEverywhere("validate", {
        name: "alice",
        age: 30,
        role: "admin",
      }),
    ).toBe('200 {"ok":true}');
  });

  it("returns a typed error with the same envelope", async () => {
    expect(await sameEverywhere("fail", {})).toBe(
      '418 {"name":"ActionExecutionError","code":"TEAPOT","message":"I am a teapot","status":418,"details":{"kind":"tea"},"requestId":"conf-1"}',
    );
  });

  it("gives a TS caller of a Go or Rust error an ActionExecutionError", async () => {
    for (const service of [confGo, confRust]) {
      const error = await useService(service, { from: "confTs" })
        .fail({})
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ActionExecutionError);
      expect(error).toMatchObject({
        code: "TEAPOT",
        status: 418,
        details: { kind: "tea" },
      });
    }
  });

  it("propagates user, caller and request id through TS → Go → Rust → TS", async () => {
    const response = await post(
      "/api/conf-ts/chain",
      {},
      {
        authorization: `Bearer ${await signJwt({ id: "alice" })}`,
        "x-request-id": "chain-1",
      },
    );
    const user = { id: "alice" };
    expect(await response.json()).toMatchObject({
      service: "confTs",
      user,
      requestId: "chain-1",
      next: {
        service: "confGo",
        user,
        caller: "confTs",
        requestId: "chain-1",
        next: {
          service: "confRust",
          user,
          caller: "confGo",
          requestId: "chain-1",
          next: {
            service: "confTs",
            user,
            caller: "confRust",
            requestId: "chain-1",
          },
        },
      },
    });
  });

  it("verifies the JWT in Go and Rust, and the gateway strips spoofed x-brick-* headers", async () => {
    const token = await signJwt({ id: "bob" });
    for (const service of ["conf-go", "conf-rust"]) {
      const response = await post(
        `/api/${service}/whoami`,
        {},
        {
          authorization: `Bearer ${token}`,
          "x-request-id": "who-1",
          "x-brick-caller": "admin",
          "x-brick-user": btoa('{"id":"mallory"}'),
        },
      );
      const body = await response.json();
      expect(body).toMatchObject({ user: { id: "bob" }, requestId: "who-1" });
      expect(body.caller ?? undefined).toBeUndefined();
    }
  });

  it("trusts x-brick-* on a direct call only with the internal token", async () => {
    for (const url of Object.values(children.urls).filter(
      (u) => !u.startsWith(base),
    )) {
      const spoofed = { "x-brick-user": btoa('{"id":"mallory"}') };
      const anonymous = await fetch(`${url}/whoami`, {
        method: "POST",
        body: "{}",
        headers: spoofed,
      });
      expect(anonymous.status).toBe(200);
      expect((await anonymous.json()).user).toBeNull();
      const trusted = await fetch(`${url}/whoami`, {
        method: "POST",
        body: "{}",
        headers: { ...spoofed, "x-brick-internal": internalToken() },
      });
      expect((await trusted.json()).user).toEqual({ id: "mallory" });
      const wrong = await fetch(`${url}/whoami`, {
        method: "POST",
        body: "{}",
        headers: { "x-brick-internal": "guess" },
      });
      expect(wrong.status).toBe(401);
    }
  });

  it("answers a missing, expired or foreign user with the same 401 as TS", async () => {
    const unauthorized = `401 {"name":"ActionExecutionError","code":"UNAUTHORIZED","message":"Access denied for action 'me'","status":401,"requestId":"conf-1"}`;
    expect(await sameEverywhere("me", {})).toBe(unauthorized);
    const expired = await signJwt({ id: "bob" }, -120);
    expect(
      await sameEverywhere("me", {}, { authorization: `Bearer ${expired}` }),
    ).toBe(unauthorized);
    const valid = await signJwt({ id: "bob" });
    expect(
      await sameEverywhere("me", {}, { authorization: `Bearer ${valid}` }),
    ).toBe('200 {"id":"bob"}');
  });
});
