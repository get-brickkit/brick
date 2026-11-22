import { Context, Effect } from "effect";
import { defineAction, defineListener, defineService, t } from "../src";

class Mailer extends Context.Service<Mailer, { send: () => void }>()(
  "Mailer",
) {}

const needsMailer = Effect.gen(function* () {
  yield* Mailer;
  return { sum: 1 };
});

const output = t.Object({ sum: t.Number() });

// The output type is checked against what the Effect succeeds with.
const sum = defineAction({
  name: "sum",
  input: t.Object({ a: t.Number() }),
  output,
  execute: ({ input, error }) =>
    Effect.gen(function* () {
      if (input.a < 0) return error.BAD_REQUEST("negative");
      return { sum: yield* Effect.succeed(input.a) };
    }),
});
sum.run({ a: 1 }).then((result) => {
  const n: number = result.sum;
  void n;
});

defineAction({
  name: "wrong",
  output,
  // @ts-expect-error The Effect succeeds with a string, not a number.
  execute: () => Effect.succeed({ sum: "no" }),
});

// An Effect that needs a service has not been provided one.
defineAction({
  name: "needs",
  output,
  // @ts-expect-error `Mailer` is required, so the Effect cannot run.
  execute: () => needsMailer,
});

defineAction({
  name: "provided",
  output,
  execute: () => needsMailer.pipe(Effect.provideService(Mailer, { send() {} })),
});

// The service's context hook infers `ctx` from an Effect, and so does authorize.
defineService("effects", {
  context: () => Effect.succeed({ user: { id: "u" } }),
}).action({
  name: "who",
  authorize: ({ user }) => Effect.succeed(!!user),
  execute: ({ ctx }) => Effect.succeed(ctx.user.id),
});

defineListener({
  name: "listener",
  on: "x",
  run: () => Effect.void,
});
defineListener({
  name: "needs-mailer",
  on: "x",
  // @ts-expect-error `Mailer` is required, so the Effect cannot run.
  run: () => needsMailer,
});

// The real effect module fits what `useEffectRuntime` takes.
import { Cause as RealCause, Effect as RealEffect } from "effect";
import { useEffectRuntime } from "../src";
useEffectRuntime({ Effect: RealEffect, Cause: RealCause });

// A plugin endpoint may return an Effect, but not one that still needs services.
import { defineServicePlugin } from "../src";
declare const needsMailerEffect: Effect.Effect<string, never, Mailer>;
defineServicePlugin({
  name: "endpoint_types",
  setup({ routes }) {
    routes.endpoint({
      name: "ok",
      method: "GET",
      path: "/ok",
      handler: () => Effect.succeed("ok"),
    });
    routes.endpoint({
      name: "needs",
      method: "GET",
      path: "/needs",
      // @ts-expect-error an Effect that needs a service is not runnable
      handler: () => needsMailerEffect,
    });
  },
});
