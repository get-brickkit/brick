import {
  ActionExecutionError,
  type ActionContext,
  type Service,
} from "./types";
import { hasIdentity, identityOf } from "./identity";
import { isIPv4, isIPv6 } from "node:net";
import {
  serviceStorage,
  storageKey,
  StorageUnavailableError,
  type Counter,
  type KeyValueStorage,
} from "./storage";

/**
 * A limit on how often an action runs: at most `max` calls per `windowMs`, per key.
 * A fixed window, counted in the service's key-value storage.
 */
export interface RateLimit<TInput = any, TCtx = ActionContext> {
  /**
   * Whose calls count together: `"actor"` (the service's `identity` id; an
   * anonymous caller counts by IP), `"ip"` (the client address; skipped when
   * there is none, as in-process), or a function of the validated input and
   * the context. A function that returns `null` or `undefined` skips this
   * limit for the call.
   */
  per:
    | "actor"
    | "ip"
    | ((args: { input: TInput; ctx: TCtx }) => string | null | undefined);
  /** Calls allowed per window. */
  max: number;
  /** The window's length in milliseconds. */
  windowMs: number;
}

/** Where an app finds the client address, given the request and the socket peer: a non-empty string, or `undefined` for none. */
export type ClientIp = (args: {
  request: Request;
  peer: string | undefined;
}) => string | undefined;

/** Where a request's client address comes from: set on every request an app receives. */
interface AddressSource {
  clientIp?: ClientIp;
  server: () =>
    | { requestIP(request: Request): { address: string } | null }
    | null
    | undefined;
}
const SOURCE = Symbol.for("brickkit.addressSource");
/** On a call's context: the request whose client address the call counts by, carried through `useService`. */
const CLIENT_REQUEST = Symbol.for("brickkit.clientRequest");

/** Marks a request with where its client address comes from. One property write, no closure. */
export function markAddressSource(
  request: Request,
  source: AddressSource,
): void {
  (request as any)[SOURCE] = source;
}

/** For the MCP handler: the `clientIp` it was given replaces the app's, keeping the app's peer. */
export function withClientIp(request: Request, clientIp: ClientIp): void {
  const app: AddressSource | undefined = (request as any)[SOURCE];
  markAddressSource(request, { clientIp, server: app?.server ?? noServer });
}
const noServer = () => undefined;

/** The request a context's client address comes from, if it has one; for the envelope `useService` forwards. */
export function clientRequestOf(ctx: object): Request | undefined {
  const request: any =
    (ctx as any)[CLIENT_REQUEST] ?? (ctx as { request?: Request }).request;
  return request?.[SOURCE] ? request : undefined;
}

/** Puts the client request on a forwarded context. */
export function carryClientRequest(envelope: object, from: object): void {
  const request = clientRequestOf(from);
  if (request) (envelope as any)[CLIENT_REQUEST] = request;
}

/**
 * The client address of a call as rate limits count it (see `addressKey`), or
 * `undefined` when it has none: in-process without a request, or `app.handle`
 * without `clientIp`. For a custom `per` that combines it with another key.
 *
 * @throws When `clientIp` returns anything but a non-empty string or `undefined`.
 */
export function clientAddress(ctx: object): string | undefined {
  const request = clientRequestOf(ctx);
  if (!request) return undefined;
  const source: AddressSource = (request as any)[SOURCE];
  const peer = source.server()?.requestIP(request)?.address ?? undefined;
  const ip: unknown = source.clientIp
    ? source.clientIp({ request, peer })
    : peer;
  if (ip !== undefined && (typeof ip !== "string" || ip === ""))
    throw new Error(
      `clientIp must return a non-empty string, or undefined when there is no address; it returned ${ip === "" ? "an empty string" : ip instanceof Promise ? "a promise (it must not be async)" : String(ip)}`,
    );
  return ip === undefined ? undefined : addressKey(ip as string);
}

/**
 * The key of a client address: an IPv4-mapped or NAT64 (`64:ff9b::/96`) IPv6 address as IPv4, any other
 * IPv6 address by its /64 (one client often holds a whole /64), and every
 * spelling of one address the same. An address that does not parse is kept as given.
 */
