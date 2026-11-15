import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { freezeAsBuiltDeps } from "./deps";
import { hasIdentity, identityOf } from "./identity";
import { SecretRef } from "./secrets";
import type { Service } from "./types";

/** What `put` returns: the id to keep, and what was stored. */
export interface StoredFile {
  id: string;
  size: number;
  contentType: string;
}

/** File methods inside one tenant. Ids are the ones `put` returned; nothing takes a key, a path or a URL. */
export interface ScopedFiles {
  /** Stores the file under a new id Brick generates. `contentType` defaults to the file's own type. */
  put(file: Blob, options?: { contentType?: string }): Promise<StoredFile>;
  /** A short-lived signed link that downloads the file as an attachment. `expiresInMs` defaults to 5 minutes. */
  url(
    id: string,
    options?: { expiresInMs?: number; download?: string },
  ): Promise<string>;
  /** The file, or `undefined` when this tenant has none with that id. */
  get(id: string): Promise<Blob | undefined>;
  /** Removes the file; does nothing when this tenant has none with that id. */
  delete(id: string): Promise<void>;
}

/**
 * The handle of a file storage. In a call, `ctx.deps.<name>` is scoped to the
 * caller's tenant; outside one, name the tenant with `in(tenant)`.
 */
export interface FileStorage extends ScopedFiles {
  readonly kind: "file";
  /** The files of one tenant, for server code outside a request: a listener, a schedule, a webhook. */
  in(tenant: string): ScopedFiles;
}

/** A file storage as a call sees it in `ctx.deps`: the caller's tenant only, with no `in`. */
export interface CallFiles extends ScopedFiles {
  readonly kind: "file";
}

/** Deps as a call sees them: each file storage scoped to the caller's tenant. */
export type CallDeps<T> = { [K in keyof T]: CallDep<T[K]> };
type CallDep<V> = V extends FileStorage ? CallFiles : V;

export type RawDeps<T> = { [K in keyof T]: RawDep<T[K]> };
type RawDep<V> = V extends CallFiles ? FileStorage : V;

/** A driver for file storage, such as `s3()`. It sees full keys; the handle builds them. */
export interface FileDriver {
  readonly kind: "file";
  /** Put in front of every key. */
  readonly prefix: string;
  /** The directory files are written under, in local mode. */
  readonly local?: string;
  /** Throws when the driver cannot work as configured; `brick()` calls it at startup. */
  check?(): void;
  write(key: string, file: Blob, contentType: string): Promise<void>;
  read(key: string): Promise<Blob | undefined>;
  remove(key: string): Promise<void>;
  /** A signed GET for the key, served with `contentDisposition`. */
  sign(
    key: string,
    expiresInMs: number,
    contentDisposition: string,
  ): Promise<string>;
}

type Setting = string | SecretRef<string>;

/** Options of the `s3()` storage driver. Settings left out come from Bun's `S3_*` and `AWS_*` environment variables. */
export interface S3StorageOptions {
  bucket?: string;
  /** Put in front of every key, such as `"files/"`. */
  prefix?: string;
  /** A directory: store files there instead of S3, for local development and tests. */
  local?: string;
  accessKeyId?: Setting;
  secretAccessKey?: Setting;
  sessionToken?: Setting;
  region?: Setting;
  /** An S3-compatible endpoint, such as R2 or MinIO. */
  endpoint?: Setting;
}

const DEFAULT_EXPIRY_MS = 5 * 60_000;
/** The longest a link may last: S3 refuses a presigned URL valid for longer. */
const MAX_EXPIRY_MS = 7 * 24 * 60 * 60_000;
const S3_READ_IDLE_TIMEOUT_MS = 30_000;
export const LOCAL_FILES_ROUTE = "/_brick/files";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const drivers: WeakMap<object, FileDriver> = ((globalThis as any)[
  Symbol.for("brickkit.storage.files")
] ??= new WeakMap());

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function tenantKey(tenant: unknown, local = false): string {
  if (
    typeof tenant !== "string" ||
    !tenant ||
    tenant === "." ||
    tenant === ".." ||
    !tenant.isWellFormed()
  )
    throw new Error(
      `File storage: the tenant must be a non-empty, well-formed string other than "." and "..", got ${JSON.stringify(tenant)}`,
    );
  return local ? sha256(tenant) : encodeURIComponent(tenant);
}

