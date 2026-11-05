import type { Redis } from "ioredis";
import { describe, expect, vi } from "vitest";
import { keys } from "../src/keys.js";

/** The Redis test/global-setup.ts started; unset on win32, which has no Docker. */
export const redisUrl = process.env.REDIS_TEST_URL ?? "";
if (!redisUrl)
  console.warn(
    "Redis world tests skipped: REDIS_TEST_URL is unset (test/global-setup.ts starts a container except on win32)",
  );
/** `describe` for suites that need Redis: skipped, with the warning above, without one. */
export function describeRedis(name: string, body: () => void): void {
  (redisUrl ? describe : describe.skip)(name, body);
}

/** Waits until `count` streamers on `keyPrefix` listen for its stream notifications. */
export function subscribed(redis: Redis, keyPrefix: string, count: number) {
  return vi.waitFor(async () => {
    const [, n] = (await redis.pubsub(
      "NUMSUB",
      keys(keyPrefix).streamChannel,
    )) as [string, number];
    expect(n).toBeGreaterThanOrEqual(count);
  });
}

/** A promise and the function that settles it. */
export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Holds the next `method` call on `client` whose arguments match, after Redis
 * answered and before the caller sees the answer, until `release()`.
 */
export function pauseAfter<C extends object>(
  client: C,
  method: keyof C & string,
  match: (...args: any[]) => boolean = () => true,
) {
  const reached = gate();
  const hold = gate();
  const orig = (client as any)[method].bind(client);
  let armed = true;
  (client as any)[method] = async (...args: unknown[]) => {
    const value = await orig(...args);
    if (armed && match(...args)) {
      armed = false;
      reached.release();
      await hold.promise;
    }
    return value;
  };
  return {
    reached: reached.promise,
    release: hold.release,
    restore: () => {
      (client as any)[method] = orig;
    },
  };
}

// Fulfilled entries are ignored; callers assert their own count separately.
export function expectRejectedWith(
  results: readonly PromiseSettledResult<unknown>[],
  errorName: string,
): void {
  for (const result of results) {
    if (result.status === "rejected") {
      expect(result.reason).toMatchObject({ name: errorName });
    }
  }
}
