// A JWT that Better Auth issues for a signed-in user is accepted by the Go and
// Rust bench services, which see the same user the TS service sees; without
// it all three answer the same 401. Needs `go` and `cargo`; skipped without.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  brick,
  startRemoteServices,
  type RemoteProcesses,
} from "@brickkit/core";

import { getAuth } from "../src/api/auth";
import { baseUrlSecret } from "../src/api/secrets";
import {
  benchAuthService,
  benchGo,
  benchRust,
} from "../src/api/services/bench/service";
import { TEST_DATABASE_URL, prepareTestDatabase } from "./database";

const toolchains = Boolean(Bun.which("go") && Bun.which("cargo"));
const root = join(import.meta.dir, "..");
const app = brick({
  services: [benchAuthService],
  docs: false,
  requestLogging: false,
});

let jwks: ReturnType<typeof Bun.serve>;
let children: RemoteProcesses;
let cookie: string;
let token: string;

beforeAll(async () => {
  if (!toolchains) return;
  await prepareTestDatabase();
  // The JWKS the services fetch: Better Auth's own handler.
  jwks = Bun.serve({ port: 0, fetch: (request) => getAuth().handler(request) });
  // Release builds, shared with bench/run.ts.
  for (const remote of [benchGo, benchRust]) {
    const built = Bun.spawnSync(
      ["/bin/sh", "-c", remote.options.build!.command],
      {
        cwd: join(root, remote.options.dir),
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    if (built.exitCode !== 0) throw new Error(`building ${remote.name} failed`);
  }
  children = await startRemoteServices([benchGo, benchRust], {
    mode: "start",
    appUrl: `http://127.0.0.1:${jwks.port}`,
    cwd: root,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      BRICK_JWT_ISSUER: baseUrlSecret.value() as string,
      BRICK_JWKS_URL: `http://127.0.0.1:${jwks.port}/api/auth/jwks`,
    },
  });
  await children.ready(600_000);
  const auth = getAuth();
  const body = { email: "jwt@example.com", password: "correct-horse-8" };
  await auth.api.signUpEmail({ body: { ...body, name: "Jay" } });
  const signedIn = (await auth.api.signInEmail({
    body,
    asResponse: true,
  })) as unknown as Response;
  cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  ({ token } = await auth.api.getToken({ headers: new Headers({ cookie }) }));
}, 900_000);

afterAll(async () => {
  if (!toolchains) return;
  await children?.stop();
  jwks?.stop(true);
});

const tsMe = (headers: Record<string, string>) =>
  app.handle(
    new Request("http://localhost/api/bench-auth/me", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    }),
  );

const remoteMe = (
  service: "benchGo" | "benchRust",
  headers: Record<string, string>,
) =>
  fetch(
    `${children.urls[service]}/api/${service === "benchGo" ? "bench-go" : "bench-rust"}/me`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    },
  );

describe.skipIf(!toolchains)("Better Auth JWT in Go and Rust", () => {
  it("gives Go and Rust the user TS sees from the session", async () => {
    const response = await tsMe({ cookie });
    expect(response.status).toBe(200);
    const user = await response.json();
    expect(user).toMatchObject({ email: "jwt@example.com", name: "Jay" });
    for (const service of ["benchGo", "benchRust"] as const) {
      const remote = await remoteMe(service, {
        authorization: `Bearer ${token}`,
      });
      expect(remote.status).toBe(200);
      expect(await remote.json()).toEqual(user);
    }
  });

  it("answers a missing or forged token with the TS 401 envelope", async () => {
    const ts = await tsMe({ "x-request-id": "jwt-1" });
    const expected = `${ts.status} ${await ts.text()}`;
    expect(expected).toBe(
      `401 {"name":"ActionExecutionError","code":"UNAUTHORIZED","message":"Access denied for action 'me'","status":401,"requestId":"jwt-1"}`,
    );
    const [head, payload] = token.split(".");
    const forged = `${head}.${payload}.${"A".repeat(86)}`;
    for (const service of ["benchGo", "benchRust"] as const)
      for (const headers of [
        { "x-request-id": "jwt-1" },
        { "x-request-id": "jwt-1", authorization: `Bearer ${forged}` },
        // Without the internal token, a forwarded user is ignored.
        { "x-request-id": "jwt-1", "x-brick-user": btoa('{"id":"mallory"}') },
      ]) {
        const response = await remoteMe(service, headers);
        expect(`${response.status} ${await response.text()}`).toBe(expected);
      }
  });
});
