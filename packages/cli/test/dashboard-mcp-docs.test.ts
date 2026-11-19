import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_DOCS_CHARS } from "../src/dashboard-mcp-docs";
import { startDevDashboard } from "../src/dev-dashboard";
import { openDocs, type DevDocs } from "../src/dev-docs";
import { DevTelemetryStore } from "../src/dev-telemetry-store";

const token = "0123456789abcdef-secret";
const rpc = (method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

const app = {
  openapi: "3.1.0",
  info: { title: "Orders", version: "1.0.0" },
  servers: [{ url: "http://localhost:4000" }],
  paths: {
    "/api/orders/order": {
      post: {
        operationId: "createOrder",
        summary: "Create an order",
        tags: ["orders"],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NewOrder" },
            },
          },
        },
      },
    },
    "/api/orders/order/{id}": {
      get: {
        operationId: "getOrder",
        summary: "Get an order",
        tags: ["orders"],
        parameters: [{ name: "id", in: "path", required: true }],
      },
    },
  },
  components: {
    schemas: {
      NewOrder: {
        type: "object",
        properties: { address: { $ref: "#/components/schemas/Address" } },
      },
      Address: { type: "object", properties: { city: { type: "string" } } },
      Unused: { type: "object" },
    },
  },
};
const auth = {
  openapi: "3.1.0",
  info: { title: "Auth", version: "1.0.0" },
  paths: { "/auth/sign-in": { post: { operationId: "signIn" } } },
};

