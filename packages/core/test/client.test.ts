import { describe, it, expect } from "bun:test";
import {
  brick,
  defineAction,
  defineService,
  t,
  ActionExecutionError,
  ValidationError,
} from "../src";
import {
  createBrickClient,
  BrickTransportError,
  BrickServerError,
} from "../src/client";

const listPages = defineAction({
  name: "page.list",
  input: t.Object({
    limit: t.Optional(t.Number()),
    sort: t.Optional(t.String()),
  }),
  output: t.Object({
    items: t.Array(t.Object({ id: t.String(), title: t.String() })),
    total: t.Number(),
  }),
  execute: async () => ({ items: [], total: 0 }),
});

const createPage = defineAction({
  name: "page.create",
  input: t.Object({ title: t.String(), content: t.String() }),
  output: t.Object({ id: t.String(), title: t.String() }),
  errors: {
    SLUG_EXISTS: { status: 409, message: "Slug already taken" },
  },
  execute: async ({ input }) => ({ id: "pg_1", title: input.title }),
});

const charge = defineAction({
  name: "charge",
  input: t.Object({ amount: t.Number() }),
  output: t.Object({ ok: t.Boolean() }),
  errors: {
    INSUFFICIENT_FUNDS: { status: 402, message: "Insufficient funds" },
  },
  execute: async () => ({ ok: true }),
});

const contract = {
  page: { list: listPages, create: createPage },
  billing: { charge },
};
type AppServer = typeof contract;

interface Captured {
  url: string;
  init: RequestInit;
}

