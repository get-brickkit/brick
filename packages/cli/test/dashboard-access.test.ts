import { describe, expect, it } from "bun:test";
import type { IncomingMessage } from "node:http";
import { createAccess, isLoopbackHost } from "../src/dashboard-access";

const token = "0123456789abcdef-secret";
const other = "fedcba9876543210-rotated";

/** The parts of a request the access check reads. */
function request(
  headers: Record<string, string> = {},
  extra: { method?: string; url?: string } = {},
): IncomingMessage {
  return {
    method: extra.method ?? "GET",
    url: extra.url ?? "/api/state",
    headers: { host: "monitor.example.com", ...headers },
  } as unknown as IncomingMessage;
}

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("isLoopbackHost", () => {
  it("is true only for addresses that stay on the machine", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"])
      expect(isLoopbackHost(host)).toBe(true);
    for (const host of [
      "0.0.0.0",
      "::",
      "10.0.0.5",
      "example.com",
      "127.evil.com",
    ])
      expect(isLoopbackHost(host)).toBe(false);
  });
});

describe("createAccess with tokens", () => {
  const access = createAccess({ token: [token, other] });

  it("lets in a Bearer token, or a Basic password with any user name", async () => {
    expect(await access(request({ authorization: `Bearer ${token}` }))).toEqual(
      { allowed: true, identity: {} },
    );
    expect(
      await access(request({ authorization: `bearer  ${other} ` })),
    ).toEqual({ allowed: true, identity: {} });
    expect(
      await access(request({ authorization: basic("anyone", token) })),
    ).toEqual({ allowed: true, identity: {} });
    expect(await access(request({ authorization: basic("", other) }))).toEqual({
      allowed: true,
      identity: {},
    });
  });

  it("asks a browser to sign in when there is no valid secret", async () => {
    for (const authorization of [
      undefined,
      "Bearer nope",
      `Bearer ${token}x`,
      token,
      "Basic !!!",
      basic("user", "wrong"),
      // The secret in the user name does not count.
      basic(token, ""),
    ]) {
      const decision = await access(
        request(authorization ? { authorization } : {}),
      );
      expect(decision).toMatchObject({ allowed: false, status: 401 });
      expect(
        (decision as { headers: Record<string, string> }).headers,
      ).toMatchObject({
        "www-authenticate": 'Basic realm="Brick dashboard", charset="UTF-8"',
      });
    }
  });
});

describe("createAccess with authorize", () => {
  it("lets in what authorize allows, and refuses with 401 and no prompt otherwise", async () => {
    const access = createAccess({
      authorize: (req) =>
        req.headers.get("cookie")?.includes("session=ok") === true,
    });
    expect(await access(request({ cookie: "a=1; session=ok" }))).toEqual({
      allowed: true,
      identity: {},
    });
    const refused = await access(request({ cookie: "session=bad" }));
    expect(refused).toMatchObject({ allowed: false, status: 401 });
    expect(
      (refused as { headers: Record<string, string> }).headers,
    ).not.toHaveProperty("www-authenticate");
  });

  it("lets in, as that user, an identity authorize returns; refuses a malformed one", async () => {
    const access = createAccess({
      authorize: (req) =>
        (req.headers.get("x-user") === "ada"
          ? { user: { id: "u1", name: "Ada" } }
          : { user: { name: "no id" } }) as never,
    });
    expect(await access(request({ "x-user": "ada" }))).toEqual({
      allowed: true,
      identity: { user: { id: "u1", name: "Ada" } },
    });
    expect(await access(request())).toMatchObject({
      allowed: false,
      status: 401,
    });
  });

  it("hands authorize a standard request: method, address, headers, no body", async () => {
    let seen: Request | undefined;
    const access = createAccess({
      authorize: (req) => {
        seen = req;
        return true;
      },
    });
    await access(
      request(
        {
          "x-forwarded-proto": "https",
          cookie: "s=1",
          authorization: "Bearer x",
        },
        { method: "GET", url: "/api/history/traces?limit=5" },
      ),
    );
    expect(seen).toBeInstanceOf(Request);
    expect(seen!.method).toBe("GET");
    expect(seen!.url).toBe(
      "https://monitor.example.com/api/history/traces?limit=5",
    );
    expect(seen!.headers.get("cookie")).toBe("s=1");
    expect(seen!.headers.get("authorization")).toBe("Bearer x");
  });

  it("sends a Response from authorize as it is, for a redirect to a login page", async () => {
    const access = createAccess({
      authorize: () => {
        const response = new Response("go sign in", {
          status: 302,
          headers: { location: "https://app.example.com/login" },
        });
        response.headers.append("set-cookie", "a=1; Path=/");
        response.headers.append("set-cookie", "b=2; Path=/");
        return response;
      },
    });
    const decision = await access(request());
    expect(decision).toMatchObject({ allowed: false, status: 302 });
    const { headers, body } = decision as {
      headers: Record<string, string | string[]>;
      body: Uint8Array;
    };
    expect(headers.location).toBe("https://app.example.com/login");
    expect(headers["set-cookie"]).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(headers).not.toHaveProperty("content-length");
    expect(new TextDecoder().decode(body)).toBe("go sign in");
  });

  it("refuses with 503 when authorize throws or runs out of time", async () => {
    const errors: unknown[] = [];
    const throws = createAccess(
      {
        authorize: () => {
          throw new Error("auth database down");
        },
      },
      (error) => errors.push(error),
    );
    expect(await throws(request())).toMatchObject({
      allowed: false,
      status: 503,
    });
    const rejects = createAccess(
      { authorize: () => Promise.reject(new Error("nope")) },
      (error) => errors.push(error),
    );
    expect(await rejects(request())).toMatchObject({
      allowed: false,
      status: 503,
    });
    const hangs = createAccess(
      { authorize: () => new Promise<boolean>(() => {}) },
      (error) => errors.push(error),
      20,
    );
    expect(await hangs(request())).toMatchObject({
      allowed: false,
      status: 503,
    });
    expect(errors).toHaveLength(3);
  });

  it("does not let a truthy value that is not true in", async () => {
    const access = createAccess({
      authorize: (() => "yes") as unknown as () => boolean,
    });
    expect(await access(request())).toMatchObject({
      allowed: false,
      status: 401,
    });
  });
});

describe("createAccess with both", () => {
  it("lets a token in without asking authorize, and falls back to authorize", async () => {
    let asked = 0;
    const access = createAccess({
      token,
      authorize: (req) => {
        asked++;
        return req.headers.get("x-user") === "ada";
      },
    });
    expect(await access(request({ authorization: `Bearer ${token}` }))).toEqual(
      { allowed: true, identity: {} },
    );
    expect(asked).toBe(0);
    expect(await access(request({ "x-user": "ada" }))).toEqual({
      allowed: true,
      identity: {},
    });
    expect(asked).toBe(1);
    // Refused by authorize, the browser can still be asked for a token.
    const refused = await access(request({ "x-user": "eve" }));
    expect(refused).toMatchObject({ allowed: false, status: 401 });
    expect(
      (refused as { headers: Record<string, string> }).headers[
        "www-authenticate"
      ],
    ).toContain("Basic");
  });
});
