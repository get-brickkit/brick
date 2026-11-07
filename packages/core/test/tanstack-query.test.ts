import { expect, test } from "bun:test";
import {
  MutationObserver,
  QueryClient,
  QueryObserver,
  hashKey,
} from "@tanstack/query-core";
import type { BrickClientAction } from "../src/client";
import { createBrickQueryClient } from "../src/tanstack-query";
import { waitFor } from "./helpers";

function action(
  method: BrickClientAction["config"]["method"],
): BrickClientAction<{ id: string; value?: string }, { id: string }> {
  return {
    kind: "action",
    name: method,
    serviceName: "records",
    config: { method, path: "/custom/:id" },
  };
}
const contract = {
  records: {
    get: action("GET"),
    post: action("POST"),
    put: action("PUT"),
    patch: action("PATCH"),
    delete: action("DELETE"),
  },
};

test("query and mutation options preserve all HTTP methods and encoded routes", async () => {
  const requests: Request[] = [];
  const api = createBrickQueryClient({
    baseUrl: "https://example.test",
    contract,
    fetch: async (url, init) => {
      const request = new Request(url, init);
      requests.push(request);
      return Response.json({ id: "result" });
    },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    for (const name of ["get", "post", "put", "patch", "delete"] as const) {
      const input = { id: "a/b ?", value: "hello" };
      expect(
        await client.ensureQueryData(api.records[name].queryOptions({ input })),
      ).toEqual({ id: "result" });
      const queryRequest = requests.at(-1)!;
      expect(queryRequest.method).toBe(name.toUpperCase());
      expect(queryRequest.url).toContain("/custom/a%2Fb%20%3F");
      if (name === "get" || name === "delete")
        expect(new URL(queryRequest.url).searchParams.get("value")).toBe(
          "hello",
        );
      else expect(await queryRequest.json()).toEqual({ value: "hello" });
      const mutation = new MutationObserver(
        client,
        api.records[name].mutationOptions(),
      );
      expect(await mutation.mutate(input)).toEqual({ id: "result" });
      expect(requests.at(-1)!.method).toBe(name.toUpperCase());
    }
  } finally {
    client.clear();
  }
});

test("keys are stable across object ordering, isolate actions and inputs, and invalidate all action inputs", async () => {
  const api = createBrickQueryClient({
    baseUrl: "https://example.test",
    contract,
    fetch: async () => Response.json({ id: "cached" }),
  });
  const client = new QueryClient();
  try {
    const first = api.records.post.queryOptions({
      input: { id: "1", value: "a" },
    });
    const second = api.records.post.queryOptions({ input: { id: "2" } });
    expect(hashKey(first.queryKey)).toBe(
      hashKey(api.records.post.queryKey({ input: { value: "a", id: "1" } })),
    );
    expect(hashKey(first.queryKey)).not.toBe(hashKey(second.queryKey));
    expect(hashKey(first.queryKey)).not.toBe(
      hashKey(api.records.get.queryKey({ input: { id: "1", value: "a" } })),
    );
    await client.fetchQuery(first);
    await client.prefetchQuery(second);
    expect(client.getQueryData(first.queryKey)).toEqual({ id: "cached" });
    const mutation = new MutationObserver(client, {
      ...api.records.delete.mutationOptions(),
      onSuccess: () =>
        client.invalidateQueries({ queryKey: api.records.post.queryKey() }),
    });
    await mutation.mutate({ id: "1" });
    expect(client.getQueryState(first.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(second.queryKey)?.isInvalidated).toBe(true);
    const observer = new QueryObserver(client, {
      ...first,
      select: (data) => data.id,
      staleTime: Infinity,
    });
    expect(observer.getCurrentResult().data).toBe("cached");
  } finally {
    client.clear();
  }
});

test("QueryClient cancellation reaches fetch and combines per-request cancellation", async () => {
  let received: AbortSignal | null | undefined;
  const api = createBrickQueryClient({
    baseUrl: "https://example.test",
    contract,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        received = init?.signal;
        received?.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        );
      }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const request = new AbortController();
  const options = api.records.post.queryOptions({
    input: { id: "1" },
    request: { signal: request.signal },
  });
  const pending = client.fetchQuery(options).catch((error: unknown) => error);
  await waitFor(() => received !== undefined);
  await client.cancelQueries({ queryKey: options.queryKey });
  await pending;
  expect(received?.aborted).toBe(true);
  client.clear();
});

// Checked by tsconfig.types.json. This function is never run.
export async function checkQueryTypes() {
  const api = createBrickQueryClient({
    baseUrl: "https://example.test",
    contract,
  });
  const client = new QueryClient();
  const options = api.records.post.queryOptions({ input: { id: "1" } });
  const output: { id: string } = await client.ensureQueryData(options);
  const cached: { id: string } | undefined = client.getQueryData(
    options.queryKey,
  );
  const keyed: { id: string } | undefined = client.getQueryData(
    api.records.post.queryKey({ input: { id: "1" } }),
  );
  const mutation = new MutationObserver(
    client,
    api.records.post.mutationOptions(),
  );
  await mutation.mutate({ id: output.id });
  // @ts-expect-error required input
  api.records.post.queryOptions();
  // @ts-expect-error wrong input type
  api.records.post.queryOptions({ input: { id: 123 } });
  // @ts-expect-error wrong mutation variables
  await mutation.mutate({ id: 123 });
  const fetched = await client.fetchQuery(options);
  // @ts-expect-error output is not a number
  const wrong: number = fetched;
  const optional: BrickClientAction<undefined, string> = {
    kind: "action",
    name: "ping",
    serviceName: "health",
    config: { method: "POST", path: "/ping" },
  };
  const optionalApi = createBrickQueryClient({
    baseUrl: "https://example.test",
    contract: { health: { ping: optional } },
  });
  const pong: string = await client.fetchQuery(
    optionalApi.health.ping.queryOptions(),
  );
  return { cached, keyed, wrong, pong };
}

test("request and client signals remain active alongside Query cancellation", async () => {
  for (const useDefault of [false, true]) {
    const controller = new AbortController();
    let received: AbortSignal | null | undefined;
    const api = createBrickQueryClient({
      baseUrl: "https://example.test",
      contract,
      signal: useDefault ? controller.signal : undefined,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          received = init?.signal;
          received?.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
        }),
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    try {
      const pending = client
        .fetchQuery(
          api.records.get.queryOptions({
            input: { id: "1" },
            request: useDefault ? undefined : { signal: controller.signal },
          }),
        )
        .catch((error: unknown) => error);
      await waitFor(() => received !== undefined);
      controller.abort();
      expect(await pending).toBeInstanceOf(DOMException);
      expect(received?.aborted).toBe(true);
    } finally {
      client.clear();
    }
  }
});

test("query signals do not disable request timeouts", async () => {
  let received: AbortSignal | null | undefined;
  const api = createBrickQueryClient({
    baseUrl: "https://example.test",
    contract,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        received = init?.signal;
        received?.addEventListener("abort", () => reject(received?.reason), {
          once: true,
        });
      }),
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  try {
    await client
      .fetchQuery(
        api.records.get.queryOptions({
          input: { id: "1" },
          request: { timeoutMs: 10 },
        }),
      )
      .catch(() => {});
    expect(received?.aborted).toBe(true);
    expect(received?.reason.name).toBe("TimeoutError");
  } finally {
    client.clear();
  }
});

test("clients sharing a cache isolate different contract routes and methods", async () => {
  const client = new QueryClient();
  const routes = [
    { method: "GET", path: "/v1/:id" },
    { method: "GET", path: "/v2/:id" },
    { method: "POST", path: "/v2/:id" },
  ] satisfies BrickClientAction["config"][];
  const apis = routes.map((route) =>
    createBrickQueryClient({
      baseUrl: "https://example.test",
      contract: {
        records: { get: { ...action(route.method), config: route } },
      },
      fetch: async (url, init) =>
        Response.json({
          id: `${init?.method} ${new URL(new Request(url).url).pathname}`,
        }),
    }),
  );
  try {
    const expected = ["GET /v1/1", "GET /v2/1", "POST /v2/1"];
    for (const [index, api] of apis.entries()) {
      expect(
        await client.ensureQueryData(
          api.records.get.queryOptions({ input: { id: "1" } }),
        ),
      ).toEqual({ id: expected[index] });
    }
    expect(
      new Set(apis.map((api) => hashKey(api.records.get.queryKey()))).size,
    ).toBe(3);
    expect(
      new Set(
        apis.map((api) =>
          hashKey(api.records.get.mutationOptions().mutationKey),
        ),
      ).size,
    ).toBe(3);
    await client.invalidateQueries({
      queryKey: apis[0]!.records.get.queryKey(),
    });
    expect(
      client.getQueryState(
        apis[0]!.records.get.queryKey({ input: { id: "1" } }),
      )?.isInvalidated,
    ).toBe(true);
    expect(
      client.getQueryState(
        apis[1]!.records.get.queryKey({ input: { id: "1" } }),
      )?.isInvalidated,
    ).toBe(false);
  } finally {
    client.clear();
  }
});
