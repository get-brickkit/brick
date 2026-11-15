import { afterAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brick,
  definePlugin,
  defineSecret,
  defineService,
  defineStorage,
  memory,
  resetGlobalRegistry,
  s3,
  t,
  useService,
  type FileStorage,
} from "../src";
import { LOCAL_FILES_ROUTE, signFileLink } from "../src/file-storage";
import { serviceStorage } from "../src/storage";

const root = mkdtempSync(join(tmpdir(), "brick-files-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;
const localFiles = () =>
  defineStorage({
    driver: s3({ prefix: "files/", local: join(root, `store-${++dirs}`) }),
  });

beforeEach(resetGlobalRegistry);

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const as = (user?: string, org?: string) => ({
  ...(user && { "x-user": user }),
  ...(org && { "x-org": org }),
});

function crm(files: FileStorage, extra: Record<string, unknown> = {}) {
  const service = defineService("crm", {
    deps: { files, ...extra },
    context: ({ request }) => ({
      user: request.headers.get("x-user"),
      org: request.headers.get("x-org") ?? undefined,
    }),
    identity: (ctx) => (ctx.user ? { id: ctx.user, tenant: ctx.org } : null),
  });
  const attach = service.action({
    name: "attach",
    input: t.Object({
      file: t.File({ maxSize: 16, accept: ["application/pdf", "image/*"] }),
    }),
    output: t.Object({ id: t.String(), contentType: t.String() }),
    execute: async ({ input, ctx }) => {
      const stored = await ctx.deps.files.put(input.file);
      return { id: stored.id, contentType: stored.contentType };
    },
  });
  const link = service.action({
    name: "link",
    input: t.Object({ id: t.String() }),
    output: t.Object({ url: t.String() }),
    execute: async ({ input, ctx }) => ({
      url: await ctx.deps.files.url(input.id, { download: "report é.pdf" }),
    }),
  });
  const read = service.action({
    name: "read",
    input: t.Object({ id: t.String() }),
    output: t.Object({ text: t.Union([t.String(), t.Null()]) }),
    execute: async ({ input, ctx }) => ({
      text: (await (await ctx.deps.files.get(input.id))?.text()) ?? null,
    }),
  });
  const remove = service.action({
    name: "remove",
    input: t.Object({ id: t.String() }),
    execute: ({ input, ctx }) => ctx.deps.files.delete(input.id),
  });
  return { service, attach, link, read, remove };
}

const upload = (
  app: { handle(r: Request): Promise<Response> },
  file: File,
  headers = as("u1", "acme"),
) => {
  const form = new FormData();
  form.append("file", file);
  return app.handle(
    new Request("http://localhost/api/crm/attach", {
      method: "POST",
      body: form,
      headers,
    }),
  );
};
const json = (
  app: { handle(r: Request): Promise<Response> },
  path: string,
  body: unknown,
  headers = as("u1", "acme"),
) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
const text = async (response: Response) =>
  ((await response.json()) as any).text;
const linkOf = async (response: Response) =>
  ((await response.json()) as any).url as string;
const thrown = (call: Promise<unknown>) =>
  call.then(
    () => "did not throw",
    (error) => String(error?.cause?.message ?? error?.message),
  );
const open = (app: { handle(r: Request): Promise<Response> }, link: string) =>
  app.handle(new Request(`http://localhost${link}`));
const pdf = (text = "%PDF") =>
  new File([text], "a.pdf", { type: "application/pdf" });

describe("file storage", () => {
  it("puts, links, reads and deletes a file over HTTP, in local mode", async () => {
    const { service } = crm(localFiles());
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    const put = await upload(app, pdf("hello"));
    expect(put.status).toBe(200);
    const { id, contentType } = (await put.json()) as {
      id: string;
      contentType: string;
    };
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(contentType).toBe("application/pdf");
    expect(await text(await json(app, "/api/crm/read", { id }))).toBe("hello");

    const link = await linkOf(await json(app, "/api/crm/link", { id }));
    expect(link.startsWith(`${LOCAL_FILES_ROUTE}?token=`)).toBe(true);
    const served = await open(app, link);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("hello");
    expect(served.headers.get("content-type")).toBe("application/pdf");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-disposition")).toBe(
      `attachment; filename="report _.pdf"; filename*=UTF-8''report%20%C3%A9.pdf`,
    );

    await json(app, "/api/crm/remove", { id });
    expect(await text(await json(app, "/api/crm/read", { id }))).toBeNull();
    expect((await open(app, link)).status).toBe(404);
  });

  it("keeps the key under the prefix and a digest of the tenant, on disk", async () => {
    const files = localFiles();
    const { id } = await files.in("org/1").put(new Blob(["x"]));
    const dir = join(root, `store-${dirs}`);
    expect(existsSync(join(dir, "files", digest("org/1"), id))).toBe(true);
  });

  it("keeps tenants apart on disk when they differ only by case, end in a dot, or are long", async () => {
    const files = localFiles();
    const { id } = await files.in("Acme").put(new Blob(["upper"]));
    const lower = files.in("acme");
    expect(await lower.get(id)).toBeUndefined();
    await lower.delete(id);
    expect(await (await files.in("Acme").get(id))?.text()).toBe("upper");

    const dotted = await files.in("globex.").put(new Blob(["dot"]));
    expect(await files.in("globex").get(dotted.id)).toBeUndefined();
    expect(await (await files.in("globex.").get(dotted.id))?.text()).toBe(
      "dot",
    );

    const long = "t".repeat(300);
    const stored = await files.in(long).put(new Blob(["long"]));
    expect(await (await files.in(long).get(stored.id))?.text()).toBe("long");

    for (const tenant of ["\ud800", "a\ud801"])
      await expect(
        (async () => files.in(tenant).put(new Blob(["x"])))(),
      ).rejects.toThrow("well-formed");
  });

  it("returns the content type it stored, normalised", async () => {
    const acme = localFiles().in("acme");
    const stored = await acme.put(new Blob(["x"]), {
      contentType: "Image/PNG",
    });
    expect(stored.contentType).toBe("image/png");
    expect((await acme.get(stored.id))?.type).toBe(stored.contentType);
  });

  it("refuses a link valid for more than 7 days", async () => {
    const acme = localFiles().in("acme");
    const { id } = await acme.put(new Blob(["x"]));
    await expect(
      acme.url(id, { expiresInMs: 7 * 24 * 3600_000 + 1 }),
    ).rejects.toThrow("at most 7 days");
    await expect(acme.url(id, { expiresInMs: 2 ** 53 - 1 })).rejects.toThrow(
      "at most 7 days",
    );
    expect(await acme.url(id, { expiresInMs: 7 * 24 * 3600_000 })).toContain(
      LOCAL_FILES_ROUTE,
    );
  });

  it("never reaches another tenant's file: get, delete and url resolve in the caller's tenant", async () => {
    const files = localFiles();
    const { service } = crm(files);
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    const { id } = await files.in("acme").put(new Blob(["secret"]));
    const other = as("u2", "globex");
    expect(
      await text(await json(app, "/api/crm/read", { id }, other)),
    ).toBeNull();
    const link = await linkOf(await json(app, "/api/crm/link", { id }, other));
    expect((await open(app, link)).status).toBe(404);
    await json(app, "/api/crm/remove", { id }, other);
    expect(await (await files.in("acme").get(id))?.text()).toBe("secret");
    expect(await files.in("globex").get(id)).toBeUndefined();
  });

  it("refuses ids that are not UUIDs, or resolves them to nothing", async () => {
    const files = localFiles();
    const acme = files.in("acme");
    const { id } = await acme.put(new Blob(["x"]));
    const globex = files.in("globex");
    for (const bad of [
      "../x",
      `../acme/${id}`,
      `..%2Facme%2F${id}`,
      `acme/${id}`,
      `https://bucket.s3.amazonaws.com/files/acme/${id}`,
      "",
      id.toUpperCase().replace(/./, "/"),
    ]) {
      expect(await globex.get(bad)).toBeUndefined();
      await globex.delete(bad);
      await expect(globex.url(bad)).rejects.toThrow("is not a file id");
    }
    expect(await acme.get(id)).toBeDefined();
  });

  it("throws without a tenant: anonymous, an identity without one, a direct call to a service without identity", async () => {
    const { read, service } = crm(localFiles());
    const id = crypto.randomUUID();
    const ctx = (headers: Record<string, string>) => ({
      request: new Request("http://localhost", { headers }),
    });
    expect(
      await thrown(read.execute({ input: { id }, ctx: ctx(as()) })),
    ).toContain("this call has no tenant");
    expect(
      await thrown(read.execute({ input: { id }, ctx: ctx(as("u1")) })),
    ).toContain("this call has no tenant");
    expect(
      await read.execute({ input: { id }, ctx: ctx(as("u1", "acme")) }),
    ).toEqual({
      text: null,
    });
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    const refused = await json(app, "/api/crm/read", { id }, as("u1"));
    expect(refused.status).toBe(500);
    expect(await refused.text()).not.toContain("this call has no tenant");

    const plain = defineService("plain", { deps: { files: localFiles() } });
    const get = plain.action({
      name: "get",
      execute: ({ ctx }) => ctx.deps.files.get(id),
    });
    expect(await thrown(get.execute({}))).toContain("this call has no tenant");
  });

  it("scopes files in a same-service action a context hook calls, over HTTP as in process", async () => {
    const seen: string[] = [];
    let inHook = false;
    const service = defineService("hooked", {
      deps: { files: localFiles() },
      context: async (ctx) => {
        if (!inHook) {
          inHook = true;
          seen.push(
            await (nested as any).execute({ input: {}, ctx }).then(
              () => "ok",
              (error: Error) => error.message,
            ),
          );
          inHook = false;
        }
        return { user: ctx.request.headers.get("x-user") };
      },
      identity: (ctx) => (ctx.user ? { id: ctx.user, tenant: "acme" } : null),
    });
    const nested = service.action({
      name: "nested",
      execute: ({ ctx }) => ctx.deps.files.get(crypto.randomUUID()),
    });
    service.action({ name: "outer", execute: () => "done" });
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    await json(app, "/api/hooked/outer", {});
    expect(seen).toEqual(["ok"]);
  });

  it("fails at startup when a service holds a file storage but has no identity hook", () => {
    const plain = defineService("plain", { deps: { uploads: localFiles() } });
    expect(() => brick({ services: [plain], requestLogging: false })).toThrow(
      'Service "plain" has file storage "uploads" in its deps or a plugin\'s but no identity hook',
    );
  });

  it("checks the file storages of the plugins installed on a service, and scopes them per call", async () => {
    const attachments = definePlugin({
      name: "@acme/attachments",
      deps: { uploads: {} as FileStorage },
      service: ({ service }) => {
        service.action({
          name: "keep",
          input: t.Object({ text: t.String() }),
          output: t.Object({ id: t.String(), hasIn: t.Boolean() }),
          execute: async ({ input, ctx }) => ({
            id: (await ctx.deps.uploads.put(new Blob([input.text]))).id,
            hasIn: "in" in ctx.deps.uploads,
          }),
        });
      },
    });
    const uploads = localFiles();
    const plain = defineService("plain");
    plain.use(attachments({}, { deps: { uploads } }));
    expect(() => brick({ services: [plain], requestLogging: false })).toThrow(
      'Service "plain" has file storage "uploads" in its deps or a plugin\'s but no identity hook',
    );

    resetGlobalRegistry();
    const { service } = crm(localFiles());
    service.use(attachments({}, { deps: { uploads } }));
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    const kept = (await (
      await json(app, "/api/crm/keep", { text: "mine" })
    ).json()) as { id: string; hasIn: boolean };
    expect(kept.hasIn).toBe(false);
    expect(await (await uploads.in("acme").get(kept.id))?.text()).toBe("mine");
    expect(await uploads.in("globex").get(kept.id)).toBeUndefined();
  });

  it("never runs identity for a call that does not touch files", async () => {
    let runs = 0;
    const service = defineService("lazyid", {
      deps: { files: localFiles() },
      identity: () => {
        runs++;
        return { id: "u", tenant: "acme" };
      },
    });
    const ping = service.action({ name: "ping", execute: () => "ok" });
    service.action({
      name: "touch",
      execute: async ({ ctx }) => {
        await ctx.deps.files.get(crypto.randomUUID());
        return "ok";
      },
    });
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    expect((await json(app, "/api/lazyid/ping", {})).status).toBe(200);
    expect(await ping.execute({})).toBe("ok");
    expect(runs).toBe(0);
    expect((await json(app, "/api/lazyid/touch", {})).status).toBe(200);
    expect(runs).toBe(1);
  });

  it("does not offer in() on the call's view: naming a tenant takes the imported handle", async () => {
    const { service } = crm(localFiles());
    service.action({
      name: "hasIn",
      output: t.Array(t.Boolean()),
      execute: async ({ ctx }) => [
        "in" in ctx.deps.files,
        typeof (ctx.deps.files as any).in === "function",
      ],
    });
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    expect(await (await json(app, "/api/crm/has-in", {})).json()).toEqual([
      false,
      false,
    ]);
  });

  it("names the tenant outside a request, and refuses an empty one", async () => {
    const files = localFiles();
    for (const bad of ["", ".", ".."])
      expect(() => files.in(bad)).toThrow(
        "the tenant must be a non-empty, well-formed string",
      );
    expect(() => files.in(undefined as any)).toThrow("the tenant must be");
    await expect(files.get(crypto.randomUUID())).rejects.toThrow(
      "files.in(tenantId)",
    );
    await expect(files.put(new Blob(["x"]))).rejects.toThrow(
      "files.in(tenantId)",
    );
  });

  it("does not take the per-call view for an override when ctx is handed to another service", async () => {
    const billing = defineService("billing", { deps: { carrier: "billing" } });
    const book = billing.action({
      name: "book",
      output: t.String(),
      execute: ({ ctx }) => `${ctx.deps.carrier} ${Object.keys(ctx.deps)}`,
    });
    const { service } = crm(localFiles(), { carrier: "crm" });
    service.action({
      name: "handOff",
      output: t.Array(t.String()),
      execute: async ({ ctx }: { ctx: any }) => [
        await useService(billing).book({}, ctx),
        await book.execute({ ctx }),
        await book.execute({ ctx: { ...ctx } }),
      ],
    });
    const app = brick({
      services: [billing, service],
      requestLogging: false,
      docs: false,
    });
    const seen = await (await json(app, "/api/crm/hand-off", {})).json();
    expect(seen).toEqual(Array(3).fill("billing carrier"));
  });

  it("keeps the view when a call passes its ctx on within the service", async () => {
    const files = localFiles();
    const { service, read } = crm(files);
    const { id } = await files.in("acme").put(new Blob(["mine"]));
    service.action({
      name: "nested",
      output: t.Any(),
      execute: ({ ctx }) => read.execute({ input: { id }, ctx }),
    });
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    expect(await text(await json(app, "/api/crm/nested", {}))).toBe("mine");
  });

  it("hands a nested call within the service the caller's own ctx, so its changes reach the caller", async () => {
    const { service } = crm(localFiles());
    const mark = service.action({
      name: "mark",
      execute: async ({ ctx }: { ctx: any }) => {
        ctx.marked = "by nested";
      },
    });
    service.action({
      name: "outer",
      output: t.Any(),
      execute: async ({ ctx }: { ctx: any }) => {
        await mark.execute({ ctx });
        return { marked: ctx.marked ?? null };
      },
    });
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    expect(await (await json(app, "/api/crm/outer", {})).json()).toEqual({
      marked: "by nested",
    });
  });

  it("uses a test's fake in ctx.deps as given", async () => {
    const { read } = crm(localFiles());
    const fake = {
      get: async () => new Blob(["fake"]),
    } as unknown as FileStorage;
    expect(
      await read.execute({
        input: { id: "anything" },
        ctx: { deps: { files: fake } },
      }),
    ).toEqual({ text: "fake" });
  });

  it("refuses a file whose type is not accepted, or over maxSize, before execute", async () => {
    let runs = 0;
    const { service } = crm(localFiles());
    service.action({
      name: "count",
      input: t.Object({ file: t.Files({ accept: ["image/*"], maxItems: 2 }) }),
      execute: () => {
        runs++;
      },
    });
    const app = brick({
      services: [service],
      requestLogging: false,
      docs: false,
    });
    for (const file of [
      new File(["x"], "a.html", { type: "text/html" }),
      new File(["x"], "a", { type: "image" }),
      new File(["x"], "a.bin"),
      new File(["x".repeat(17)], "big.pdf", { type: "application/pdf" }),
    ]) {
      const response = await upload(app, file);
      expect(response.status).toBe(400);
      expect(((await response.json()) as any).code).toBe("VALIDATION_FAILED");
    }
    for (const file of [
      new File(["x"], "photo", { type: "image/png" }),
      new Blob(["x"], { type: "image/png" }) as File,
      new File(["x"], "a.html", { type: "image/png" }),
    ])
      expect((await upload(app, file)).status).toBe(400);
    const named = await upload(
      app,
      new File(["x"], "a.pdf", { type: "text/html" }),
    );
    expect(named.status).toBe(200);
    expect(((await named.json()) as any).contentType).toBe("application/pdf");
    for (const [accept, file] of [
      [["IMAGE/*"], new File(["x"], "a.png", { type: "image/png" })],
      [["*/*"], new File(["x"], "a.bin")],
      [["text/plain"], new File(["x"], "a.txt", { type: "text/plain" })],
    ] as const) {
      resetGlobalRegistry();
      const one = defineService("one");
      one.action({
        name: "take",
        input: t.Object({ file: t.File({ accept: [...accept] }) }),
        output: t.String(),
        execute: ({ input }) => input.file.type,
      });
      const form = new FormData();
      form.append("file", file);
      const response = await brick({
        services: [one],
        requestLogging: false,
        docs: false,
      }).handle(
        new Request("http://localhost/api/one/take", {
          method: "POST",
          body: form,
        }),
      );
      expect(response.status).toBe(200);
    }
    const form = new FormData();
    form.append("file", new File(["x"], "a.txt", { type: "text/plain" }));
    const many = await app.handle(
      new Request("http://localhost/api/crm/count", {
        method: "POST",
        body: form,
      }),
    );
    expect(many.status).toBe(400);
    expect(runs).toBe(0);
  });
});

describe("the local files route", () => {
  function app() {
    const files = localFiles();
    const { service } = crm(files);
    const dir = join(root, `store-${dirs}`);
    return {
      files,
      dir,
      app: brick({ services: [service], requestLogging: false, docs: false }),
    };
  }
  const tokenOf = (link: string) =>
    new URL(link, "http://localhost").searchParams.get("token")!;

  it("refuses an expired, tampered or foreign token", async () => {
    const { files, dir, app: served } = app();
    const acme = files.in("acme");
    const { id } = await acme.put(new Blob(["x"]));
    const key = `files/${digest("acme")}/${id}`;
    const d = digest(dir);
    const route = (token: string) =>
      open(served, `${LOCAL_FILES_ROUTE}?token=${token}`);
    expect(
      (
        await route(
          signFileLink({
            dirDigest: d,
            key,
            expiresAt: Date.now() + 60_000,
            disposition: "attachment",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await route(
          signFileLink({
            dirDigest: d,
            key,
            expiresAt: Date.now() - 1,
            disposition: "attachment",
          }),
        )
      ).status,
    ).toBe(403);

    const token = tokenOf(await acme.url(id));
    const [payload, mac] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(JSON.stringify(claims)).not.toContain(root);
    expect(claims.dirDigest).toBe(d);
    const forged = Buffer.from(
      JSON.stringify({ ...claims, key: "files/globex/x" }),
    ).toString("base64url");
    expect((await route(`${forged}.${mac}`)).status).toBe(403);
    expect((await route(`${payload}.${mac!.slice(0, -2)}AA`)).status).toBe(403);
    expect((await route("")).status).toBe(403);
    for (const other of [root, dir, digest(root)])
      expect(
        (await route(signFileLink({ ...claims, dirDigest: other }))).status,
      ).toBe(403);
  });

  it("verifies a link signed by another copy of the module", async () => {
    const copy = "../src/file-storage?another-copy";
    const other: typeof import("../src/file-storage") = await import(copy);
    expect(other.signFileLink).not.toBe(signFileLink);
    const token = signFileLink({
      dirDigest: digest("/some/dir"),
      key: "files/x",
      expiresAt: Date.now() + 60_000,
      disposition: "attachment",
    });
    const route = other.localFilesRoute(new Set(["/some/dir"]));
    const response = await route({
      request: new Request(
        `http://localhost${LOCAL_FILES_ROUTE}?token=${token}`,
      ),
    });
    expect(response.status).toBe(404);
  });

  it("serves nothing outside the directory: no `..`, no symlink", async () => {
    const { dir, app: served } = app();
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "backup");
    writeFileSync(`${outside}.type`, "text/plain");
    await defineStorage({ driver: s3({ local: dir }) })
      .in("acme")
      .put(new Blob(["x"]));
    symlinkSync(outside, join(dir, digest("acme"), "link"));
    writeFileSync(join(dir, digest("acme"), "link.type"), "text/plain");
    for (const key of [
      "../outside.txt",
      "acme/../../outside.txt",
      `${digest("acme")}/link`,
    ]) {
      const token = signFileLink({
        dirDigest: digest(dir),
        key,
        expiresAt: Date.now() + 60_000,
        disposition: "attachment",
      });
      const response = await open(
        served,
        `${LOCAL_FILES_ROUTE}?token=${token}`,
      );
      expect(response.status).toBe(404);
    }
  });

  it("follows no symlinked folder: put refuses, delete and get see nothing, a linked .type is not served", async () => {
    const { files, dir, app: served } = app();
    const prefix = join(dir, "files");
    mkdirSync(prefix, { recursive: true });
    const elsewhere = join(root, `elsewhere-${dirs}`);
    mkdirSync(elsewhere);
    const id = crypto.randomUUID();
    writeFileSync(join(elsewhere, id), "outside");
    writeFileSync(join(elsewhere, `${id}.type`), "text/plain");
    symlinkSync(elsewhere, join(prefix, digest("mallory")));
    const mallory = files.in("mallory");
    await expect(mallory.put(new Blob(["x"]))).rejects.toThrow(
      "not inside the local directory",
    );
    expect(await mallory.get(id)).toBeUndefined();
    await mallory.delete(id);
    expect(readFileSync(join(elsewhere, id), "utf8")).toBe("outside");

    const { id: secret } = await files.in("acme").put(new Blob(["acme"]));
    symlinkSync(join(prefix, digest("acme")), join(prefix, digest("evil")));
    const evil = files.in("evil");
    expect(await evil.get(secret)).toBeUndefined();
    expect((await open(served, await evil.url(secret))).status).toBe(404);
    await evil.delete(secret);
    expect(await (await files.in("acme").get(secret))?.text()).toBe("acme");

    const acme = files.in("acme");
    const { id: typed } = await acme.put(new Blob(["x"]));
    const side = join(prefix, digest("acme"), `${typed}.type`);
    rmSync(side);
    symlinkSync(join(elsewhere, `${id}.type`), side);
    expect(await acme.get(typed)).toBeUndefined();
    expect((await open(served, await acme.url(typed))).status).toBe(404);
  });

  it("is mounted only for an app with a file storage in local mode", async () => {
    const plain = defineService("plain");
    plain.action({ name: "ping", execute: () => "ok" });
    const without = brick({
      services: [plain],
      requestLogging: false,
      docs: false,
    });
    expect((await open(without, LOCAL_FILES_ROUTE)).status).toBe(404);
    expect((await open(app().app, LOCAL_FILES_ROUTE)).status).toBe(403);
  });

  it("warns once when local mode runs in production", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const files = localFiles();
      for (let i = 0; i < 2; i++) {
        resetGlobalRegistry();
        brick({
          services: [crm(files).service],
          requestLogging: false,
          docs: false,
        });
      }
      expect(
        warn.mock.calls.filter(([line]) =>
          String(line).includes("NODE_ENV is production"),
        ),
      ).toHaveLength(1);
    } finally {
      process.env.NODE_ENV = env;
      warn.mockRestore();
    }
  });
});

function fakeS3(status?: number) {
  const objects = new Map<string, { body: ArrayBuffer; type: string }>();
  const requests: { method: string; path: string }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = decodeURIComponent(new URL(request.url).pathname);
      requests.push({ method: request.method, path });
      if (status) return new Response("<Error/>", { status });
      if (request.method === "PUT") {
        objects.set(path, {
          body: await request.arrayBuffer(),
          type: request.headers.get("content-type") ?? "",
        });
        return new Response(null, { status: 200 });
      }
      if (request.method === "DELETE") {
        objects.delete(path);
        return new Response(null, { status: 204 });
      }
      const object = objects.get(path);
      return object
        ? new Response(object.body, {
            headers: { "content-type": object.type },
          })
        : new Response("<Error><Code>NoSuchKey</Code></Error>", {
            status: 404,
          });
    },
  });
  return { server, requests, endpoint: `http://localhost:${server.port}` };
}

