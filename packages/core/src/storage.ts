import { connection, REDIS_WAIT_MS } from "./socket-redis";
import { portOf } from "./service-port";
import type { Service } from "./types";

/** What `increment` returns: the count after this hit, and when the counter expires. */
export interface Counter {
  count: number;
  expiresInMs: number;
}

/** What `putIfAbsent` returns: whether this call stored its value, and the value now stored. */
export interface PutIfAbsentResult {
  stored: boolean;
  value: string;
}

/** Key-value methods: values are strings, durations are milliseconds. */
interface KeyValueMethods {
  /** The value, or `null` when the key is missing or expired. */
  get(key: string): Promise<string | null>;
  /** Stores the value; without `ttlMs` it never expires. */
  put(key: string, value: string, ttlMs?: number): Promise<void>;
  /** Stores the value unless the key exists; says whether it did, and the value now stored. Atomic. */
  putIfAbsent(
    key: string,
    value: string,
    ttlMs: number,
  ): Promise<PutIfAbsentResult>;
  /** Adds 1 to a counter that expires `ttlMs` after its first hit. Atomic. Throws on a key that holds something other than an integer. */
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

/** A storage could not be reached, or did not answer in time. Thrown by every call while it is down. A write that rejects with it may still have been applied. */
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

/** Who uses each handle: the apps running with it, so the last to stop closes it. */
const users: WeakMap<object, number> = ((globalThis as any)[
  Symbol.for("brickkit.storage.users")
] ??= new WeakMap());

function notACounter(key: string): Error {
  return new Error(`Storage: "${key}" does not hold a counter`);
}

function ttl(ttlMs: number | undefined, required: boolean): void {
  if (ttlMs === undefined && !required) return;
  if (!Number.isSafeInteger(ttlMs) || ttlMs! <= 0)
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
 * Pass a call's `ctx.deps` to follow a test's override of the storage.
 *
 * @param deps - The deps to search; the service's own by default.
 * @returns The storage, or `undefined` when there is none.
 * @throws When the deps hold two key-value storages: Brick can't tell which to use.
 */
export function serviceStorage(
  service: Service<any, any>,
  deps: Readonly<Record<string, unknown>> = portOf(service).deps,
): KeyValueStorage | undefined {
  // One handle under two names is one storage.
  const found = Object.entries(deps).filter(
    ([, value], index, all) =>
      frameworkSides.has(value as object) &&
      all.findIndex(([, other]) => other === value) === index,
  );
  if (found.length > 1)
    throw new Error(
      `Service "${service.name}" has two key-value storages in its deps, "${found[0]![0]}" and "${found[1]![0]}"; Brick needs one for its own keys. Keep one of them on this service.`,
    );
  return found[0] && frameworkSides.get(found[0][1] as object);
}

/**
 * Counts an app as a user of every storage among `deps` (each a service's or a
 * plugin install's). The returned function, called once when the app stops,
 * closes the storages no other app uses.
 */
export function useStorages(
  deps: readonly Readonly<Record<string, unknown>>[],
): () => Promise<void> {
  const handles = new Set(
    deps.flatMap((values) =>
      Object.values(values).filter((value) =>
        frameworkSides.has(value as object),
      ),
    ) as KeyValueStorage[],
  );
  for (const handle of handles) users.set(handle, (users.get(handle) ?? 0) + 1);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const unused = [...handles].filter((handle) => {
      const left = users.get(handle)! - 1;
      users.set(handle, left);
      return left === 0;
    });
    await Promise.all(unused.map((handle) => handle.close()));
  };
}

/** Options of the `redis()` storage driver. */
export interface RedisStorageOptions {
  /** Defaults to `REDIS_URL`, then `redis://localhost:6379`. */
  url?: string;
  /** Put in front of every key, Brick's own included, so two apps or environments can share one Redis database. */
  prefix?: string;
}

// Sets the counter's expiry whenever it has none, so it never lives forever.
// Only a wrong type or a non-integer value means "not a counter"; READONLY, OOM and the like stay as Redis sent them.
const NOT_A_COUNTER = "BRICK_NOT_A_COUNTER";
const INCREMENT = `local n = redis.pcall('INCR', KEYS[1])
if type(n) == 'table' and n.err then
  if string.find(n.err, '^WRONGTYPE') or string.find(n.err, 'not an integer') then return redis.error_reply('${NOT_A_COUNTER}') end
  return n
end
local t = redis.call('PTTL', KEYS[1])
if t < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) t = tonumber(ARGV[1]) end
return {n, t}`;
const PUT_IF_ABSENT = `if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then return {1, ARGV[1]} end
return {0, redis.call('GET', KEYS[1])}`;
const TIMED_OUT = Symbol("timed out");
const UNAVAILABLE_REPLY =
  /^(LOADING|READONLY|OOM|BUSY|MASTERDOWN|CLUSTERDOWN|NOREPLICAS|MISCONF|TRYAGAIN)\b/;

/**
 * Key-value storage in Redis, through Bun's built-in client. Connects on first
 * use and reconnects by itself. While Redis is unreachable, calls reject with
 * `StorageUnavailableError`: the first after about a second, the rest at once.
 * A command Redis doesn't answer within a second rejects the same way, and the
 * connection is dropped so the next call opens a fresh one.
 *
 * @param options - `url`: defaults to `REDIS_URL`, then `redis://localhost:6379`.
 * `prefix`: put in front of every key, to share one Redis database between apps.
 */
export function redis(options: RedisStorageOptions = {}): KeyValueDriver {
  const prefix = options.prefix ?? "";
  let conn: ReturnType<typeof connection> | undefined;
  let down = false;
  const send = async (command: string, args: string[]): Promise<any> => {
    const current = (conn ??= connection(options.url, () => {
      down = false;
    }));
    // Once a wait has failed, fail at once until a reconnect succeeds.
    if (!down) await current.opened(REDIS_WAIT_MS);
    // Undefined too when close() ran during the wait.
    const client = current.get();
    if (!client) {
      if (conn === current) down = true;
      throw new StorageUnavailableError("Storage: Redis is unreachable", {
        cause: current.failure(),
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        client.send(command, args),
        new Promise((_, reject) => {
          timer = setTimeout(reject, REDIS_WAIT_MS, TIMED_OUT);
        }),
      ]);
    } catch (error) {
      if (error === TIMED_OUT) {
        // A connection that stops answering is dropped; the next call opens a fresh one.
        if (conn === current) {
          conn = undefined;
          down = false;
        }
        current.close();
        throw new StorageUnavailableError(
          `Storage: Redis did not answer within ${REDIS_WAIT_MS} ms`,
        );
      }
      if (client.connected) {
        // Replies that mean Redis cannot serve right now (restart, failover, out of memory, a busy script).
        if (UNAVAILABLE_REPLY.test(String((error as Error)?.message)))
          throw new StorageUnavailableError(
            `Storage: Redis cannot serve the command right now (${(error as Error).message})`,
            { cause: error },
          );
        throw error;
      }
      throw new StorageUnavailableError(
        "Storage: the Redis connection was lost",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    kind: "key-value",
    get: (key) => send("GET", [prefix + key]),
    put: async (key, value, ttlMs) => {
      const args = [prefix + key, value];
      await send(
        "SET",
        ttlMs === undefined ? args : [...args, "PX", String(ttlMs)],
      );
    },
    putIfAbsent: async (key, value, ttlMs) => {
      const [stored, now] = await send("EVAL", [
        PUT_IF_ABSENT,
        "1",
        prefix + key,
        value,
        String(ttlMs),
      ]);
      return { stored: stored === 1, value: now };
    },
    increment: async (key, ttlMs) => {
      const [count, expiresInMs] = await send("EVAL", [
        INCREMENT,
        "1",
        prefix + key,
        String(ttlMs),
      ]).catch((error) => {
        throw String(error?.message).includes(NOT_A_COUNTER)
          ? notACounter(key)
          : error;
      });
      return {
        count: Number(count),
        expiresInMs: Math.max(1, Number(expiresInMs)),
      };
    },
    delete: async (key) => {
      await send("DEL", [prefix + key]);
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
      if (entry) return { stored: false, value: entry.value };
      entries.set(key, { value, expiresAt: expiry(ttlMs) });
      return { stored: true, value };
    },
    increment: async (key, ttlMs) => {
      const entry = read(key) ?? { value: "0" };
      // What Redis's INCR takes: a plain integer, no spaces, signs, exponents or leading zeros.
      const count = Number(entry.value) + 1;
      if (
        !/^(0|-?[1-9][0-9]*)$/.test(entry.value) ||
        !Number.isSafeInteger(count)
      )
        throw notACounter(key);
      const expiresAt = entry.expiresAt ?? Date.now() + ttlMs;
      entries.set(key, { value: String(count), expiresAt });
      return { count, expiresInMs: Math.max(1, expiresAt - Date.now()) };
    },
    delete: async (key) => {
      entries.delete(key);
    },
    close: async () => {},
  };
}
