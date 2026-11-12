import { beforeEach, expect, it } from "bun:test";
import {
  brick,
  defineService,
  defineTool,
  resetGlobalRegistry,
  t,
} from "../src";
import { createBrickClient } from "../src/client";

beforeEach(resetGlobalRegistry);

function filesApp() {
  const service = defineService("files");
  const upload = service.action({
    name: "upload",
    input: t.Object({
      file: t.File({ maxSize: 16 }),
      attachments: t.Optional(t.Files({ maxSize: 16, maxItems: 4 })),
      folder: t.Optional(t.String()),
      copies: t.Number(),
    }),
    output: t.Object({ text: t.String(), attachments: t.Number() }),
    execute: async ({ input }) => ({
      text: `${input.folder}/${input.file.name}:${await input.file.text()}x${input.copies}`,
      attachments: input.attachments?.length ?? 0,
    }),
  });
  const app = brick({ services: [service], requestLogging: false });
  return { app, upload };
}

it("parses a multipart body into the action's input, coercing form fields", async () => {
  const { app } = filesApp();
  const form = new FormData();
  form.append("file", new File(["hello"], "a.txt"));
  form.append("attachments", new File(["x"], "b.txt"));
  form.append("folder", "docs");
  form.append("copies", "2");
  const response = await app.handle(
    new Request("http://localhost/api/files/upload", {
      method: "POST",
      body: form,
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    text: "docs/a.txt:hellox2",
    attachments: 1,
  });
});

it("refuses a file over maxSize, and a body over the limit before reading it", async () => {
  const { app } = filesApp();
  const form = new FormData();
  form.append("file", new File(["x".repeat(17)], "big.txt"));
  form.append("copies", "1");
  const tooBig = await app.handle(
    new Request("http://localhost/api/files/upload", {
      method: "POST",
      body: form,
    }),
  );
  expect(tooBig.status).toBe(400);

  const declared = await app.handle(
    new Request("http://localhost/api/files/upload", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=x",
        "content-length": String(2 * 1024 * 1024),
      },
      body: "never read",
    }),
  );
  expect(declared.status).toBe(413);
  expect((await declared.json()).code).toBe("PAYLOAD_TOO_LARGE");
});

it("sends FormData from the client when the input holds a file", async () => {
  const { app, upload } = filesApp();
  const bodies: unknown[] = [];
  const api = createBrickClient<{ files: { upload: typeof upload } }>({
    baseUrl: "http://localhost",
    headers: { "Content-Type": "application/json" },
    fetch: (async (url: string, init: RequestInit) => {
      bodies.push(init.body);
      expect(new Headers(init.headers).has("content-type")).toBe(false);
      return app.handle(new Request(url, init));
    }) as unknown as typeof fetch,
  });
  const result = await api.files.upload({
    file: new File(["hi"], "c.txt"),
    attachments: [new File(["1"], "1.txt"), new File(["2"], "2.txt")],
    folder: "inbox",
    copies: 3,
  });
  expect(bodies[0]).toBeInstanceOf(FormData);
  expect(result).toEqual({ text: "inbox/c.txt:hix3", attachments: 2 });
});

it("decodes object and typed array fields sent beside a file", async () => {
  const service = defineService("tagged");
  const tag = service.action({
    name: "tag",
    input: t.Object({
      file: t.File(),
      meta: t.Object({ label: t.String() }),
      sizes: t.Array(t.Number()),
      data: t.Json(),
      note: t.Json(),
    }),
    output: t.Object({
      label: t.String(),
      total: t.Number(),
      data: t.Json(),
      note: t.Json(),
    }),
    execute: async ({ input }) => ({
      label: input.meta.label,
      total: input.sizes.reduce((sum, size) => sum + size, 0),
      data: input.data,
      note: input.note,
    }),
  });
  const app = brick({ services: [service], requestLogging: false });
  const api = createBrickClient<{ tagged: { tag: typeof tag } }>({
    baseUrl: "http://localhost",
    fetch: ((url: string, init: RequestInit) =>
      app.handle(new Request(url, init))) as unknown as typeof fetch,
  });
  expect(
    await api.tagged.tag({
      file: new File(["x"], "x.txt"),
      meta: { label: "inbox" },
      sizes: [1, 2, 3],
      data: { a: [1, null] },
      note: "123",
    }),
  ).toEqual({ label: "inbox", total: 6, data: { a: [1, null] }, note: "123" });
});

it("describes file fields as binary multipart in OpenAPI", () => {
  const { app } = filesApp();
  const body = (app.openApiDocument() as any).paths["/api/files/upload"].post
    .requestBody.content;
  expect(Object.keys(body)).toEqual(["multipart/form-data"]);
  expect(body["multipart/form-data"].schema.properties.file).toMatchObject({
    type: "string",
    format: "binary",
  });
});

it("keeps file input out of MCP: a tool cannot take files", () => {
  expect(() =>
    defineTool({
      name: "upload",
      input: t.Object({ file: t.File() }),
      execute: () => "ok",
    }),
  ).toThrow(/file fields/);
});
