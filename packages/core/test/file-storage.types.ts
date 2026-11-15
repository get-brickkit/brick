import {
  defineService,
  defineStorage,
  memory,
  s3,
  t,
  type FileStorage,
  type KeyValueStorage,
  type ScopedFiles,
  type StoredFile,
} from "../src";

const files = defineStorage({ driver: s3({ bucket: "b", prefix: "files/" }) });
const handle: FileStorage = files;
const scoped: ScopedFiles = files.in("acme");
void handle;
void scoped;
// @ts-expect-error a file storage is not a key-value storage
const wrong: KeyValueStorage = files;
void wrong;
const cache: KeyValueStorage = defineStorage({ driver: memory() });

const crm = defineService("crm", {
  deps: { files, cache },
  identity: () => ({ id: "u", tenant: "acme" }),
});
crm.action({
  name: "attach",
  input: t.Object({
    file: t.File({ maxSize: 1024, accept: ["application/pdf", "image/*"] }),
  }),
  execute: async ({ input, ctx }) => {
    const stored: StoredFile = await ctx.deps.files.put(input.file);
    const url: string = await ctx.deps.files.url(stored.id, {
      download: "a.pdf",
      expiresInMs: 1000,
    });
    const blob: Blob | undefined = await ctx.deps.files.get(stored.id);
    await ctx.deps.files.delete(stored.id);
    // @ts-expect-error put takes a Blob, not a key
    await ctx.deps.files.put("files/acme/x", new Blob());
    // @ts-expect-error file storage has no key-value methods
    await ctx.deps.files.increment("k", 1000);
    // @ts-expect-error key-value storage stays key-value
    await ctx.deps.cache.url("k");
    return { url, size: blob?.size };
  },
});
