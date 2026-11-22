import { Context, Data, Effect, Layer, Schedule } from "effect";

/** The target did not answer in time, or not at all. */
export class ProbeFailed extends Data.TaggedError("ProbeFailed")<{
  readonly reason: string;
}> {}

/** One answer from a target. `latencyMs` times the attempt that answered. */
export interface Answer {
  status: number;
  latencyMs: number;
}

/** Reaches a URL. The app runs it through a Layer, so tests swap in a fake. */
export class Probe extends Context.Service<
  Probe,
  { readonly get: (url: string) => Effect.Effect<Answer, ProbeFailed> }
>()("Probe") {}

const attempt = (url: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      const started = performance.now();
      const response = await fetch(url, { signal, redirect: "manual" });
      await response.body?.cancel();
      return {
        status: response.status,
        latencyMs: Math.round(performance.now() - started),
      };
    },
    catch: (cause) => new ProbeFailed({ reason: String(cause) }),
  }).pipe(
    Effect.timeout(5_000),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(new ProbeFailed({ reason: "timed out after 5s" })),
    ),
  );

/** `fetch` with a timeout, retried twice; only the attempt that answered is timed. */
export const liveProbe = Layer.succeed(Probe, {
  get: (url) =>
    attempt(url).pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced("500 millis") }),
    ),
});
