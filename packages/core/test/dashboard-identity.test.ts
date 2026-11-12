import { beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import {
  brick,
  DASHBOARD_IDENTITY_HEADER,
  dashboardUser,
  defineAction,
  defineService,
  generateOpenApiSpec,
  resetGlobalRegistry,
  signDashboardIdentity,
  useService,
} from "@brickkit/core";
import { markDashboardArrival } from "../src/dashboard-identity";

const ada = { id: "u1", name: "Ada" };
const withHeader = (value?: string) =>
  new Request("http://localhost/x", {
    headers: value === undefined ? {} : { [DASHBOARD_IDENTITY_HEADER]: value },
  });

describe("dashboardUser", () => {
  it("reads the user the dashboard signed", () => {
    expect(
      dashboardUser(withHeader(signDashboardIdentity({ user: ada }))),
    ).toEqual(ada);
    expect(
      dashboardUser(withHeader(signDashboardIdentity({}))),
    ).toBeUndefined();
  });

  it("is undefined for a missing, malformed, forged, tampered or stale header", () => {
    const signed = signDashboardIdentity({ user: ada });
    const [payload, mac] = signed.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ user: { id: "root" }, exp: Date.now() + 60_000 }),
    ).toString("base64url");
    for (const value of [
      undefined,
      "",
      "garbage",
      `${payload}.`,
      `.${mac}`,
      `${forged}.${mac}`,
      `${payload}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`,
      `${payload}x.${mac}`,
      signDashboardIdentity({ user: ada }, Date.now() - 120_000),
    ])
      expect(dashboardUser(withHeader(value))).toBeUndefined();
  });
});

it("checks the signature's age when the request arrived, not after a slow body", () => {
  const request = withHeader(signDashboardIdentity({ user: ada }));
  markDashboardArrival(request);
  try {
    setSystemTime(new Date(Date.now() + 120_000));
    expect(dashboardUser(request)).toEqual(ada);
    expect(
      dashboardUser(
        withHeader(request.headers.get(DASHBOARD_IDENTITY_HEADER)!),
      ),
    ).toBeUndefined();
  } finally {
    setSystemTime();
  }
});

describe("action({ dashboard: true })", () => {
  beforeEach(() => resetGlobalRegistry());

  function app() {
    const service = defineService("admin");
    service.action(
      defineAction({
        name: "whoami",
        dashboard: true,
        execute: ({ ctx }) => ({ user: ctx.dashboard?.user ?? null }),
      }),
    );
    service.action(
      defineAction({
        name: "open",
        execute: ({ ctx }) => ({ user: ctx.dashboard?.user ?? null }),
      }),
    );
    return brick({ services: [service] });
  }
  const call = (
    server: ReturnType<typeof app>,
    action: string,
    header?: string,
  ) =>
    server.handle(
      new Request(`http://localhost/api/admin/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(header === undefined
            ? {}
            : { [DASHBOARD_IDENTITY_HEADER]: header }),
        },
        body: "{}",
      }),
    );

  it("answers a call the dashboard signed, with ctx.dashboard.user", async () => {
    const response = await call(
      app(),
      "whoami",
      signDashboardIdentity({ user: ada }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user: ada });
  });

  it("refuses with 401 a call with no, or a forged, dashboard identity", async () => {
    const server = app();
    const signed = signDashboardIdentity({ user: ada });
    for (const header of [undefined, "forged.header", `${signed}x`]) {
      const response = await call(server, "whoami", header);
      expect(response.status).toBe(401);
    }
  });

  it("leaves other actions open, with ctx.dashboard only when signed", async () => {
    const server = app();
    expect(await (await call(server, "open")).json()).toEqual({ user: null });
    expect(await (await call(server, "open", "forged.header")).json()).toEqual({
      user: null,
    });
    expect(
      await (
        await call(server, "open", signDashboardIdentity({ user: ada }))
      ).json(),
    ).toEqual({ user: ada });
  });

  it("documents the 401 in OpenAPI", () => {
    app();
    const spec = generateOpenApiSpec();
    const responses = spec.paths["/api/admin/whoami"].post.responses;
    expect(responses["401"]).toBeDefined();
    expect(spec.paths["/api/admin/open"].post.responses["401"]).toBeUndefined();
  });

  it("passes the dashboard identity on through a call to another service", async () => {
    const admin = defineService("admin");
    admin.action(
      defineAction({
        name: "whoami",
        dashboard: true,
        execute: ({ ctx }) => ({ user: ctx.dashboard?.user ?? null }),
      }),
    );
    const front = defineService("front");
    front.action(
      defineAction({
        name: "relay",
        execute: ({ ctx }) =>
          useService(admin, { from: "front" }).whoami(undefined, ctx),
      }),
    );
    const server = brick({ services: [admin, front] });
    const relay = (header?: string) =>
      server.handle(
        new Request("http://localhost/api/front/relay", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(header ? { [DASHBOARD_IDENTITY_HEADER]: header } : {}),
          },
          body: "{}",
        }),
      );
    const signed = await relay(signDashboardIdentity({ user: ada }));
    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ user: ada });
    expect((await relay()).status).toBe(401);
  });

  it("refuses an in-process call without a dashboard context", async () => {
    const service = defineService("inproc");
    const whoami = defineAction({
      name: "whoami",
      dashboard: true,
      execute: ({ ctx }) => ctx.dashboard?.user?.id,
    });
    service.action(whoami);
    await expect(whoami.run(undefined, {})).rejects.toMatchObject({
      status: 401,
    });
    expect(await whoami.run(undefined, { dashboard: { user: ada } })).toBe(
      "u1",
    );
  });
});