function attachment(download: string | undefined): string {
  if (!download) return "attachment";
  const ascii = download.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(download)}`;
}

function scoped(
  driver: FileDriver,
  tenant: () => Promise<string>,
): ScopedFiles {
  const folder = async () =>
    `${driver.prefix}${tenantKey(await tenant(), !!driver.local)}/`;
  const keyOf = async (id: string) => {
    const at = await folder();
    return typeof id === "string" && UUID.test(id) ? at + id : undefined;
  };
  return Object.freeze({
    put: async (file: Blob, options?: { contentType?: string }) => {
      if (!(file instanceof Blob))
        throw new TypeError("File storage: put needs a Blob or a File");
      const at = await folder();
      const id = crypto.randomUUID();
      // Normalised as a Blob does (it adds a charset only to a lowercase type), so `put` returns what `get` gives back.
      const given = (options?.contentType || file.type).toLowerCase();
      const contentType =
        new Blob([], { type: given }).type || "application/octet-stream";
      await driver.write(at + id, file, contentType);
      return { id, size: file.size, contentType };
    },
    url: async (
      id: string,
      options: { expiresInMs?: number; download?: string } = {},
    ) => {
      const key = await keyOf(id);
      if (!key)
        throw new Error(`File storage: ${JSON.stringify(id)} is not a file id`);
      const expiresInMs = options.expiresInMs ?? DEFAULT_EXPIRY_MS;
      if (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0)
        throw new Error(
          `File storage: expiresInMs must be a positive integer, got ${expiresInMs}`,
        );
      if (expiresInMs > MAX_EXPIRY_MS)
        throw new Error(
          `File storage: expiresInMs must be at most 7 days (${MAX_EXPIRY_MS}), got ${expiresInMs}`,
        );
      return driver.sign(key, expiresInMs, attachment(options.download));
    },
    get: async (id: string) => {
      const key = await keyOf(id);
      return key ? driver.read(key) : undefined;
    },
    delete: async (id: string) => {
      const key = await keyOf(id);
      if (key) await driver.remove(key);
    },
  });
}

export function fileStorage(driver: FileDriver): FileStorage {
  const outside = () =>
    Promise.reject(
      new Error(
        "File storage: there is no caller here to take the tenant from. In an action read ctx.deps.<name>; elsewhere name the tenant: files.in(tenantId)",
      ),
    );
  const handle: FileStorage = Object.freeze({
    kind: "file",
    in: (tenant: string) => {
      tenantKey(tenant);
      return scoped(driver, async () => tenant);
    },
    put: outside,
    url: outside,
    get: outside,
    delete: outside,
  });
  drivers.set(handle, driver);
  return handle;
}

const fileNames = new WeakMap<object, string[]>();
const views = new WeakMap<object, { deps: object; ctx: object }>();

export function hasFilesView(ctx: { deps?: unknown }, deps: object): boolean {
  const view = views.get(ctx.deps as object);
  return view?.deps === deps && view.ctx === ctx;
}

export function scopeFiles<T extends Readonly<Record<string, unknown>>>(
  deps: T,
  ctx: object,
): T {
  let names = fileNames.get(deps);
  if (!names)
    fileNames.set(
      deps,
      (names = Object.keys(deps).filter((name) =>
        drivers.has(deps[name] as object),
      )),
    );
  if (!names.length) return deps;
  const tenant = async () => {
    const identity = await identityOf(ctx);
    if (!identity?.tenant)
      throw new Error(
        "File storage: this call has no tenant. The service's identity hook must return { id, tenant } for callers that use files; outside a request use files.in(tenantId)",
      );
    return identity.tenant;
  };
  const copy: Record<string, unknown> = { ...deps };
  for (const name of names) {
    const handle = deps[name] as FileStorage;
    const files: CallFiles = Object.freeze({
      kind: "file",
      ...scoped(drivers.get(handle)!, tenant),
    });
    copy[name] = files;
  }
  const view = freezeAsBuiltDeps(copy);
  views.set(view, { deps, ctx });
  return view as T;
}

export function checkFileStorages(
  service: Service<any, any>,
  deps: readonly Readonly<Record<string, unknown>>[],
): void {
  if (hasIdentity(service)) return;
  for (const values of deps) {
    const name = Object.keys(values).find((key) =>
      drivers.has(values[key] as object),
    );
    if (name)
      throw new Error(
        `Service "${service.name}" has file storage "${name}" in its deps or a plugin's but no identity hook. Files are kept per tenant: add identity: (ctx) => ({ id, tenant }) to the service.`,
      );
  }
}