describe("the s3 driver, against a local stand-in", () => {
  it("connects and reads credentials only on the first call", async () => {
    const fake = fakeS3();
    try {
      let reads = 0;
      const secret = defineSecret("BRICK_TEST_S3_SECRET", {
        default: "SK",
      }).validate(() => {
        reads++;
      });
      const dir = join(root, "never-created");
      const files = defineStorage({
        driver: s3({
          bucket: "b",
          endpoint: fake.endpoint,
          accessKeyId: "AK",
          secretAccessKey: secret,
        }),
      });
      defineStorage({ driver: s3({ local: dir }) });
      const service = defineService("lazy", {
        deps: { files },
        identity: () => ({ id: "u", tenant: "acme" }),
      });
      void service;
      expect(fake.requests).toHaveLength(0);
      expect(existsSync(dir)).toBe(false);
      expect(reads).toBe(0);
      expect(await files.in("acme").get(crypto.randomUUID())).toBeUndefined();
      expect(reads).toBe(1);
      expect(fake.requests).toHaveLength(1);
    } finally {
      fake.server.stop(true);
    }
  });

  it("puts under the prefix and tenant, reads, deletes, and presigns a download", async () => {
    const fake = fakeS3();
    try {
      const files = defineStorage({
        driver: s3({
          bucket: "crm-uploads",
          prefix: "files/",
          endpoint: fake.endpoint,
          region: "us-east-1",
          accessKeyId: defineSecret("BRICK_TEST_S3_KEY", { default: "AK" }),
          secretAccessKey: "SK",
        }),
      });
      const acme = files.in("acme corp");
      const stored = await acme.put(
        new File(["%PDF"], "a.pdf", { type: "application/pdf" }),
      );
      const key = `/crm-uploads/files/acme%20corp/${stored.id}`;
      expect(fake.requests).toEqual([{ method: "PUT", path: key }]);
      const blob = await acme.get(stored.id);
      expect(await blob?.text()).toBe("%PDF");
      expect(blob?.type).toBe("application/pdf");
      expect(await files.in("globex").get(stored.id)).toBeUndefined();

      const url = new URL(await acme.url(stored.id, { download: "Q3.pdf" }));
      expect(url.origin).toBe(fake.endpoint);
      expect(decodeURIComponent(url.pathname)).toBe(key);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
      expect(url.searchParams.get("X-Amz-Credential")?.startsWith("AK/")).toBe(
        true,
      );
      expect(url.searchParams.get("response-content-disposition")).toBe(
        `attachment; filename="Q3.pdf"; filename*=UTF-8''Q3.pdf`,
      );
      const short = new URL(await acme.url(stored.id, { expiresInMs: 10_000 }));
      expect(short.searchParams.get("X-Amz-Expires")).toBe("10");
      expect(short.searchParams.get("response-content-disposition")).toBe(
        "attachment",
      );

      await acme.delete(stored.id);
      expect(fake.requests.at(-1)).toEqual({ method: "DELETE", path: key });
      expect(await acme.get(stored.id)).toBeUndefined();
    } finally {
      fake.server.stop(true);
    }
  });

  it("throws on a 403 reading a file, instead of answering undefined", async () => {
    const fake = fakeS3(403);
    try {
      const files = defineStorage({
        driver: s3({
          bucket: "b",
          endpoint: fake.endpoint,
          accessKeyId: "AK",
          secretAccessKey: "SK",
        }),
      });
      await expect(files.in("acme").get(crypto.randomUUID())).rejects.toThrow(
        "S3 answered 403",
      );
    } finally {
      fake.server.stop(true);
    }
  });

  it("gives up on a read that stops moving, and not on a slow one that keeps moving", async () => {
    const pause = 30;
    const body = (chunks: number, thenStall: boolean) =>
      new ReadableStream({
        async start(controller) {
          for (let i = 0; i < chunks; i++) {
            controller.enqueue(new Uint8Array([i]));
            await Bun.sleep(pause);
          }
          if (!thenStall) controller.close();
        },
      });
    const server = Bun.serve({
      port: 0,
      fetch: (request) =>
        new Response(body(5, new URL(request.url).pathname.includes("stall")), {
          headers: { "content-type": "application/octet-stream" },
        }),
    });
    const realSetTimeout = globalThis.setTimeout;
    const shortIdle = spyOn(globalThis, "setTimeout").mockImplementation(((
      run: () => void,
      ms?: number,
    ) => realSetTimeout(run, ms === 30_000 ? pause * 3 : ms)) as any);
    try {
      const reading = (prefix: string) =>
        defineStorage({
          driver: s3({
            bucket: "b",
            prefix,
            endpoint: `http://localhost:${server.port}`,
            accessKeyId: "AK",
            secretAccessKey: "SK",
          }),
        })
          .in("acme")
          .get(crypto.randomUUID());
      const slow = await reading("moving/");
      expect(new Uint8Array(await slow!.arrayBuffer())).toEqual(
        new Uint8Array([0, 1, 2, 3, 4]),
      );
      expect(slow!.type).toBe("application/octet-stream");
      await expect(reading("stall/")).rejects.toThrow(
        "S3 failed reading a file",
      );
    } finally {
      shortIdle.mockRestore();
      server.stop(true);
    }
  });

  it("keeps a signed URL out of the error when S3 cannot be reached", async () => {
    const fake = fakeS3();
    fake.server.stop(true);
    const acme = defineStorage({
      driver: s3({
        bucket: "b",
        endpoint: fake.endpoint,
        accessKeyId: "AK",
        secretAccessKey: "SK",
      }),
    }).in("acme");
    for (const [operation, call] of [
      ["reading", () => acme.get(crypto.randomUUID())],
      ["writing", () => acme.put(new Blob(["x"]))],
      ["deleting", () => acme.delete(crypto.randomUUID())],
    ] as const) {
      const error = await call().then(
        () => undefined,
        (error: Error) => error,
      );
      expect(error?.message).toContain(`S3 failed ${operation} a file`);
      for (const leak of ["X-Amz-Signature", "localhost", "acme"])
        expect(
          `${error?.message} ${error?.stack} ${error?.cause}`,
        ).not.toContain(leak);
    }
  });

  it("refuses to run without a bucket: at startup, or at first use of a handle on its own", async () => {
    const env = {
      S3_BUCKET: process.env.S3_BUCKET,
      AWS_BUCKET: process.env.AWS_BUCKET,
    };
    delete process.env.S3_BUCKET;
    delete process.env.AWS_BUCKET;
    try {
      const options = {
        prefix: "files/",
        endpoint: "http://localhost:1",
        accessKeyId: "AK",
        secretAccessKey: "SK",
      };
      const files = defineStorage({ driver: s3(options) });
      await expect(
        files.in("crm-backups").get(crypto.randomUUID()),
      ).rejects.toThrow("s3(): no bucket");
      await expect(files.in("acme").url(crypto.randomUUID())).rejects.toThrow(
        "s3(): no bucket",
      );
      const { service } = crm(files);
      expect(() =>
        brick({ services: [service], requestLogging: false, docs: false }),
      ).toThrow("s3(): no bucket");

      process.env.S3_BUCKET = "from-env";
      resetGlobalRegistry();
      const fromEnv = defineStorage({ driver: s3(options) });
      brick({
        services: [crm(fromEnv).service],
        requestLogging: false,
        docs: false,
      });
      expect(
        new URL(await fromEnv.in("acme").url(crypto.randomUUID())).pathname,
      ).toStartWith("/from-env/files/acme/");
    } finally {
      for (const [name, value] of Object.entries(env))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
  });

  it("refuses a link valid for more than 7 days", async () => {
    const files = defineStorage({
      driver: s3({
        bucket: "b",
        endpoint: "http://localhost:1",
        accessKeyId: "AK",
        secretAccessKey: "SK",
      }),
    });
    await expect(
      files
        .in("acme")
        .url(crypto.randomUUID(), { expiresInMs: 30 * 24 * 3600_000 }),
    ).rejects.toThrow("at most 7 days");
  });

  it("refuses a prefix that leaves the bucket's folder", () => {
    for (const prefix of ["/files/", "../", "a/./b/", "a/../"])
      expect(() => s3({ prefix })).toThrow("prefix must not");
  });

  it("is not a key-value storage to Brick's features", () => {
    const files = localFiles();
    const cache = defineStorage({ driver: memory() });
    expect(
      serviceStorage(defineService("f", { deps: { files } })),
    ).toBeUndefined();
    expect(
      serviceStorage(defineService("both", { deps: { files, cache } })),
    ).toBeDefined();
  });
});
