import { createHash } from "node:crypto";
import { encodeTime, ulid } from "ulid";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_TIME = 2 ** 48 - 1;
const MAX_KEY_LENGTH = 1024;

function keyedRandomness(key: string): string {
  const digest = createHash("sha256").update(key).digest();
  let bits = 0n;
  for (let index = 0; index < 10; index++)
    bits = (bits << 8n) | BigInt(digest[index]);
  let out = "";
  for (let group = 15; group >= 0; group--)
    out += CROCKFORD[Number((bits >> BigInt(group * 5)) & 31n)];
  return out;
}

/**
 * The run id the SDK asks the world for when a run starts. Without options it is
 * a fresh ULID. With `runKey` and `runKeyTime` it is the same ULID every time, so
 * starting the same run twice creates one run: the second start finds it already
 * there.
 *
 * The id is a real ULID. Its time is `runKeyTime`, not the clock, because the SDK
 * seeds a workflow's clock from the time in its run id. Pass the time the run is
 * for, such as when the event it handles happened, and the same time on every
 * attempt.
 *
 * @param options - The options given to `start()`. `runKey` is a non-empty string
 * that names the run (at most 1024 characters), and `runKeyTime` is milliseconds
 * since the epoch.
 * @returns The id without its `wrun_` prefix, which the SDK adds.
 * @throws When `runKey` is not a usable string, or comes without a valid `runKeyTime`.
 */
export function createRunId(
  options?: Readonly<Record<string, unknown>>,
): string {
  const key = options?.runKey;
  if (key === undefined) return ulid();
  if (typeof key !== "string" || !key || key.length > MAX_KEY_LENGTH)
    throw new TypeError(
      `runKey must be a non-empty string of at most ${MAX_KEY_LENGTH} characters`,
    );
  const time = options?.runKeyTime;
  if (
    typeof time !== "number" ||
    !Number.isInteger(time) ||
    time < 0 ||
    time > MAX_TIME
  )
    throw new TypeError(
      "runKey needs runKeyTime, the time the run is for in milliseconds since the epoch, so the run id stays a valid ULID with a true time",
    );
  return encodeTime(time, 10) + keyedRandomness(key);
}

/**
 * The idempotency key for the message that starts a run, which is the only
 * message that carries the run's input. `start()` sends no key of its own, so a
 * second start of the same run would otherwise queue a second first delivery.
 *
 * The key only covers a first message that is still queued or running. Once the
 * run has started, the queue does not enqueue the message at all (see
 * `runHasStarted` in `createWorldQueue`): the runtime runs a run's first step from the
 * first message, in parallel with `run_created`, so a late second one would run
 * that step's code again.
 *
 * @param message - The queue payload.
 * @returns A key for a run's first message, and `undefined` for every other message.
 */
export function initialMessageKey(message: unknown): string | undefined {
  const { runId, runInput } = (message ?? {}) as {
    runId?: unknown;
    runInput?: unknown;
  };
  return typeof runId === "string" && runInput !== undefined
    ? `start:${runId}`
    : undefined;
}