const warned = new WeakSet<FileDriver>();

export function localFileDirs(
  deps: readonly Readonly<Record<string, unknown>>[],
): Set<string> {
  const dirs = new Set<string>();
  for (const values of deps)
    for (const value of Object.values(values)) {
      const driver = drivers.get(value as object);
      driver?.check?.();
      if (!driver?.local) continue;
      dirs.add(driver.local);
      if (process.env.NODE_ENV === "production" && !warned.has(driver)) {
        warned.add(driver);
        console.warn(
          `[Brick-TS] A file storage stores files in the local directory ${driver.local} while NODE_ENV is production. Set local only for development and tests.`,
        );
      }
    }
  return dirs;
}

/**
 * File storage in S3 or an S3-compatible store (R2, MinIO), through Bun's
 * built-in client. Nothing connects or reads credentials until the first call.
 * With `local`, files are written under that directory instead.
 *
 * @param options - `bucket`, `prefix`, `local`, and the credentials and
 * `endpoint` Bun's client takes, each a string or a `SecretRef`; left out,
 * Bun's `S3_*` and `AWS_*` environment variables apply.
 */
export function s3(options: S3StorageOptions = {}): FileDriver {
  const prefix = options.prefix ?? "";
  if (
    prefix.startsWith("/") ||
    prefix.split("/").some((part) => part === "." || part === "..")
  )
    throw new Error(
      `s3(): prefix must not start with "/" or hold "." or ".." segments, got ${JSON.stringify(prefix)}`,
    );
  if (options.local !== undefined)
    return localDriver(resolve(options.local), prefix);
  let client: Bun.S3Client | undefined;
  // Read here, not at import; passed to the client, which reads the environment only at process start.
  const bucket = () =>
    options.bucket || process.env.S3_BUCKET || process.env.AWS_BUCKET;
  // Without a bucket, Bun's client would take the key's first segment, the tenant, for one.
  const check = () => {
    if (!bucket())
      throw new Error(
        "s3(): no bucket. Pass bucket, set S3_BUCKET or AWS_BUCKET, or set local for a directory.",
      );
  };
  const open = () => {
    if (client) return client;
    check();
    const settings: Record<string, string> = { bucket: bucket()! };
    for (const name of [
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "region",
      "endpoint",
    ] as const) {
      const value = options[name];
      if (value !== undefined)
        settings[name] = value instanceof SecretRef ? value.require() : value;
    }
    return (client = new Bun.S3Client(settings));
  };
  const presign = (
    key: string,
    expiresInMs: number,
    contentDisposition?: string,
  ) =>
    open().presign(key, {
      method: "GET",
      expiresIn: Math.ceil(expiresInMs / 1000),
      ...(contentDisposition && { contentDisposition }),
    });
  const rethrowWithoutUrl = async <T>(
    operation: string,
    run: () => Promise<T>,
  ) => {
    try {
      return await run();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      throw new Error(
        `File storage: S3 failed ${operation} a file${typeof code === "string" ? ` (${code})` : ""}`,
      );
    }
  };
  return {
    kind: "file",
    prefix,
    check,
    write: async (key, file, contentType) => {
      const client = open();
      await rethrowWithoutUrl("writing", () =>
        client.write(key, file, { type: contentType }),
      );
    },
    read: async (key) => {
      const url = presign(key, 60_000);
      const stalled = new AbortController();
      let idle: ReturnType<typeof setTimeout> | undefined;
      const stillMoving = () => {
        clearTimeout(idle);
        idle = setTimeout(() => stalled.abort(), S3_READ_IDLE_TIMEOUT_MS);
      };
      stillMoving();
      try {
        const response = await rethrowWithoutUrl("reading", () =>
          fetch(url, { signal: stalled.signal }),
        );
        if (response.status === 404) return undefined;
        if (!response.ok)
          throw new Error(
            `File storage: S3 answered ${response.status} reading a file`,
          );
        return await rethrowWithoutUrl("reading", async () => {
          const chunks: Uint8Array[] = [];
          for await (const chunk of response.body ?? []) {
            stillMoving();
            chunks.push(chunk);
          }
          return new Blob(chunks as BlobPart[], {
            type: response.headers.get("content-type") ?? "",
          });
        });
      } finally {
        clearTimeout(idle);
      }
    },
    remove: async (key) => {
      const client = open();
      await rethrowWithoutUrl("deleting", () => client.delete(key));
    },
    sign: async (key, expiresInMs, contentDisposition) =>
      presign(key, expiresInMs, contentDisposition),
  };
}

