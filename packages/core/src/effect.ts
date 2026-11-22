/** An Effect (effect@4) that succeeds with `A` and needs no services. */
export type EffectOf<A> = {
  readonly "~effect/Effect": {
    readonly _A: (_: never) => A;
    readonly _R: (_: never) => never;
  };
};

/** What a callback may return: the value, a Promise of it, or an Effect (effect@4) that succeeds with it. */
export type Returns<A> = A | Promise<A> | EffectOf<A>;

/**
 * Any value but an Effect that still needs services, for callbacks whose result
 * is open: `Returns<unknown>` would collapse to `unknown` and let such an Effect
 * through. A result typed `unknown` must be narrowed (or cast) first.
 */
export type NotEffect =
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | (object & { readonly "~effect/Effect"?: never });

const isEffect = (value: unknown): value is EffectOf<unknown> =>
  typeof value === "object" && value !== null && "~effect/Effect" in value;

/** The parts of `effect` Brick runs Effects with, typed here so apps without effect never resolve it. */
type EffectRuntime = {
  Effect: {
    runPromiseExit(
      effect: any,
    ): Promise<
      { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: any }
    >;
  };
  Cause: { squash(cause: any): unknown };
};
let effectModule: Promise<EffectRuntime> | undefined;

/**
 * Run Effects with this copy of `effect` instead of importing it at run time.
 * `brick build` calls it so the bundle carries the app's own copy.
 */
export function useEffectRuntime(runtime: EffectRuntime): void {
  effectModule = Promise.resolve(runtime);
}
// A variable specifier keeps `brick build` from failing, or bundling effect, when an app does not use it.
const SPECIFIER = "effect";

/**
 * The value a callback returned, with an Effect run first: a value or Promise
 * comes back as it is, so a synchronous callback stays synchronous. A failed
 * Effect throws the original error, so it is mapped as a thrown one is.
 */
export function settle<T>(value: Returns<T>): T | Promise<T> {
  if (!isEffect(value)) return value as T | Promise<T>;
  return (async () => {
    const { Effect, Cause } = await (effectModule ??= import(SPECIFIER)).catch(
      (cause) => {
        throw new Error(
          "A callback returned an Effect, but the `effect` package could not be loaded; install effect@4.",
          { cause },
        );
      },
    );
    const exit = await Effect.runPromiseExit(value as any);
    if (exit._tag === "Success") return exit.value as T;
    throw Cause.squash(exit.cause);
  })();
}
