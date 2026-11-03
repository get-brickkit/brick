// Typed errors for workflow steps. Imported by workflow code that the Workflow
// SDK bundles and runs in its sandbox: nothing here may import Node or the server.
import type { ListenerFailure } from "./events/types";
import type { ActionErrorDefinition, ErrorDetails } from "./types";
import type { TSchema } from "@sinclair/typebox";

// Pure TypeBox builders, so error `details` schemas can be declared in workflow code.
export { Type as t } from "@sinclair/typebox";

const NAME = "BrickStepError";

/**
 * Define a reusable error. Spread it into the `errors` of any action, listener,
 * command, socket or step; give it a `details` schema and
 * `error.CODE(message, details)` checks the details against it in types. The
 * details are not validated at runtime.
 *
 * @example
 * const SlugExists = defineError("SLUG_EXISTS", {
 *   status: 409,
 *   message: "Slug is already taken",
 *   details: t.Object({ slug: t.String() }),
 * });
 * // errors: { ...SlugExists }  then  error.SLUG_EXISTS(undefined, { slug })
 */
export function defineError<
  const TCode extends string,
  TDetails extends TSchema | undefined = undefined,
>(
  code: TCode,
  definition: { status?: number; message: string; details?: TDetails },
): {
  [K in TCode]: { status?: number; message: string } & (TDetails extends TSchema
    ? { details: TDetails }
    : {});
} {
  return { [code]: definition } as any;
}

/** What a step error carries across the Workflow SDK, which keeps only an error's name, message, stack and cause. */
interface StepErrorEnvelope {
  code: string;
  status: number;
  details?: unknown;
  cause?: unknown;
}

/** The `error` helpers of a step: one per declared code, each throws a step error that is not retried. */
export type StepErrorBuilder<
  TErrors extends Record<string, ActionErrorDefinition>,
> = {
  [K in keyof TErrors]: TErrors[K] extends { details: TSchema }
    ? (
        message: string | undefined,
        details: ErrorDetails<TErrors[K]>,
        options?: ErrorOptions,
      ) => never
    : (message?: string, details?: unknown, options?: ErrorOptions) => never;
};

/**
 * Helpers that raise typed errors from a workflow step: `error.CODE(message?,
 * details?)`, as in an action or listener. A declared error is an outcome, not
 * a glitch, so the Workflow SDK does not retry the step: the workflow's `await`
 * rejects at once. Read it in the workflow with {@link stepFailure}.
 *
 * @param errors - The codes the step can raise: `defineError(...)` results or
 * `errorsOf(action)`, spread into one object.
 * @returns One helper per code. Each always throws.
 * @example
 * import { stepErrors } from "@brickkit/core/workflow";
 *
 * export const carrierErrors = { ...CarrierRejected };
 * const error = stepErrors(carrierErrors);
 *
 * async function bookCarrier(orderId: string) {
 *   "use step";
 *   const booking = await carrier.book(orderId);
 *   if (!booking.ok) error.CARRIER_REJECTED(undefined, { reason: booking.reason });
 *   return booking.trackingId;
 * }
 */
export function stepErrors<
  const TErrors extends Record<string, ActionErrorDefinition>,
>(errors: TErrors): StepErrorBuilder<TErrors> {
  const helpers: Record<string, unknown> = {};
  for (const [code, definition] of Object.entries(errors))
    helpers[code] = (
      message?: string,
      details?: unknown,
      options?: ErrorOptions,
    ) => {
      const envelope: StepErrorEnvelope = {
        code,
        status: definition.status ?? 400,
        ...(details !== undefined ? { details } : {}),
        ...(options && "cause" in options ? { cause: options.cause } : {}),
      };
      const error = new Error(message || definition.message, {
        cause: envelope,
      });
      error.name = NAME;
      // `FatalError.is()` checks this: the step fails without retries.
      throw Object.assign(error, { fatal: true });
    };
  return helpers as StepErrorBuilder<TErrors>;
}

/**
 * Read a failed step in the workflow: the typed error it raised with
 * {@link stepErrors}, or `{ code: "UNKNOWN", message, cause }` for anything
 * else (a step that threw something undeclared, or ran out of retries). The
 * same shape a listener's `retry` receives.
 *
 * @param error - What the workflow caught from `await step()`.
 * @param errors - The codes to recognize: the same object given to `stepErrors`.
 * @returns A union with one member per declared code, narrowed by `code`.
 * @example
 * try {
 *   await bookCarrier(order.id);
 * } catch (caught) {
 *   const failure = stepFailure(caught, carrierErrors);
 *   if (failure.code !== "CARRIER_REJECTED") throw caught;
 *   await notifyCustomer(order, failure.details.reason);
 * }
 */
export function stepFailure<
  const TErrors extends Record<string, ActionErrorDefinition>,
>(error: unknown, errors: TErrors): ListenerFailure<TErrors> {
  const { name, message, cause } = (
    error !== null && typeof error === "object" ? error : {}
  ) as { name?: unknown; message?: unknown; cause?: unknown };
  const envelope =
    name === NAME && cause !== null && typeof cause === "object"
      ? (cause as Partial<StepErrorEnvelope>)
      : undefined;
  const code = envelope?.code;
  if (typeof code === "string" && Object.hasOwn(errors, code))
    return {
      code,
      message: String(message),
      details: envelope!.details,
    } as ListenerFailure<TErrors>;
  return {
    code: "UNKNOWN",
    message: typeof message === "string" ? message : String(error),
    cause: error,
  };
}
