import { connection, REDIS_WAIT_MS } from "./socket-redis";
import { portOf } from "./service-port";
import type { Service } from "./types";

/** What `increment` returns: the count after this hit, and when the counter expires. */
export interface Counter {
  count: number;
  expiresInMs: number;
}

/** Key-value methods: values are strings, durations are milliseconds. */
interface KeyValueMethods {
  /** The value, or `null` when the key is missing or expired. */
  get(key: string): Promise<string | null>;
  /** Stores the value; without `ttlMs` it never expires. */
  put(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Stores the value unless the key exists; returns the value now stored. Atomic. */
  putIfAbsent(key: string, value: string, ttlMs: number): Promise<string>;
  /** Adds 1 to a counter that expires `ttlMs` after its first hit. Atomic. */
  increment(key: string, ttlMs: number): Promise<Counter>;
  delete(key: string): Promise<void>;
  /** Closes the connection, if any. The next call opens a new one. */
  close(): Promise<void>;
}

/** A driver for key-value storage, such as `redis()` or `memory()`. It sees full keys. */
export interface KeyValueDriver extends KeyValueMethods {
  readonly kind: "key-value";
}

/** Every kind of storage driver; `kind` decides the handle `defineStorage` returns. */
export type StorageDriver = KeyValueDriver;

/** The handle of a key-value storage. App keys live apart from Brick's own. */
export interface KeyValueStorage extends KeyValueMethods {
  readonly kind: "key-value";
}

/** The handle `defineStorage` returns for a driver. */
export type StorageOf<D extends StorageDriver> = D extends KeyValueDriver
  ? KeyValueStorage
  : never;

/** A storage could not be reached. Thrown by every call while it is down. */
export class StorageUnavailableError extends Error {
  override readonly name = "StorageUnavailableError";
}

/** App keys and Brick's own keys sit under different prefixes, so neither reaches the other. */
const APP_PREFIX = "app:";
const BRICK_PREFIX = "brick:storage:";

/** The framework side of each storage handle; global so a second core copy finds it. */
const frameworkSides: WeakMap<object, KeyValueStorage> = ((globalThis as any)[
  Symbol.for("brickkit.storage")
] ??= new WeakMap());

function ttl(ttlMs: number | undefined, required: boolean): void {
  if (ttlMs === undefined && !required) return;
  if (!Number.isInteger(ttlMs) || ttlMs! <= 0)
    throw new Error(`Storage ttlMs must be a positive integer, got ${ttlMs}`);
}

function side(driver: KeyValueDriver, prefix: string): KeyValueStorage {
  return Object.freeze({
    kind: "key-value",
    get: async (key: string) => driver.get(prefix + key),
    put: async (key: string, value: string, ttlMs?: number) => {
      ttl(ttlMs, false);
      return driver.put(prefix + key, value, ttlMs);
    },
    putIfAbsent: async (key: string, value: string, ttlMs: number) => {
      ttl(ttlMs, true);
      return driver.putIfAbsent(prefix + key, value, ttlMs);
    },
    increment: async (key: string, ttlMs: number) => {
      ttl(ttlMs, true);
      return driver.increment(prefix + key, ttlMs);
    },
    delete: async (key: string) => driver.delete(prefix + key),
    close: async () => driver.close(),
  } as const);
}

/**
 * Declare a storage. The driver decides its kind: `redis()` and `memory()` make
 * key-value storage. Pass it to a service as a dep, and read it as `ctx.deps.<name>`.
 * Nothing connects until the first call.
 *
 * @param options - `driver`: `redis({ url })`, or `memory()` for tests and local development.
 * @returns The handle: `get`, `put`, `putIfAbsent`, `increment`, `delete` and `close`.
 * @example
 * export const cache = defineStorage({ driver: redis({ url: process.env.REDIS_URL }) });
 * export const auth = defineService("auth", { deps: { cache } });
 * // in an action
 * await ctx.deps.cache.put(`otp:${input.email}`, code, 5 * 60_000);
 */
export function defineStorage<D extends StorageDriver>(options: {
  driver: D;
}): StorageOf<D> {
  const driver = options?.driver;
  if (driver?.kind !== "key-value")
    throw new Error(
      "defineStorage needs a driver, such as redis() or memory()",
    );
  const handle = side(driver, APP_PREFIX);
  frameworkSides.set(handle, side(driver, BRICK_PREFIX));
  return handle as StorageOf<D>;
}

/**
 * Brick's own side of the key-value storage among a service's deps, for a
 * feature that stores its own keys (rate-limit counters, seen webhook ids).
 *
 * @returns The storage, or `undefined` when the service has none.
 * @throws When the service has two key-value storages: Brick can't tell which to use.
 */
export function serviceStorage(
  service: Service<any, any>,
): KeyValueStorage | undefined {
  const found = Object.entries(portOf(service).deps).filter(([, value]) =>
    frameworkSides.has(value as object),
  );
  if (found.length > 1)
    throw new Error(
      `Service "${service.name}" has two key-value storages in its deps, "${found[0]![0]}" and "${found[1]![0]}"; Brick needs one for its own keys. Keep one of them on this service.`,
    );
  return found[0] && frameworkSides.get(found[0][1] as object);
}

/** Closes every storage among the services' deps (on app stop). */
export async function closeStorages(
  services: readonly Service<any, any>[],
): Promise<void> {
  const handles = new Set(
    services.flatMap((service) =>
      Object.values(portOf(service).deps).filter((value) =>
        frameworkSides.has(value as object),
      ),
    ),
  );
  await Promise.all(
    [...handles].map((handle) => (handle as KeyValueStorage).close()),
  );
}

/** Options of the `redis()` storage driver. */
export interface RedisStorageOptions {
  /** Defaults to `REDIS_URL`, then `redis://localhost:6379`. */
  url?: string;
}

// Sets the counter's expiry whenever it has none, so it never lives forever.
const INCREMENT = `local n = redis.call('INCR', KEYS[1])
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) t = tonumber(ARGV[1]) end
return {n, t}`;
const PUT_IF_ABSENT = `if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return ARGV[1] end
return redis.call('GET', KEYS[1])`;

/**
 * Key-value storage in Redis, through Bun's built-in client. Connects on first
 * use and reconnects by itself. While Redis is unreachable, calls reject with
 * `StorageUnavailableError`: the first after about a second, the rest at once.
 *
 * @param options - `url`: defaults to `REDIS_URL`, then `redis://localhost:6379`.
 */
export function redis(options: RedisStorageOptions = {}): KeyValueDriver {
  let conn: ReturnType<typeof connection> | undefined;
  let down = false;
  const send = async (command: string, args: string[]): Promise<any> => {
    conn ??= connection(options.url, () => {
      down = false;
    });
    // Once a wait has failed, fail at once until a reconnect succeeds.
    if (!down) await conn.opened(REDIS_WAIT_MS);
    const client = conn.get();
    if (!client) {
      down = true;
      throw new StorageUnavailableError("Storage: Redis is unreachable");
    }
    try {
      return await client.send(command, args);
    } catch (error) {
      if (client.connected) throw error;
      throw new StorageUnavailableError(
        "Storage: the Redis connection was lost",
        { cause: error },
      );
    }
  };
  return {
    kind: "key-value",
    get: (key) => send("GET", [key]),
    put: async (key, value, ttlMs) => {
      await send(
        "SET",
        ttlMs === undefined ? [key, value] : [key, value, "PX", String(ttlMs)],
      );
    },
    putIfAbsent: (key, value, ttlMs) =>
      send("EVAL", [PUT_IF_ABSENT, "1", key, value, String(ttlMs)]),
    increment: async (key, ttlMs) => {
      const [count, expiresInMs] = await send("EVAL", [
        INCREMENT,
        "1",
        key,
        String(ttlMs),
      ]);
      return { count: Number(count), expiresInMs: Number(expiresInMs) };
    },
    delete: async (key) => {
      await send("DEL", [key]);
    },
    close: async () => {
      conn?.close();
      conn = undefined;
      down = false;
    },
  };
}

/**
 * Key-value storage in this process's memory, for tests and local development.
 * Lost on restart and not shared between processes.
 */
export function memory(): KeyValueDriver {
  // shortcut: an expired key is dropped only when touched again; sweep if a long-running dev process grows.
  const entries = new Map<string, { value: string; expiresAt?: number }>();
  const read = (key: string) => {
    const entry = entries.get(key);
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };
  const expiry = (ttlMs?: number) =>
    ttlMs === undefined ? undefined : Date.now() + ttlMs;
  return {
    kind: "key-value",
    get: async (key) => read(key)?.value ?? null,
    put: async (key, value, ttlMs) => {
      entries.set(key, { value, expiresAt: expiry(ttlMs) });
    },
    putIfAbsent: async (key, value, ttlMs) => {
      const entry = read(key);
      if (entry) return entry.value;
      entries.set(key, { value, expiresAt: expiry(ttlMs) });
      return value;
    },
    increment: async (key, ttlMs) => {
      const entry = read(key) ?? { value: "0" };
      const count = Number(entry.value) + 1;
      if (!Number.isInteger(count))
        throw new Error(`Storage: "${key}" does not hold a counter`);
      const expiresAt = entry.expiresAt ?? Date.now() + ttlMs;
      entries.set(key, { value: String(count), expiresAt });
      return { count, expiresInMs: expiresAt - Date.now() };
    },
    delete: async (key) => {
      entries.delete(key);
    },
    close: async () => {},
  };
}
