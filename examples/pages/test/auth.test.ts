import { describe, it, expect, beforeEach } from "bun:test";

import { defineDatabase, eq } from "@brickkit/core";
import { hash } from "bcryptjs";

import { createAuthInstance, initAuth } from "../src/api/auth/index";
import { account, user } from "../src/api/auth/schema";
import { authTables } from "../src/api/db";
import { listPagesTool } from "../src/api/services/pages/mcp";
import { pagesService } from "../src/api/services/pages/service";
import { TEST_DATABASE_URL, prepareTestDatabase } from "./database";

const EMAIL = "auth.case@example.com";
const PASSWORD = "correct-horse-8";

function isolatedAuth() {
  const database = defineDatabase({
    engine: "postgres",
    tables: authTables,
    url: TEST_DATABASE_URL,
  });
  return initAuth(database);
}

function authedHeaders(auth: ReturnType<typeof createAuthInstance>) {
  return {
    signIn: (email = EMAIL, password = PASSWORD) =>
      auth.api.signInEmail({ body: { email, password } }),
    /** Raw Response carrying set-cookie (API returns data-only by default). */
    signInResponse: (email = EMAIL, password = PASSWORD) =>
      auth.api.signInEmail({
        asResponse: true,
        body: { email, password },
      }) as unknown as Promise<Response>,
    signup: (email = EMAIL, password = PASSWORD) =>
      auth.api.signUpEmail({ body: { email, name: "Auth Case", password } }),
  };
}

function sessionCookie(res: Response): string {
  const cookie = res.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-in response carried no set-cookie");
  return cookie;
}

describe("better-auth + service context loading", () => {
  beforeEach(async () => {
    await prepareTestDatabase();
  });

  it("signs up and signs in with email+password (min length 8)", async () => {
    const auth = isolatedAuth();
    const api = authedHeaders(auth);
    const signedUp = await api.signup();
    expect(signedUp.user.email).toBe(EMAIL);
    const cookie = sessionCookie(await api.signInResponse());
    expect(cookie).toContain("better-auth.session_token");
    await expect(api.signup()).rejects.toThrow();
    await expect(api.signIn(EMAIL, "wrong-password")).rejects.toThrow();
  });

  it("shares a defined database between auth and pages", async () => {
    const database = await prepareTestDatabase();
    const auth = createAuthInstance(database);
    const signedUp = await authedHeaders(auth).signup();
    expect(pagesService.getDb()).toBe(database.getDb());
    const rows = await database.getDb().select({ id: user.id }).from(user);
    expect(rows[0]?.id).toBe(signedUp.user.id);
    expect(database.tables.pagesTable).toBeDefined();
  });

  it("signs in with a restored bcrypt account without rewriting its hash", async () => {
    const database = await prepareTestDatabase();
    const auth = createAuthInstance(database);
    const api = authedHeaders(auth);
    const signedUp = await api.signup();
    const legacyHash = await hash(PASSWORD, 4);
    const db = database.getDb();
    await db
      .update(account)
      .set({ password: legacyHash })
      .where(eq(account.userId, signedUp.user.id));

    expect(sessionCookie(await api.signInResponse())).toContain(
      "better-auth.session_token",
    );
    await expect(api.signIn(EMAIL, "wrong-password")).rejects.toThrow();
    const rows = await db
      .select({ password: account.password })
      .from(account)
      .where(eq(account.userId, signedUp.user.id));
    expect(rows[0]?.password).toBe(legacyHash);
  });

  it("loads user/session into service context from the session cookie", async () => {
    const auth = isolatedAuth();
    const api = authedHeaders(auth);
    const signedUp = await api.signup();
    const cookie = sessionCookie(await api.signInResponse());

    const ctx = await pagesService.resolveContext({
      request: new Request("http://localhost/api/pages/page", {
        headers: { cookie },
      }),
    });
    expect(ctx.user?.id).toBe(signedUp.user.id);
    expect(ctx.user?.email).toBe(EMAIL);
    expect(ctx.session).toBeDefined();
  });

  it("leaves user null without a session cookie (protected tools reject)", async () => {
    isolatedAuth();
    const ctx = await pagesService.resolveContext({
      request: new Request("http://localhost/api/pages/page"),
    });
    expect(ctx.user).toBeNull();
    await expect(listPagesTool({ ctx, input: {} })).rejects.toThrow(
      /unauthorized|access denied/i,
    );
  });

  it("session-authenticated requests pass protected tools", async () => {
    const auth = isolatedAuth();
    const api = authedHeaders(auth);
    await api.signup();
    const cookie = sessionCookie(await api.signInResponse());
    const ctx = await pagesService.resolveContext({
      request: new Request("http://localhost/api/pages/page", {
        headers: { cookie },
      }),
    });
    const listed = await listPagesTool({ ctx, input: {} });
    expect(Array.isArray(listed)).toBe(true);
    expect(listed).toHaveLength(0);
  });
});
