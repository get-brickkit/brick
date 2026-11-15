import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { brickDeps } from "./deps";
import { hasIdentity, identityOf } from "./identity";
import { SecretRef } from "./secrets";
import { portOf } from "./service-port";
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

/** A driver for file storage, such as `s3()`. It sees full keys; the handle builds them. */
export interface FileDriver {
  readonly kind: "file";
  /** Put in front of every key. */
  readonly prefix: string;
  /** The directory files are written under, in local mode. */
  readonly local?: string;
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
/** The route that serves local-mode links. Outside the API prefix, like Brick's other routes. */
export const LOCAL_FILES_ROUTE = "/_brick/files";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The driver behind each file storage handle; global so a second core copy finds it. */
const drivers: WeakMap<object, FileDriver> = ((globalThis as any)[
  Symbol.for("brickkit.storage.files")
] ??= new WeakMap());

function tenantKey(tenant: unknown): string {
  // "." and ".." survive encodeURIComponent, and a URL or a path would resolve them.
  if (
    typeof tenant !== "string" ||
    !tenant ||
    tenant === "." ||
    tenant === ".."
  )
    throw new Error(
      `File storage: the tenant must be a non-empty string other than "." and "..", got ${JSON.stringify(tenant)}`,
    );
  return encodeURIComponent(tenant);
}

/** `attachment`, with the download name when given, so the storage origin never renders a file inline. */
function attachment(download: string | undefined): string {
  if (!download) return "attachment";
  const ascii = download.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(download)}`;
}

function scoped(
  driver: FileDriver,
  tenant: () => Promise<string>,
): ScopedFiles {
  const folder = async () => `${driver.prefix}${tenantKey(await tenant())}/`;
  // Not a UUID: no key at all, so another tenant's id, a URL or `../` never reaches the driver.
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
      const contentType =
        options?.contentType || file.type || "application/octet-stream";
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

/** The handle `defineStorage` returns for a file driver. Its own methods have no tenant. */
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

/** The names of the file storages among a deps object, found once per object. */
const fileNames = new WeakMap<object, string[]>();

/**
 * The deps a call sees: `deps` itself when it holds no file storage, else a
 * copy, recorded as built by Brick, with each file storage scoped to the
 * tenant of `ctx`'s identity, resolved on the first method call.
 */
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
    copy[name] = Object.freeze({
      kind: "file",
      in: handle.in,
      ...scoped(drivers.get(handle)!, tenant),
    });
  }
  return brickDeps(copy) as T;
}

/** @throws When the service holds a file storage but has no `identity` hook to take the tenant from. */
export function checkFileStorages(service: Service<any, any>): void {
  if (hasIdentity(service)) return;
  const name = Object.keys(portOf(service).deps).find((key) =>
    drivers.has(portOf(service).deps[key] as object),
  );
  if (name)
    throw new Error(
      `Service "${service.name}" has file storage "${name}" in its deps but no identity hook. Files are kept per tenant: add identity: (ctx) => ({ id, tenant }) to the service.`,
    );
}

const warned = new WeakSet<FileDriver>();

/** The local-mode directories among these deps; warns once per storage when one runs in production. */
export function localFileDirs(
  deps: readonly Readonly<Record<string, unknown>>[],
): Set<string> {
  const dirs = new Set<string>();
  for (const values of deps)
    for (const value of Object.values(values)) {
      const driver = drivers.get(value as object);
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
  const open = () => {
    if (client) return client;
    const settings: Record<string, string> = {};
    for (const name of [
      "bucket",
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
  return {
    kind: "file",
    prefix,
    write: async (key, file, contentType) => {
      await open().write(key, file, { type: contentType });
    },
    // A presigned GET: the response carries the stored content type, and a missing key is a 404.
    read: async (key) => {
      const response = await fetch(presign(key, 60_000));
      if (response.status === 404) return undefined;
      if (!response.ok)
        throw new Error(
          `File storage: S3 answered ${response.status} reading a file`,
        );
      return response.blob();
    },
    remove: async (key) => {
      await open().delete(key);
    },
    sign: async (key, expiresInMs, contentDisposition) =>
      presign(key, expiresInMs, contentDisposition),
  };
}

/** Signs local-mode links; random per process, so links stop working on restart. */
const tokenKey = randomBytes(32);
const mac = (payload: string) =>
  createHmac("sha256", tokenKey).update(payload).digest();

interface LinkClaims {
  /** The storage's directory. */
  d: string;
  /** The key under it. */
  k: string;
  /** Expiry, in ms since the epoch. */
  e: number;
  /** The Content-Disposition to serve. */
  c: string;
}

/** `<base64url(json)>.<hmac>`, as the dashboard's identity header. */
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
    return typeof claims.e === "number" && claims.e > Date.now()
      ? claims
      : undefined;
  } catch {
    return undefined;
  }
}

/** The file at `key` under `dir`: a regular file inside it, never a symlink or a path that leaves it. */
async function readLocal(dir: string, key: string): Promise<Blob | undefined> {
  const path = join(dir, key);
  try {
    const [root, real, stat] = await Promise.all([
      realpath(dir),
      realpath(path),
      lstat(path),
    ]);
    if (!real.startsWith(root + sep) || !stat.isFile()) return undefined;
    const type = await readFile(`${real}.type`, "utf8").catch(
      () => "application/octet-stream",
    );
    return new Blob([await readFile(real)], { type });
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as { code?: string }).code!))
      return undefined;
    throw error;
  }
}

function localDriver(dir: string, prefix: string): FileDriver {
  return {
    kind: "file",
    prefix,
    local: dir,
    write: async (key, file, contentType) => {
      const path = join(dir, key);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(`${path}.type`, contentType);
      await Bun.write(path, file);
    },
    read: (key) => readLocal(dir, key),
    remove: async (key) => {
      const path = join(dir, key);
      await rm(path, { force: true });
      await rm(`${path}.type`, { force: true });
    },
    sign: async (key, expiresInMs, contentDisposition) =>
      `${LOCAL_FILES_ROUTE}?token=${signFileLink({ d: dir, k: key, e: Date.now() + expiresInMs, c: contentDisposition })}`,
  };
}

/** The handler of the local-mode route, for the directories of one app's storages. The token is in the query, which logs and spans leave out. */
export function localFilesRoute(dirs: ReadonlySet<string>) {
  return async ({ request }: { request: Request }): Promise<Response> => {
    const claims = verifyFileLink(
      new URL(request.url).searchParams.get("token"),
    );
    if (!claims || !dirs.has(claims.d))
      return new Response("Invalid or expired link", { status: 403 });
    const file = await readLocal(claims.d, claims.k);
    if (!file) return new Response("Not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": file.type,
        "content-disposition": claims.c,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      },
    });
  };
}
