import { expect, test } from "bun:test";
import { defineError, t } from "../src";
import { stepErrors, stepFailure } from "../src/workflow";

const CarrierRejected = defineError("CARRIER_REJECTED", {
  status: 422,
  message: "The carrier refused the parcel",
  details: t.Object({ reason: t.String() }),
});
const errors = { ...CarrierRejected, PLAIN: { message: "Plain" } };
const error = stepErrors(errors);

const caught = (fn: () => unknown): Error & Record<string, unknown> => {
  try {
    fn();
  } catch (thrown) {
    return thrown as Error & Record<string, unknown>;
  }
  throw new Error("did not throw");
};

/** What the Workflow SDK keeps of a step error: name, message, stack and cause. */
const acrossSdk = (thrown: Error) =>
  Object.assign(new Error(thrown.message, { cause: thrown.cause }), {
    name: thrown.name,
  });

test("a declared step error is fatal, so the Workflow SDK does not retry it", () => {
  const thrown = caught(() =>
    error.CARRIER_REJECTED(undefined, { reason: "oversize" }),
  );
  // FatalError.is() from @workflow/errors: name "FatalError" or fatal === true.
  expect(thrown.fatal).toBe(true);
  expect(thrown.message).toBe("The carrier refused the parcel");
});

test("the workflow reads the typed failure, before and after the SDK serializes it", () => {
  const root = new Error("socket hang up");
  const thrown = caught(() =>
    error.CARRIER_REJECTED("Too big", { reason: "oversize" }, { cause: root }),
  );
  for (const seen of [thrown, acrossSdk(thrown)]) {
    const failure = stepFailure(seen, errors);
    expect(failure).toEqual({
      code: "CARRIER_REJECTED",
      message: "Too big",
      details: { reason: "oversize" },
    });
    if (failure.code === "CARRIER_REJECTED") {
      const reason: string = failure.details.reason;
      expect(reason).toBe("oversize");
    }
  }
  expect((thrown.cause as { cause: unknown }).cause).toBe(root);
  expect(
    stepFailure(
      caught(() => error.PLAIN()),
      errors,
    ),
  ).toEqual({
    code: "PLAIN",
    message: "Plain",
    details: undefined,
  });
});

test("anything else is UNKNOWN, including codes the workflow did not list", () => {
  const plain = new Error("boom");
  expect(stepFailure(plain, errors)).toEqual({
    code: "UNKNOWN",
    message: "boom",
    cause: plain,
  });
  const other = caught(() => stepErrors({ OTHER: { message: "x" } }).OTHER());
  expect(stepFailure(other, errors).code).toBe("UNKNOWN");
  expect(stepFailure("text", errors)).toMatchObject({
    code: "UNKNOWN",
    message: "text",
  });
});