const perProcessLinkKey: Buffer = ((globalThis as any)[
  Symbol.for("brickkit.storage.files.linkKey")
] ??= randomBytes(32));
const mac = (payload: string) =>
  createHmac("sha256", perProcessLinkKey).update(payload).digest();

interface LinkClaims {
  dirDigest: string;
  key: string;
  expiresAt: number;
  disposition: string;
}

export function signFileLink(claims: LinkClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(payload).toString("base64url")}`;
}

function verifyFileLink(token: string | null): LinkClaims | undefined {
  const dot = token?.indexOf(".") ?? -1;
  if (!token || dot < 0) return undefined;
  const payload = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = mac(payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    return typeof claims.expiresAt === "number" && claims.expiresAt > Date.now()
      ? claims
      : undefined;
  } catch {
    return undefined;
  }
}

async function localPath(
  dir: string,
  key: string,
): Promise<string | undefined> {
  const folder = relative(dir, dirname(join(dir, key)));
  if (folder.split(sep).includes("..")) return undefined;
  try {
    const [root, real] = await Promise.all([
      realpath(dir),
      realpath(join(dir, folder)),
    ]);
    return real === join(root, folder) ? join(real, basename(key)) : undefined;
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as { code?: string }).code!))
      return undefined;
    throw error;
  }
}

const isFile = (path: string) =>
  lstat(path).then(
    (stat) => stat.isFile(),
    (error) => {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return false;
      throw error;
    },
  );

async function readLocal(dir: string, key: string): Promise<Blob | undefined> {
  const path = await localPath(dir, key);
  if (!path || !(await isFile(path)) || !(await isFile(`${path}.type`)))
    return undefined;
  const type = await readFile(`${path}.type`, "utf8");
  return new Blob([await readFile(path)], { type });
}

const outsideDir = () =>
  new Error(
    "File storage: the file's folder is not inside the local directory; refusing to follow a symlink",
  );

function localDriver(dir: string, prefix: string): FileDriver {
  return {
    kind: "file",
    prefix,
    local: dir,
    write: async (key, file, contentType) => {
      await mkdir(dirname(join(dir, key)), { recursive: true });
      const path = await localPath(dir, key);
      if (!path) throw outsideDir();
      await Bun.write(`${path}.type`, contentType);
      await Bun.write(path, file);
    },
    read: (key) => readLocal(dir, key),
    remove: async (key) => {
      const path = await localPath(dir, key);
      if (!path) return;
      await rm(path, { force: true });
      await rm(`${path}.type`, { force: true });
    },
    sign: async (key, expiresInMs, contentDisposition) =>
      `${LOCAL_FILES_ROUTE}?token=${signFileLink({ dirDigest: sha256(dir), key, expiresAt: Date.now() + expiresInMs, disposition: contentDisposition })}`,
  };
}

export function localFilesRoute(dirs: ReadonlySet<string>) {
  const byDigest = new Map([...dirs].map((dir) => [sha256(dir), dir]));
  return async ({ request }: { request: Request }): Promise<Response> => {
    const claims = verifyFileLink(
      new URL(request.url).searchParams.get("token"),
    );
    const dir = claims && byDigest.get(claims.dirDigest);
    if (!claims || !dir)
      return new Response("Invalid or expired link", { status: 403 });
    const file = await readLocal(dir, claims.key);
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": file.type,
        "content-disposition": claims.disposition,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  };
}