function addressKey(address: string): string {
  const ip = address.trim().toLowerCase().replace(/%.*$/, "");
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return address;
  const [head = "", tail] = ip.split("::");
  const split = (part: string | undefined) => (part ? part.split(":") : []);
  const left = split(head);
  const right = split(tail);
  const groups = (part: string[]) =>
    part.flatMap((group) => {
      if (!group.includes(".")) return [parseInt(group, 16)];
      const [a, b, c, d] = group.split(".").map(Number) as number[];
      return [(a! << 8) | b!, (c! << 8) | d!];
    });
  const l = groups(left);
  const r = groups(right);
  const all = [...l, ...Array(8 - l.length - r.length).fill(0), ...r];
  // Mapped (::ffff:a.b.c.d) and translated (64:ff9b::a.b.c.d, RFC 6052) IPv4.
  const head6 = all.slice(0, 6).join(":");
  if (head6 === "0:0:0:0:0:65535" || head6 === "100:65435:0:0:0:0")
    return [all[6]! >> 8, all[6]! & 255, all[7]! >> 8, all[7]! & 255].join(".");
  return `${all
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

/** An action's limits, as a list. */
export function rateLimitsOf(config: {
  name: string;
  rateLimit?: RateLimit | readonly RateLimit[];
}): readonly RateLimit[] | undefined {
  const { rateLimit } = config;
  if (rateLimit === undefined) return undefined;
  const limits: readonly RateLimit[] = Array.isArray(rateLimit)
    ? rateLimit
    : [rateLimit as RateLimit];
  if (!limits.length)
    throw new Error(
      `Action '${config.name}': rateLimit is an empty list, which limits nothing. Give it at least one limit, or remove it.`,
    );
  for (const { per, max, windowMs } of limits)
    if (
      !(per === "actor" || per === "ip" || typeof per === "function") ||
      !Number.isSafeInteger(max) ||
      max < 1 ||
      !Number.isSafeInteger(windowMs) ||
      windowMs < 1
    )
      throw new Error(
        `Action '${config.name}': each rateLimit needs per ("actor", "ip" or a function) and max and windowMs as positive integers`,
      );
  return limits;
}

/**
 * Checks at startup what an action's limits need: a key-value storage among
 * the deps, and an `identity` hook for `per: "actor"`.
 */
export function checkRateLimits(
  service: Service<any, any>,
  action: { name: string; config: { name: string; rateLimit?: any } },
  deps: Readonly<Record<string, unknown>>,
): void {
  const limits = rateLimitsOf(action.config);
  if (!limits) return;
  if (!storageOf(service, deps)) throw noStorage(service, action.name);
  if (limits.some((limit) => limit.per === "actor") && !hasIdentity(service))
    throw new Error(
      `Service "${service.name}": action '${action.name}' limits per "actor", but the service declares no identity. Add identity: (ctx) => ctx.user && { id: ctx.user.id } to defineService("${service.name}", { ... }).`,
    );
}

/** The storage limits count in: the plugin install's (or the call's deps'), else the service's own. */
function storageOf(
  service: Service<any, any>,
  deps: Readonly<Record<string, unknown>>,
): KeyValueStorage | undefined {
  return serviceStorage(service, deps) ?? serviceStorage(service);
}

function noStorage(service: Service<any, any>, action: string): Error {
  return new Error(
    `Service "${service.name}": action '${action}' declares rateLimit, but the service has no key-value storage to count in. Add one: defineService("${service.name}", { deps: { cache: defineStorage({ driver: redis() }) } }).`,
  );
}

/**
 * While a storage is unavailable, limits count in this process's memory. The
 * fallback starts at the first `StorageUnavailableError`, tries the storage at
 * most once a second meanwhile, and ends once the storage has answered without
 * error for `QUIET_MS`. Its counters are kept until their window ends, so a
 * storage that flaps never resets them: per window, a key passes at most `max`
 * in memory plus `max` in the storage.
 */
interface Fallback {
  active: boolean;
  counters: Map<string, { count: number; expiresAt: number }>;
  /** When the storage may be tried next. */
  probeAt: number;
  /** Since when every try has succeeded. */
  healthySince?: number;
  /** When expired counters are swept next. */
  sweepAt: number;
}
const QUIET_MS = 10_000;
const PROBE_MS = 1_000;
const SWEEP_MS = 1_000;
const fallbacks = new WeakMap<KeyValueStorage, Fallback>();

function countInMemory(
  fallback: Fallback,
  key: string,
  windowMs: number,
  now: number,
): Counter {
  if (now >= fallback.sweepAt) sweep(fallback, now);
  let entry = fallback.counters.get(key);
  if (!entry || entry.expiresAt <= now)
    fallback.counters.set(
      key,
      (entry = { count: 0, expiresAt: now + windowMs }),
    );
  entry.count++;
  return {
    count: entry.count,
    expiresInMs: Math.max(1, entry.expiresAt - now),
  };
}

// Swept on the next call after SWEEP_MS, so no timer keeps the process alive.
function sweep(fallback: Fallback, now: number): void {
  for (const [key, entry] of fallback.counters)
    if (entry.expiresAt <= now) fallback.counters.delete(key);
  fallback.sweepAt = now + SWEEP_MS;
}

/** Tries the storage once, without waiting for it, and leaves the fallback after QUIET_MS of answers. */
function probe(
  storage: KeyValueStorage,
  fallback: Fallback,
  key: string,
  windowMs: number,
): void {
  const answered = () => {
    const now = Date.now();
    fallback.healthySince ??= now;
    if (fallback.active && now - fallback.healthySince >= QUIET_MS) {
      fallback.active = false;
      console.warn(
        "[Brick-TS] Rate limits: storage is back; counting there again.",
      );
    }
  };
  storage.increment(key, windowMs).then(answered, (error) => {
    if (error instanceof StorageUnavailableError)
      fallback.healthySince = undefined;
    else answered();
  });
}

async function increment(
  storage: KeyValueStorage,
  key: string,
  windowMs: number,
): Promise<Counter> {
  let fallback = fallbacks.get(storage);
  if (fallback) {
    const now = Date.now();
    if (fallback.active) {
      if (now >= fallback.probeAt) {
        fallback.probeAt = now + PROBE_MS;
        probe(storage, fallback, key, windowMs);
      }
      return countInMemory(fallback, key, windowMs, now);
    }
    if (now >= fallback.sweepAt) {
      sweep(fallback, now);
      if (!fallback.counters.size) fallbacks.delete(storage);
    }
  }
  try {
    return await storage.increment(key, windowMs);
  } catch (error) {
    if (!(error instanceof StorageUnavailableError)) throw error;
    const now = Date.now();
    fallback = fallbacks.get(storage);
    if (!fallback)
      fallbacks.set(
        storage,
        (fallback = {
          active: false,
          counters: new Map(),
          probeAt: 0,
          sweepAt: now + SWEEP_MS,
        }),
      );
    if (!fallback.active) {
      Object.assign(fallback, {
        active: true,
        probeAt: now + PROBE_MS,
        healthySince: undefined,
      });
      console.warn(
        `[Brick-TS] Rate limits: storage is unavailable (${error.message}); counting in this process's memory until it is back.`,
      );
    }
    return countInMemory(fallback, key, windowMs, now);
  }
}