function mockFetch(
  handler: (captured: Captured) => Response | Promise<Response>,
) {
  const calls: Captured[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const captured = { url: String(url), init: init as RequestInit };
    calls.push(captured);
    return handler(captured);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("createBrickClient (typed HTTP client)", () => {
  it("calls fetch detached, as a browser requires", async () => {
    const api = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000",
      fetch: function (this: unknown) {
        if (this !== undefined && this !== globalThis)
          throw new TypeError("Illegal invocation");
        return Promise.resolve(new Response("ok"));
      } as unknown as typeof fetch,
    });
    // The fake server answers with a string, whatever the contract says.
    expect((await api.billing.charge({ amount: 1 })) as unknown).toBe("ok");
  });

  it("reads plain strings with or without a content type and rejects malformed JSON", async () => {
    for (const contentType of ["text/plain", undefined]) {
      const { fetchImpl } = mockFetch(() => {
        const response = new Response("Echo: local");
        if (contentType) response.headers.set("content-type", contentType);
        else response.headers.delete("content-type");
        return response;
      });
      const api = createBrickClient<AppServer>({
        baseUrl: "http://localhost:4000",
        fetch: fetchImpl,
      });
      expect((await api.billing.charge({ amount: 1 })) as unknown).toBe(
        "Echo: local",
      );
    }
    const api = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000",
      fetch: mockFetch(
        () =>
          new Response("invalid", {
            headers: { "content-type": "application/json" },
          }),
      ).fetchImpl,
    });
    await expect(api.billing.charge({ amount: 1 })).rejects.toBeInstanceOf(
      BrickTransportError,
    );
  });

  it("reads plain-text string actions and still rejects malformed JSON", async () => {
    const echo = defineAction({
      name: "echo",
      input: t.Object({ message: t.String() }),
      output: t.String(),
      execute: async ({ input }) => input.message,
    });
    for (const text of ["Echo: hello", "true", "", '"quoted"']) {
      const api = createBrickClient<{ pages: { echo: typeof echo } }>({
        baseUrl: "http://localhost:4000",
        fetch: async () =>
          new Response(text, {
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
      });
      expect(await api.pages.echo({ message: text })).toBe(text);
    }
    const malformed = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000",
      fetch: async () =>
        new Response("invalid JSON", {
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(malformed.page.list({})).rejects.toBeInstanceOf(
      BrickTransportError,
    );
  });

  it("uses explicit GET route metadata with a query string and typed output", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json({ items: [{ id: "pg_1", title: "Hello" }], total: 1 }),
    );
    const api = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000",
      fetch: fetchImpl,
      contract: {
        page: {
          list: {
            kind: "action",
            name: "list",
            serviceName: "content",
            config: { method: "GET", path: "/api/page" },
          },
        },
      },
    });

    const pages = await api.page.list({ limit: 10, sort: "-createdAt" });

    expect(calls.length).toBe(1);
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.url).toBe(
      "http://localhost:4000/api/page?limit=10&sort=-createdAt",
    );
    expect(pages.total).toBe(1);
    expect(pages.items[0]!.title).toBe("Hello");
  });

  it("uses explicit POST route metadata with a JSON body", async () => {
    const { fetchImpl, calls } = mockFetch(() =>
      json({ id: "pg_2", title: "Hello" }),
    );
    const api = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000/",
      fetch: fetchImpl,
      contract: {
        page: {
          create: {
            kind: "action",
            name: "create",
            serviceName: "content",
            config: { method: "POST", path: "/api/page" },
          },
        },
      },
    });

    const created = await api.page.create({ title: "Hello", content: "World" });

    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://localhost:4000/api/page");
    expect(calls[0]!.init.headers).toMatchObject({
      "content-type": "application/json",
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      title: "Hello",
      content: "World",
    });
    expect(created.id).toBe("pg_2");
  });

  it("maps get/update/delete onto item routes with the id in the path", async () => {
    const seen: string[] = [];
    const { fetchImpl } = mockFetch((c) => {
      seen.push(`${c.init.method} ${c.url}`);
      if (c.init.method === "GET") return json({ id: "pg_1", title: "Hello" });
      if (c.init.method === "PATCH")
        return json({ id: "pg_1", title: "Renamed" });
      return json({ success: true, id: "pg_1" });
    });
    const api = createBrickClient<{
      page: {
        get: typeof listPages;
        update: typeof listPages;
        delete: typeof listPages;
      };
    }>({
      baseUrl: "http://localhost:4000",
      fetch: fetchImpl,
      contract: {
        page: Object.fromEntries(
          ["GET", "PATCH", "DELETE"].map((method, index) => [
            ["get", "update", "delete"][index]!,
            {
              kind: "action",
              name: "item",
              serviceName: "content",
              config: { method, path: "/api/page/:id" },
            },
          ]),
        ),
      },
    });

    await api.page.get({ id: "pg_1" } as any);
    await api.page.update({ id: "pg_1", title: "Renamed" } as any);
    await api.page.delete({ id: "pg_1" } as any);

    expect(seen).toEqual([
      "GET http://localhost:4000/api/page/pg_1",
      "PATCH http://localhost:4000/api/page/pg_1",
      "DELETE http://localhost:4000/api/page/pg_1",
    ]);
  });

  it("sends custom actions to the service/action mesh", async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ ok: true }));
    const api = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000",
      fetch: fetchImpl,
    });

    const result = await api.billing.charge({ amount: 500 });

    expect(result.ok).toBe(true);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://localhost:4000/api/billing/charge");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ amount: 500 });
  });

  it("calls a raw action's custom path where the server mounts it: under the prefix and service", async () => {
    const service = defineService("customRecords");
    const lookup = service.action({
      name: "lookup",
      method: "GET",
      path: "/:id/value",
      input: t.Object({ id: t.String(), field: t.String() }),
      execute: ({ input }) => ({ value: `${input.id}:${input.field}` }),
    });
    const app = brick({ services: [service], prefix: "/v2", docs: false });
    // The server mounts a custom path relative to its service.
    const direct = await app.handle(
      new Request("http://localhost/v2/custom-records/a/value?field=x"),
    );
    expect(await direct.json()).toEqual({ value: "a:x" });
    const contract = { customRecords: { lookup } };
    const api = createBrickClient<typeof contract>({
      baseUrl: "http://localhost",
      prefix: "/v2",
      contract,
      fetch: (input, init) => app.handle(new Request(input, init)),
    });
    expect(await api.customRecords.lookup({ id: "a", field: "x" })).toEqual({
      value: "a:x",
    });
  });

  it("interpolates custom paths without duplicating the prefix or mutating input", async () => {
    const action = defineAction({
      name: "get_value",
      path: "/:doctype/value/:doctype",
      method: "POST",
      input: t.Object({ doctype: t.String(), fields: t.Array(t.String()) }),
      execute: ({ input }) => input.doctype,
    });
    const contract = { records: { get_value: action } };
    const { fetchImpl, calls } = mockFetch(() => json("ok"));
    const api = createBrickClient<typeof contract>({
      baseUrl: "http://localhost:4000",
      prefix: "/v2",
      contract,
      fetch: fetchImpl,
    });
    const input = { doctype: "CRM/Deal #1", fields: ["name"] };
    await api.records.get_value(input);
    expect(calls[0]!.url).toBe(
      "http://localhost:4000/v2/records/CRM%2FDeal%20%231/value/CRM%2FDeal%20%231",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      fields: ["name"],
    });
    expect(input.doctype).toBe("CRM/Deal #1");
    await expect(api.records.get_value({ fields: [] } as any)).rejects.toThrow(
      "Missing path parameter 'doctype'",
    );
    expect(calls).toHaveLength(1);
  });

  it("honors action methods on default paths, including CRUD-like action names", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const action = defineAction({
        name: "get",
        method,
        input: t.Object({ term: t.String() }),
        execute: ({ input }) => input.term,
      });
      const contract = { search: { get: action } };
      const { fetchImpl, calls } = mockFetch(() => json("ok"));
      const api = createBrickClient<typeof contract>({
        baseUrl: "http://localhost:4000",
        contract,
        fetch: fetchImpl,
      });
      await api.search.get({ term: "hello world" });
      const queryOnly = method === "GET" || method === "DELETE";
      expect(calls[0]!.init.method).toBe(method);
      expect(calls[0]!.url).toBe(
        `http://localhost:4000/api/search/get${queryOnly ? "?term=hello+world" : ""}`,
      );
      expect(calls[0]!.init.body).toBe(
        queryOnly ? undefined : JSON.stringify({ term: "hello world" }),
      );
    }
  });

  it("sends remaining custom GET input as query parameters", async () => {
    const action = defineAction({
      name: "lookup",
      path: "/:id",
      method: "GET",
      input: t.Object({ id: t.String(), fields: t.Array(t.String()) }),
      execute: () => "ok",
    });
    const contract = { records: { lookup: action } };
    const { fetchImpl, calls } = mockFetch(() => json("ok"));
    const api = createBrickClient<typeof contract>({
      baseUrl: "http://localhost:4000",
      contract,
      fetch: fetchImpl,
    });
    await api.records.lookup({ id: "a/b", fields: ["name", "title"] });
    expect(calls[0]!.url).toBe(
      "http://localhost:4000/api/records/a%2Fb?fields=name&fields=title",
    );
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("rethrows declared domain failures as ActionExecutionError with code and status", async () => {
    const { fetchImpl } = mockFetch(() =>
      json(
        {
          name: "ActionExecutionError",
          code: "SLUG_EXISTS",
          message: "Slug taken",
          status: 409,
        },
        409,
      ),
    );
    const api = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000",
      fetch: fetchImpl,
    });

    try {
      await api.page.create({ title: "Hello", content: "World" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ActionExecutionError);
      expect((err as ActionExecutionError).code).toBe("SLUG_EXISTS");
      expect((err as ActionExecutionError).status).toBe(409);
    }
  });

  it("rethrows validation failures as ValidationError like local execution", async () => {
    const { fetchImpl } = mockFetch(() =>
      json(
        {
          name: "ValidationError",
          message: "Validation failed",
          status: 400,
          errors: [{ path: "/title", message: "Required" }],
        },
        400,
      ),
    );
    const api = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000",
      fetch: fetchImpl,
    });

    try {
      await api.page.create({ title: "Hello", content: "World" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).errors.length).toBe(1);
    }
  });

  it("distinguishes unexpected server errors, transport failures, and cancellation", async () => {
    const serverErrorApi = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000",
      fetch: mockFetch(() =>
        json(
          { name: "InternalServerError", message: "boom", status: 500 },
          500,
        ),
      ).fetchImpl,
    });
    await expect(serverErrorApi.page.list({ limit: 1 })).rejects.toBeInstanceOf(
      BrickServerError,
    );

    const transportApi = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000",
      fetch: mockFetch(() => {
        throw new TypeError("fetch failed");
      }).fetchImpl,
    });
    const transportFailure = await transportApi.page
      .list({ limit: 1 })
      .catch((err) => err);
    expect(transportFailure).toBeInstanceOf(BrickTransportError);
    expect((transportFailure as BrickTransportError).url).toContain(
      "/api/page",
    );

    const abortApi = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000",
      fetch: (async () => {
        const err = new DOMException(
          "This operation was aborted",
          "AbortError",
        );
        throw err;
      }) as unknown as typeof fetch,
    });
    const aborted = await abortApi.page
      .list({ limit: 1 }, { signal: AbortSignal.abort() })
      .catch((err) => err);
    expect(aborted).toBeInstanceOf(DOMException);
    expect((aborted as DOMException).name).toBe("AbortError");
  });

  it("merges headers, honors prefix/baseUrl normalization, and supports timeouts", async () => {
    const { fetchImpl, calls } = mockFetch(() => json({ ok: true }));
    const api = createBrickClient<AppServer>({
      baseUrl: "http://localhost:4000/",
      prefix: "v1",
      headers: () => ({ authorization: "Bearer tok" }),
      timeoutMs: 1000,
      fetch: fetchImpl,
    });

    await api.billing.charge(
      { amount: 1 },
      { headers: { "x-trace-id": "tr_1" } },
    );

    expect(calls[0]!.url).toBe("http://localhost:4000/v1/billing/charge");
    expect(calls[0]!.init.headers).toMatchObject({
      authorization: "Bearer tok",
      "x-trace-id": "tr_1",
    });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("resolves routes from bound metadata instead of contract keys", async () => {
    const chargeAction = defineAction({
      name: "pay",
      input: t.Object({ amount: t.Number() }),
      output: t.Object({ ok: t.Boolean() }),
      execute: async () => ({ ok: true }),
    });
    defineService("payments").action(chargeAction);
    const runtimeContract = {
      money: { settle: chargeAction },
      posts: {
        list: {
          kind: "action",
          name: "list",
          serviceName: "content",
          config: { method: "GET", path: "/api/article" },
        },
      },
    };
    const { fetchImpl, calls } = mockFetch(() => json({ ok: true }));
    const api = createBrickClient<{
      money: { settle: typeof chargeAction };
      posts: { list: typeof chargeAction };
    }>({
      baseUrl: "http://localhost:4000",
      contract: runtimeContract,
      fetch: fetchImpl,
    });

    await api.money.settle({ amount: 5 });
    expect(calls[0]!.url).toBe("http://localhost:4000/api/payments/pay");

    await api.posts.list({ limit: 3 } as any);
    expect(calls[1]!.init.method).toBe("GET");
    expect(calls[1]!.url).toBe("http://localhost:4000/api/article?limit=3");
  });
});