const roots: string[] = [];
const open: { stop(): void }[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) item.stop();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function docsFolder(files: Record<string, string>): Promise<DevDocs> {
  const root = await mkdtemp(join(tmpdir(), "brick-mcp-docs-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, content);
  }
  const opened = await openDocs({
    base: root,
    documentation: { dir: "./docs" },
    warn: () => {},
  });
  if (opened.status !== "ready") throw new Error(JSON.stringify(opened));
  open.push({ stop: () => opened.docs.close() });
  return opened.docs;
}

const FILES = {
  "docs/index.mdx":
    "---\ntitle: Welcome\ndescription: Start here\n---\n\n# Welcome\n\nRead the guide.\n",
  "docs/guide/meta.json": JSON.stringify({ title: "Guide", pages: ["setup"] }),
  "docs/guide/setup.mdx":
    "---\ntitle: Setup\ndescription: Install it\n---\n\n## Install\n\nRun `bun add`.\n",
  "docs/big.mdx": `---\ntitle: Big\n---\n\n${"word ".repeat(30_000)}\n`,
};

async function setup(
  options: {
    mode?: "dev" | "production";
    documents?: { title: string; document: Record<string, unknown> }[];
    docs?: DevDocs;
  } = {},
) {
  const store = new DevTelemetryStore();
  store.setApiDocuments(
    options.documents ?? [
      { title: "Orders", document: app },
      { title: "Auth", document: auth },
    ],
    "http://127.0.0.1:4000",
  );
  const production = options.mode === "production";
  const dashboard = await startDevDashboard({
    port: 0,
    store,
    docs: () => options.docs,
    ...(production
      ? { mode: "production" as const, mcp: true, auth: { token } }
      : {}),
  });
  open.push({ stop: () => dashboard.stop() });
  const base = `http://127.0.0.1:${dashboard.port}`;
  const headers = production ? { authorization: `Bearer ${token}` } : {};
  const post = (body: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  return {
    async names() {
      const { result } = await (await post(rpc("tools/list"))).json();
      return result.tools.map(
        (tool: { name: string }) => tool.name,
      ) as string[];
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const { result, error } = await (
        await post(rpc("tools/call", { name, arguments: args }))
      ).json();
      if (error) return { rpcError: error };
      const body: string = result.content[0].text;
      return result.isError
        ? { isError: true as const, text: body }
        : { isError: false as const, text: body, data: JSON.parse(body) };
    },
  };
}

const API_TOOLS = ["get_openapi"];
const DOC_TOOLS = ["list_docs", "read_doc"];
const only = (names: string[], wanted: string[]) =>
  names.filter((name) => wanted.includes(name));

describe("get_openapi, list_docs and read_doc: availability", () => {
  it("are listed under brick dev while their data exists", async () => {
    const docs = await docsFolder(FILES);
    const both = await setup({ docs });
    expect(only(await both.names(), [...API_TOOLS, ...DOC_TOOLS])).toEqual([
      ...API_TOOLS,
      ...DOC_TOOLS,
    ]);
    // No documentation, and no OpenAPI documents.
    const bare = await setup({ documents: [] });
    expect(only(await bare.names(), [...API_TOOLS, ...DOC_TOOLS])).toEqual([]);
    expect(await bare.call("read_doc", { path: "x" })).toMatchObject({
      rpcError: {},
    });
  });

  it("are left out in production, which serves neither", async () => {
    const docs = await docsFolder(FILES);
    const production = await setup({ mode: "production", docs });
    expect(
      only(await production.names(), [...API_TOOLS, ...DOC_TOOLS]),
    ).toEqual([]);
    expect(await production.call("get_openapi")).toMatchObject({
      rpcError: { code: -32602 },
    });
  });
});

describe("get_openapi", () => {
  it("lists a document's operations, the app's own first", async () => {
    const { call } = await setup();
    const { data } = (await call("get_openapi")) as any;
    expect(data.documents).toEqual(["Orders", "Auth"]);
    expect(data.document).toBe("Orders");
    expect(data.info).toEqual({ title: "Orders", version: "1.0.0" });
    expect(data.operations).toEqual([
      {
        method: "POST",
        path: "/api/orders/order",
        operationId: "createOrder",
        summary: "Create an order",
        tags: ["orders"],
      },
      {
        method: "GET",
        path: "/api/orders/order/{id}",
        operationId: "getOrder",
        summary: "Get an order",
        tags: ["orders"],
      },
    ]);
    const other = (await call("get_openapi", { document: "auth" })) as any;
    expect(other.data.operations).toHaveLength(1);
    expect(await call("get_openapi", { document: "none" })).toMatchObject({
      isError: true,
    });
  });

  it("returns one operation, by method and path or by id, with the schemas it points to", async () => {
    const { call } = await setup();
    const byId = (await call("get_openapi", {
      operation: "createOrder",
    })) as any;
    expect(byId.data).toMatchObject({
      document: "Orders",
      method: "POST",
      path: "/api/orders/order",
    });
    expect(byId.data.operation.operationId).toBe("createOrder");
    expect(Object.keys(byId.data.referenced).sort()).toEqual([
      "#/components/schemas/Address",
      "#/components/schemas/NewOrder",
    ]);
    for (const operation of [
      "GET /api/orders/order/{id}",
      "get /api/orders/order/:id",
    ]) {
      const byPath = (await call("get_openapi", { operation })) as any;
      expect(byPath.data.operation.operationId).toBe("getOrder");
    }
    // An operation of another document is found by naming that document.
    expect(
      (
        (await call("get_openapi", {
          operation: "signIn",
          document: "Auth",
        })) as any
      ).data.path,
    ).toBe("/auth/sign-in");
    expect(await call("get_openapi", { operation: "nope" })).toMatchObject({
      isError: true,
    });
  });

  it("keeps an operation that escapes to twice its size under the cap", async () => {
    const { call } = await setup({
      documents: [
        {
          title: "Quoted",
          document: {
            paths: {
              "/api/quoted": {
                post: {
                  operationId: "quoted",
                  description: '"\\'.repeat(120_000),
                },
              },
            },
          },
        },
      ],
    });
    const answer = (await call("get_openapi", { operation: "quoted" })) as any;
    expect(answer.text.length).toBeLessThanOrEqual(MAX_DOCS_CHARS);
    expect(answer.data.note).toContain("Cut to fit");
    expect(answer.data.operation.preview).toContain("more characters");
  });

  it("cuts a big operation, and a long list of operations, and says so", async () => {
    const paths: Record<string, unknown> = {};
    for (let index = 0; index < 400; index++)
      paths[`/api/many/${index}`] = { get: { operationId: `many${index}` } };
    paths["/api/huge"] = {
      post: {
        operationId: "huge",
        description: "d".repeat(200_000),
        requestBody: { schema: { $ref: "#/components/schemas/Big" } },
      },
    };
    const { call } = await setup({
      documents: [
        {
          title: "Big",
          document: {
            paths,
            components: {
              schemas: { Big: { description: "s".repeat(200_000) } },
            },
          },
        },
      ],
    });
    const list = (await call("get_openapi")) as any;
    expect(list.data.operations).toHaveLength(300);
    expect(list.data.note).toContain("101 more operations");

    const huge = (await call("get_openapi", { operation: "huge" })) as any;
    expect(huge.text.length).toBeLessThanOrEqual(MAX_DOCS_CHARS);
    expect(huge.data.note).toContain("Cut to fit");
    expect(huge.data.operation.preview).toContain("more characters");
    expect(huge.data.referenced).toEqual(["#/components/schemas/Big"]);
  });
});

describe("list_docs and read_doc", () => {
  it("list the pages with their titles and descriptions, and read one", async () => {
    const docs = await docsFolder(FILES);
    const { call } = await setup({ docs });
    const { data } = (await call("list_docs")) as any;
    expect(data.pages).toEqual(
      expect.arrayContaining([
        { path: "", title: "Welcome", description: "Start here" },
        {
          path: "guide/setup",
          title: "Setup",
          description: "Install it",
          section: "Guide",
        },
      ]),
    );
    const page = (await call("read_doc", { path: "guide/setup" })) as any;
    expect(page.data).toMatchObject({
      title: "Setup",
      description: "Install it",
      file: "guide/setup.mdx",
    });
    expect(page.data.content).toContain("## Install");
    expect(page.data.content).not.toContain("description: Install it");
    expect(page.data.note).toBeUndefined();

    // The home page, written either way.
    for (const path of ["", "/"])
      expect(((await call("read_doc", { path })) as any).data.title).toBe(
        "Welcome",
      );
    expect(await call("read_doc", { path: "gone" })).toMatchObject({
      isError: true,
    });
    expect(await call("read_doc")).toMatchObject({ isError: true });
  });

  it("cut a long page, and say so", async () => {
    const docs = await docsFolder(FILES);
    const { call } = await setup({ docs });
    const page = (await call("read_doc", { path: "big" })) as any;
    expect(page.data.content.length).toBeLessThan(MAX_DOCS_CHARS + 100);
    expect(page.data.content).toContain("more characters");
    expect(page.data.note).toContain("was cut to");
  });
});
