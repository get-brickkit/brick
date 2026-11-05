import { describe, it, expect, beforeEach } from "bun:test";
import {
  defineService,
  defineDatabase,
  useService,
  t,
  resetGlobalRegistry,
} from "../src";

interface User {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

interface Session {
  id: string;
  userId: string;
  expiresAt: Date;
}

const mockAuth = {
  api: {
    getSession: async ({
      headers,
    }: {
      headers: Headers;
    }): Promise<{ user: User; session: Session } | null> => {
      const authHeader = headers.get("authorization");
      if (authHeader === "Bearer valid-token") {
        return {
          user: {
            id: "usr_alice",
            email: "alice@example.com",
            name: "Alice Smith",
            role: "admin",
          },
          session: {
            id: "sess_123",
            userId: "usr_alice",
            expiresAt: new Date(Date.now() + 3600000),
          },
        };
      }
      return null;
    },
  },
};

describe("Service-Level Context Resolution & Session Injection", () => {
  beforeEach(() => {
    resetGlobalRegistry();
  });

  it("should declare service-level context with Better Auth session injection", async () => {
    const docsService = defineService("docs", {
      database: defineDatabase(),
      context: async ({ request }) => {
        const session = await mockAuth.api.getSession({
          headers: request.headers,
        });

        return {
          user: session?.user ?? null,
          session: session?.session ?? null,
          isOwner: (ownerId: string) => session?.user?.id === ownerId,
        };
      },
    });

    const createDoc = docsService.action({
      name: "createDoc",
      input: t.Object({
        title: t.String(),
        content: t.String(),
      }),
      output: t.Object({
        id: t.String(),
        title: t.String(),
        authorEmail: t.String(),
        authorRole: t.String(),
        isOwner: t.Boolean(),
      }),
      authorize: ({ ctx }) => {
        return ctx.user !== null;
      },
      // In execute, ctx.user is strictly narrowed from User | null to User!
      execute: async ({ input, ctx }) => {
        // Compile-time check: ctx.user is non-null User
        const author: User = ctx.user;
        const owns = ctx.isOwner(author.id);

        return {
          id: "doc_1",
          title: input.title,
          authorEmail: author.email,
          authorRole: author.role,
          isOwner: owns,
        };
      },
    });

    await expect(
      createDoc.run({
        title: "Secret Doc",
        content: "Draft",
      }),
    ).rejects.toThrow("Access denied for action 'createDoc'");

    // Authenticate through the resolver's request instead of replacing its session.
    const result = await createDoc.run(
      { title: "My Architecture Doc", content: "# Hello World" },
      {
        request: new Request("http://localhost", {
          headers: { authorization: "Bearer valid-token" },
        }),
      },
    );

    expect(result).toBeDefined();
    expect(result.title).toBe("My Architecture Doc");
    expect(result.authorEmail).toBe("alice@example.com");
    expect(result.authorRole).toBe("admin");
    expect(result.isOwner).toBe(true);
  });

  it("should run the context hook once and resolve sessions via request headers", async () => {
    let contextResolutionCount = 0;

    const securedService = defineService("secured", {
      context: async ({ request }) => {
        contextResolutionCount++;
        const session = await mockAuth.api.getSession({
          headers: request.headers,
        });
        return {
          user: session?.user ?? null,
          session: session?.session ?? null,
        };
      },
    });

    const getProfile = securedService.action({
      name: "getProfile",
      authorize: ({ ctx }) => ctx.user !== null,
      execute: async ({ ctx }) => {
        return {
          userId: ctx.user.id,
          email: ctx.user.email,
        };
      },
    });

    const authedRequest = new Request(
      "http://localhost/api/secured/getProfile",
      {
        headers: {
          authorization: "Bearer valid-token",
        },
      },
    );

    const authedResult = await getProfile.execute({
      ctx: { request: authedRequest },
    });

    expect(authedResult.userId).toBe("usr_alice");
    expect(authedResult.email).toBe("alice@example.com");
    expect(contextResolutionCount).toBe(1);

    const unauthedRequest = new Request(
      "http://localhost/api/secured/getProfile",
      {
        headers: {
          authorization: "Bearer invalid-token",
        },
      },
    );

    await expect(
      getProfile.execute({
        ctx: { request: unauthedRequest },
      }),
    ).rejects.toThrow("Access denied for action 'getProfile'");
  });

  it("should keep ctx.user as User | null when action has no authorize guard", async () => {
    const publicService = defineService("public", {
      context: async ({ request }) => {
        const session = await mockAuth.api.getSession({
          headers: request.headers,
        });
        return {
          user: session?.user ?? null,
        };
      },
    });

    const getStatus = publicService.action({
      name: "getStatus",
      execute: async ({ ctx }) => {
        // When authorize is not present, ctx.user is User | null
        const currentUser: User | null = ctx.user;
        return {
          status: "online",
          authenticated: currentUser !== null,
          user: currentUser ? currentUser.email : "anonymous",
        };
      },
    });

    const anon = await getStatus.run();
    expect(anon.authenticated).toBe(false);
    expect(anon.user).toBe("anonymous");

    const authed = await getStatus.run(undefined, {
      request: new Request("http://localhost", {
        headers: { authorization: "Bearer valid-token" },
      }),
    });
    expect(authed.authenticated).toBe(true);
    expect(authed.user).toBe("alice@example.com");
  });

  it("should isolate context when one service calls another (orders -> billing)", async () => {
    const ordersDbCalls: string[] = [];
    const billingDbCalls: string[] = [];

    const ordersDb = defineDatabase();
    const ordersService = defineService("orders", {
      database: ordersDb,
      context: async () => ({
        serviceName: "orders",
        dbName: "orders_db",
      }),
    });

    const billingDb = defineDatabase();
    const billingService = defineService("billing", {
      database: billingDb,
      context: async (baseCtx) => {
        // This context resolver should run when billing actions are called
        // and must already see the originating service as the caller.
        return {
          serviceName: "billing",
          dbName: "billing_db",
          resolverRan: true,
          resolverCaller: (baseCtx as { caller?: string }).caller,
        };
      },
    });

    billingService.action({
      name: "charge",
      input: t.Object({ amount: t.Number() }),
      output: t.Object({
        success: t.Boolean(),
        dbName: t.String(),
        serviceName: t.String(),
        resolverRan: t.Boolean(),
        userId: t.Optional(t.String()),
        caller: t.Optional(t.String()),
        resolverCaller: t.Optional(t.String()),
      }),
      execute: async ({ ctx }) => {
        billingDbCalls.push(ctx.dbName);
        return {
          success: true,
          dbName: ctx.dbName,
          serviceName: ctx.serviceName,
          resolverRan: ctx.resolverRan === true,
          userId: (ctx as { user?: { id: string } }).user?.id,
          caller: ctx.caller,
          resolverCaller: ctx.resolverCaller,
        };
      },
    });

    const createOrderAction = ordersService.action({
      name: "createOrder",
      input: t.Object({ amount: t.Number() }),
      output: t.Object({
        orderId: t.String(),
        chargeResult: t.Object({
          success: t.Boolean(),
          dbName: t.String(),
          serviceName: t.String(),
          resolverRan: t.Boolean(),
          userId: t.Optional(t.String()),
          caller: t.Optional(t.String()),
          resolverCaller: t.Optional(t.String()),
        }),
      }),
      execute: async ({ input, ctx }) => {
        ordersDbCalls.push(ctx.dbName);

        const billingRpc = useService(billingService, { from: "orders" });
        const chargeResult = await billingRpc.charge(
          { amount: input.amount },
          {
            user: { id: "usr_alice" } as any,
            traceId: "tr_envelope_123",
            requestId: "req_envelope_456",
          },
        );

        return {
          orderId: "order_1",
          chargeResult,
        };
      },
    });

    const result = await createOrderAction.run({ amount: 100 }, {
      user: { id: "usr_alice" },
    } as any);

    expect(ordersDbCalls).toContain("orders_db");

    expect(billingDbCalls).toContain("billing_db");
    expect(billingDbCalls).not.toContain("orders_db");

    expect(result.chargeResult.resolverRan).toBe(true);
    expect(result.chargeResult.serviceName).toBe("billing");
    expect(result.chargeResult.dbName).toBe("billing_db");

    expect(result.chargeResult.userId).toBe("usr_alice");

    // Verify billing sees the originating service (orders), not itself, as the caller
    // in both its context resolver and its action.
    expect(result.chargeResult.caller).toBe("orders");
    expect(result.chargeResult.resolverCaller).toBe("orders");
  });

  it("should not let callCtx override the proxy's caller identity", async () => {
    const billingService = defineService("billing", {
      database: defineDatabase(),
    });
    billingService.action({
      name: "whoCalled",
      output: t.Object({ caller: t.Optional(t.String()) }),
      execute: async ({ ctx }) => ({ caller: ctx.caller }),
    });

    const billingRpc = useService(billingService, { from: "orders" });

    // A caller trying to spoof its identity via callCtx must be ignored.
    const result = await billingRpc.whoCalled({}, {
      caller: "not-orders",
    } as any);

    expect(result.caller).toBe("orders");
  });

  it("should prevent caller context fields from overriding receiver's database", async () => {
    const billingService = defineService("billing", {
      database: defineDatabase(),
      context: async () => ({
        isValidDatabase: true,
      }),
    });

    billingService.action({
      name: "getContext",
      output: t.Object({
        isValidDatabase: t.Boolean(),
        fakeDb: t.Boolean(),
      }),
      execute: async ({ ctx }) => ({
        isValidDatabase: ctx.isValidDatabase === true,
        fakeDb: (ctx.db as any)?.isFake === true,
      }),
    });

    const billingRpc = useService(billingService);

    const result = await billingRpc.getContext(
      {},
      {
        db: { isFake: true } as any,
        dbName: "caller_db",
        resolverRan: false,
      },
    );

    expect(result.isValidDatabase).toBe(true);
    expect(result.fakeDb).toBe(false);
  });
});

describe("Receiver-owned context", () => {
  beforeEach(() => resetGlobalRegistry());

  for (const dispatch of ["direct", "proxy"] as const) {
    it(`protects resolver values and drops custom caller keys via ${dispatch}`, async () => {
      const service = defineService("receiver", {
        context: async () => ({
          user: null,
          session: "receiver-session",
          isOwner: () => false,
          custom: "receiver-custom",
          tenantId: "validated-tenant",
          traceId: "receiver-trace",
          requestId: "receiver-request",
          caller: "receiver-caller",
        }),
      });
      const inspect = service.action({
        name: "inspect",
        execute: ({ ctx }) => ({
          user: ctx.user,
          session: ctx.session,
          isOwner: ctx.isOwner(),
          custom: ctx.custom,
          extra: "extra" in ctx,
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          requestId: ctx.requestId,
          caller: ctx.caller,
        }),
      });
      const callerContext = {
        user: { id: "caller-user" },
        session: "caller-session",
        isOwner: () => true,
        custom: "caller-custom",
        extra: "caller-extra",
        tenantId: "claimed-tenant",
        traceId: "caller-trace",
        requestId: "caller-request",
        caller: "caller-service",
      };
      const result =
        dispatch === "direct"
          ? await inspect.run(undefined, callerContext as any)
          : await useService(service, {
              context: callerContext,
            }).inspect(undefined, callerContext);
      expect(result).toEqual({
        user: null,
        session: "receiver-session",
        isOwner: false,
        custom: "receiver-custom",
        extra: false,
        tenantId: "validated-tenant",
        traceId: "receiver-trace",
        requestId: "receiver-request",
        caller: "receiver-caller",
      });
    });

    it(`resolves an internal call from the envelope without cookies via ${dispatch}`, async () => {
      const service = defineService("receiver", {
        context: async (envelope) => {
          const user = "user" in envelope ? envelope.user : undefined;
          return {
            user,
            session: null,
            hasCookies: envelope.request.headers.has("cookie"),
            isOwner: (id: string) =>
              typeof user === "object" &&
              user !== null &&
              "id" in user &&
              user.id === id,
            caller: "caller" in envelope ? envelope.caller : undefined,
            tenantId: "tenantId" in envelope ? envelope.tenantId : undefined,
          };
        },
      });
      const inspect = service.action({
        name: "inspect",
        execute: ({ ctx }) => ({
          user: ctx.user,
          session: ctx.session,
          hasCookies: ctx.hasCookies,
          isOwner: ctx.isOwner("internal-user"),
          caller: ctx.caller,
          tenantId: ctx.tenantId,
          traceId: ctx.traceId,
          requestId: ctx.requestId,
        }),
      });
      const envelope = {
        user: { id: "internal-user" },
        caller: "sender",
        tenantId: "tenant-claim",
        traceId: "trace",
        requestId: "request",
      };
      const result =
        dispatch === "direct"
          ? await inspect.run(undefined, envelope)
          : await useService(service, {
              context: {
                user: { id: "options-user" },
                caller: "options-sender",
                tenantId: "options-tenant",
              },
            }).inspect(undefined, envelope);
      expect(result).toEqual({
        user: { id: "internal-user" },
        session: null,
        hasCookies: false,
        isOwner: true,
        caller: "sender",
        tenantId: "tenant-claim",
        traceId: "trace",
        requestId: "request",
      });
    });
  }

  it("preserves all envelope fields without a resolver and drops custom keys", async () => {
    const service = defineService("plain");
    const inspect = service.action({
      name: "inspect",
      execute: ({ ctx }) => ({
        user: ctx.user,
        caller: ctx.caller,
        tenantId: ctx.tenantId,
        traceId: ctx.traceId,
        requestId: ctx.requestId,
        extra: "extra" in ctx,
      }),
    });
    expect(
      await inspect.run(undefined, {
        user: { id: "u" },
        caller: "sender",
        tenantId: "tenant",
        traceId: "trace",
        requestId: "request",
        extra: "ignored",
      }),
    ).toEqual({
      user: { id: "u" },
      caller: "sender",
      tenantId: "tenant",
      traceId: "trace",
      requestId: "request",
      extra: false,
    });
  });
});

describe("generated ids", () => {
  it("never repeat across processes, as a restarted or second worker's would", async () => {
    // Each process makes its first id; a per-process counter gives both the same one.
    const script = `const { brick, defineService } = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)});
const service = defineService("ids");
service.action({ name: "id", execute: ({ ctx }) => ctx.traceId });
const app = brick({ services: [service], requestLogging: false, docs: false });
const response = await app.handle(new Request("http://localhost/api/ids/id", { method: "POST" }));
console.log(response.headers.get("x-trace-id"), await (service.getAction("id") as any).run());`;
    const run = async () => {
      const child = Bun.spawn([process.execPath, "-e", script], {
        stdout: "pipe",
      });
      return (await new Response(child.stdout).text()).trim().split(" ");
    };
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toHaveLength(2);
    for (const id of [...first!, ...second!]) expect(id).toMatch(/^tr_/);
    expect(new Set([...first!, ...second!]).size).toBe(4);
  });
});
