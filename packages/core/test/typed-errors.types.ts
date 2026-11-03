import {
  defineAction,
  defineError,
  defineListener,
  stepErrors,
  stepFailure,
  t,
} from "../src";

const SlugExists = defineError("SLUG_EXISTS", {
  status: 409,
  message: "Slug is already taken",
  details: t.Object({ slug: t.String(), takenBy: t.String() }),
});

defineAction({
  name: "create",
  errors: { ...SlugExists, PLAIN: { status: 400, message: "Plain" } },
  execute: ({ error }) => {
    error.SLUG_EXISTS(undefined, { slug: "a", takenBy: "u_1" });
    // @ts-expect-error details must match the schema
    error.SLUG_EXISTS(undefined, { slug: 1 });
    // @ts-expect-error a declared details schema requires details
    error.SLUG_EXISTS();
    error.PLAIN("x", { anything: true });
  },
});

defineListener({
  name: "typed",
  on: "x",
  errors: { ...SlugExists },
  retry: (error) => {
    if (error.code === "SLUG_EXISTS") {
      const takenBy: string = error.details.takenBy;
      void takenBy;
      return "dead";
    }
    // @ts-expect-error the fallback has no details
    void error.details;
    return "retry";
  },
  run: (_delivery, { error }) => {
    // @ts-expect-error details are required by the schema
    error.SLUG_EXISTS();
  },
});

const step = stepErrors({ ...SlugExists, PLAIN: { message: "Plain" } });
step.SLUG_EXISTS(undefined, { slug: "a", takenBy: "u_1" });
// @ts-expect-error details must match the schema
step.SLUG_EXISTS(undefined, { slug: 1 });
// @ts-expect-error a step raises only the codes it declared
step.NOT_FOUND();
step.PLAIN();
const failure = stepFailure(new Error(), { ...SlugExists });
if (failure.code === "SLUG_EXISTS") {
  const takenBy: string = failure.details.takenBy;
  void takenBy;
}