/** The key of one limit for a call, or undefined to skip the limit. */
async function keyOf(
  limit: RateLimit,
  input: unknown,
  ctx: ActionContext,
): Promise<string[] | undefined> {
  if (typeof limit.per === "function") {
    const key = limit.per({ input, ctx });
    return key == null ? undefined : ["key", String(key)];
  }
  if (limit.per === "actor") {
    const identity = await identityOf(ctx);
    if (identity) return ["actor", identity.id];
  }
  const ip = clientAddress(ctx);
  return ip === undefined ? undefined : ["ip", ip];
}

/**
 * The rate-limit stage: counts the call against each limit in order, and
 * refuses it (429, `RATE_LIMITED`) at the first limit over its `max`.
 */
export async function enforceRateLimits(
  service: Service<any, any> | undefined,
  kind: "action" | "tool",
  action: string,
  limits: readonly RateLimit[],
  input: unknown,
  ctx: ActionContext,
): Promise<void> {
  if (!service)
    throw new Error(
      `Action '${action}' declares rateLimit, but it is not registered on a service`,
    );
  const storage = storageOf(service, ctx.deps as any);
  if (!storage) throw noStorage(service, action);
  for (const [index, limit] of limits.entries()) {
    const key = await keyOf(limit, input, ctx);
    if (!key) continue;
    const { count, expiresInMs } = await increment(
      storage,
      storageKey("rate-limit", [service.name, kind, action, index, ...key]),
      limit.windowMs,
    );
    if (count > limit.max) {
      const retryAfterSeconds = Math.max(1, Math.ceil(expiresInMs / 1000));
      throw new ActionExecutionError(
        "RATE_LIMITED",
        `Too many calls to '${action}'; retry in ${retryAfterSeconds} s`,
        429,
        { retryAfterSeconds },
      );
    }
  }
}
