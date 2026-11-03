import {
  defineError,
  stepErrors,
  stepFailure,
  t,
} from "@brickkit/core/workflow";

export const parcelErrors = {
  ...defineError("CARRIER_REJECTED", {
    status: 422,
    message: "The carrier refused the parcel",
    details: t.Object({ reason: t.String() }),
  }),
};
const error = stepErrors(parcelErrors);

export const seen: { attempts: number; failure?: unknown } = { attempts: 0 };

/** Books a parcel the carrier refuses, and records what the workflow caught. */
export async function shipParcel(_event: unknown) {
  "use workflow";
  try {
    await book();
  } catch (caught) {
    await record(stepFailure(caught, parcelErrors));
  }
}

async function book() {
  "use step";
  seen.attempts++;
  error.CARRIER_REJECTED(undefined, { reason: "oversize" });
}

async function record(failure: unknown) {
  "use step";
  seen.failure = failure;
}
