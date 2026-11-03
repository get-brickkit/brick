import { beforeEach, describe, expect, it } from "bun:test";
import {
  brick,
  defineService,
  resetGlobalRegistry,
  type CorsOptions,
} from "../src";

const APP = "https://app.example.com";
const EVIL = "https://evil.example.com";

beforeEach(resetGlobalRegistry);

function app(cors: CorsOptions) {
  const users = defineService("users");
  users.action({ name: "me", execute: () => ({ ok: true }) });
  return brick({ services: [users], docs: false, requestLogging: false, cors });
}

const call = (
  server: ReturnType<typeof app>,
  origin?: string,
  init: RequestInit = { method: "POST" },
) =>
  server.handle(
    new Request("http://localhost/api/users/me", {
      ...init,
      headers: { ...(origin ? { origin } : {}), ...init.headers },
    }),
  );

const preflight = (server: ReturnType<typeof app>, origin: string) =>
  call(server, origin, {
    method: "OPTIONS",
    headers: {
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type, authorization",
    },
  });

describe("brick({ cors })", () => {
  it("allows a listed origin, with credentials, and varies on Origin", async () => {
    const server = app({ origin: [APP], credentials: true });
    const response = await call(server, APP);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
    expect(response.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("never reflects an origin that isn't allowed", async () => {
    for (const cors of [
      { origin: [APP], credentials: true },
      { origin: APP, credentials: true },
      { origin: (origin: string) => origin === APP, credentials: true },
      // A prefix or suffix of an allowed origin is a different origin.
      { origin: "https://app.example.co", credentials: true },
    ] satisfies CorsOptions[]) {
      resetGlobalRegistry();
      const server = app(cors);
      for (const origin of [EVIL, `${APP}.evil.com`, "null"]) {
        const response = await call(server, origin);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
        expect(
          response.headers.get("access-control-allow-credentials"),
        ).toBeNull();
        const pre = await preflight(server, origin);
        expect(pre.headers.get("access-control-allow-origin")).toBeNull();
        expect(pre.headers.get("access-control-allow-methods")).toBeNull();
      }
    }
  });

  it("answers a preflight for an allowed origin before routing", async () => {
    const server = app({ origin: (origin) => origin === APP });
    const response = await preflight(server, APP);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(APP);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "content-type, authorization",
    );
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("true allows only the app's own origin", async () => {
    const server = app(true);
    expect(
      (await call(server, "http://localhost")).headers.get(
        "access-control-allow-origin",
      ),
    ).toBe("http://localhost");
    expect(
      (await call(server, EVIL)).headers.get("access-control-allow-origin"),
    ).toBeNull();
  });

  it("adds headers to error responses too, and nothing without an Origin", async () => {
    const server = app(APP);
    const missing = await server.handle(
      new Request("http://localhost/api/nope", { headers: { origin: APP } }),
    );
    expect(missing.status).toBe(404);
    expect(missing.headers.get("access-control-allow-origin")).toBe(APP);
    const plain = await call(server);
    expect(plain.headers.get("access-control-allow-origin")).toBeNull();
    expect(plain.headers.get("vary")).toBeNull();
  });

  it('refuses the "*" origin at startup', () => {
    expect(() => app("*")).toThrow('cors origin "*"');
    expect(() => app({ origin: ["*"], credentials: true })).toThrow();
  });
});
