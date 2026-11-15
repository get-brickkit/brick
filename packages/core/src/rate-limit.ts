import {
  ActionExecutionError,
  type ActionContext,
  type Service,
} from "./types";
import { hasIdentity, identityOf } from "./identity";
import {
  memory,
  serviceStorage,
  StorageUnavailableError,
  type Counter,
  type KeyValueDriver,
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

/** Where an app finds the client address, given the request and the socket peer. */
export type ClientIp = (args: {
  request: Request;
  peer: string | undefined;
}) => string | null | undefined;

/** On a call's context: a function that returns the client address, if the call has one. */
export const CLIENT_IP = Symbol.for("brickkit.clientIp");
/** On a rate-limited route's request context: the app's `clientIp` option. */
export const APP_CLIENT_IP = Symbol.for("brickkit.app.clientIp");

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
  return limits.length ? limits : undefined;
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
  if (!serviceStorage(service, deps)) throw noStorage(service, action.name);
  if (limits.some((limit) => limit.per === "actor") && !hasIdentity(service))
    throw new Error(
      `Service "${service.name}": action '${action.name}' limits per "actor", but the service declares no identity. Add identity: (ctx) => ctx.user && { id: ctx.user.id } to defineService("${service.name}", { ... }).`,
    );
}

function noStorage(service: Service<any, any>, action: string): Error {
  return new Error(
    `Service "${service.name}": action '${action}' declares rateLimit, but the service has no key-value storage to count in. Add one: defineService("${service.name}", { deps: { cache: defineStorage({ driver: redis() }) } }).`,
  );
}

/** Per storage: the process-memory counters used while it is down. */
const fallbacks = new WeakMap<KeyValueStorage, KeyValueDriver>();

async function increment(
  storage: KeyValueStorage,
  key: string,
  windowMs: number,
): Promise<Counter> {
  try {
    const counter = await storage.increment(key, windowMs);
    if (fallbacks.delete(storage))
      console.warn(
        "[Brick-TS] Rate limits: storage is back; counting there again.",
      );
    return counter;
  } catch (error) {
    if (!(error instanceof StorageUnavailableError)) throw error;
    let counters = fallbacks.get(storage);
    if (!counters) {
      console.warn(
        `[Brick-TS] Rate limits: storage is unavailable (${error.message}); counting in this process's memory until it is back.`,
      );
      fallbacks.set(storage, (counters = memory()));
    }
    return counters.increment(key, windowMs);
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
  const ip = (ctx as { [CLIENT_IP]?: () => string | undefined })[CLIENT_IP]?.();
  return ip ? ["ip", ip] : undefined;
}

/**
 * The rate-limit stage: counts the call against each limit in order, and
 * refuses it (429, `RATE_LIMITED`) at the first limit over its `max`.
 */
export async function enforceRateLimits(
  service: Service<any, any> | undefined,
  action: string,
  limits: readonly RateLimit[],
  input: unknown,
  ctx: ActionContext,
): Promise<void> {
  if (!service)
    throw new Error(
      `Action '${action}' declares rateLimit, but it is not registered on a service`,
    );
  const storage = serviceStorage(service, ctx.deps as any);
  if (!storage) throw noStorage(service, action);
  for (const [index, limit] of limits.entries()) {
    const key = await keyOf(limit, input, ctx);
    if (!key) continue;
    // JSON keeps the parts apart, whatever separators or newlines a key holds.
    const { count, expiresInMs } = await increment(
      storage,
      `rate-limit:${JSON.stringify([service.name, action, index, ...key])}`,
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
