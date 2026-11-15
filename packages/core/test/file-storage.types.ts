import {
  defineService,
  defineStorage,
  memory,
  s3,
  t,
  useDeps,
  type CallDeps,
  type CallFiles,
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
// @ts-expect-error
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
    // @ts-expect-error
    await ctx.deps.files.put("files/acme/x", new Blob());
    // @ts-expect-error
    await ctx.deps.files.increment("k", 1000);
    // @ts-expect-error
    await ctx.deps.cache.url("k");
    // @ts-expect-error
    ctx.deps.files.in("globex");
    return { url, size: blob?.size };
  },
});

const fromService: ScopedFiles = useDeps(crm).files.in("acme");
void fromService;

declare const optional: CallDeps<{ backup?: FileStorage; n: number }>;
const backup: CallFiles | undefined = optional.backup;
void backup;
// @ts-expect-error
optional.backup?.in("globex");
function generic<P extends { n: number }>(deps: CallDeps<P>): number {
  return deps.n;
}
void generic;
