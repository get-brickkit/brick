import { isEventRef, type EventRef } from "./catalog";
import { buildErrorHelpers } from "../action";
import { PLUGIN_DEPS } from "../deps";
import type { ActionErrorDefinition, ErrorBuilder } from "../types";
import type {
  EventDelivery,
  EventListener,
  EventWorkflow,
  ListenerFailure,
  RetryDecision,
} from "./types";

type EventOn = EventRef<any> | readonly EventRef<any>[];
type PayloadOf<O> =
  O extends EventRef<infer P>
    ? P
    : O extends readonly EventRef<infer P>[]
      ? P
      : never;

type ListenerConfig<
  TPayload,
  TOn = string | readonly string[],
  TErrors extends Record<string, ActionErrorDefinition> = {},
> = {
  name: string;
  on: TOn;
  maxAttempts?: number;
  /** Errors `run` may raise with `error.CODE()`. Spread `defineError(...)` results or `errorsOf(action)` here. */
  errors?: TErrors;
  /** Decides what a failure does next. Without it every failure retries until `maxAttempts`. */
  retry?: (error: ListenerFailure<TErrors>) => RetryDecision;
} & (
  | {
      run: (
        delivery: EventDelivery<TPayload>,
        helpers: { error: ErrorBuilder<TErrors> },
      ) => void | Promise<void>;
      workflow?: never;
    }
  | { workflow: EventWorkflow<TPayload>; run?: never }
);

/**
 * Define a listener: code that runs for each event it listens for, after the write
 * that caused the event has been committed. Pass it to `brick({ events: {
 * listeners } })`.
 *
 * It either runs a handler (`run`) in the process that delivers events, or starts
 * a durable workflow (`workflow`) on the app's `events.world`. Delivery is at
 * least once. A handler that throws is retried later with a growing delay, then
 * parked as dead, so it can run again for the same event: use
 * `delivery.deliveryId` to make its work idempotent. A workflow needs no such
 * care: a delivery starts one run however often it is tried, and the workflow
 * retries its own steps.
 *
 * A listener can declare `errors`, as an action does, and raise them in `run` with
 * `error.CODE()`. `retry(error)` then picks `"retry"` or `"dead"` from the typed
 * `error.code`; anything not declared arrives as `{ code: "UNKNOWN", cause }`.
 *
 * @param config - `name` (unique; it is part of each delivery's id), `on` (a
 * declared event such as `orders.events.shipped`, which types the payload, or an
 * event name; or a list of either; a trailing `*` matches a prefix, as in
 * `user.*`), `run` or `workflow`, and optionally `maxAttempts`.
 * @returns The listener.
 * @throws When the name is empty or contains `:`, `on` is empty, or the listener
 * has both or neither of `run` and `workflow`.
 * @example
 * import { brick, defineListener } from "@brickkit/core";
 *
 * const welcome = defineListener({
 *   name: "welcome-email",
 *   on: "user.create",
 *   run: async ({ payload, deliveryId }) => {
 *     await mailer.sendWelcome(payload.row.email, { idempotencyKey: deliveryId });
 *   },
 * });
 *
 * export default brick({ services, events: { listeners: [welcome] } });
 * @example
 * // src/workflows/onboard.ts
 * export async function onboard(event: WorkflowEvent<CrudEventPayload>) {
 *   "use workflow";
 *   await sendWelcome(event.payload.row.email);
 * }
 *
 * defineListener({ name: "onboard", on: "user.create", workflow: onboard });
 * @example
 * // payload is { id: string; trackingId: string }, from the orders catalog.
 * defineListener({
 *   name: "notify-shipped",
 *   on: orders.events.shipped,
 *   run: ({ payload }) => notify(payload.id, payload.trackingId),
 * });
 */
export function defineListener<
  const TOn extends EventOn,
  const TErrors extends Record<string, ActionErrorDefinition> = {},
>(
  config: ListenerConfig<PayloadOf<TOn>, TOn, TErrors>,
): EventListener<PayloadOf<TOn>>;
export function defineListener<
  TPayload = any,
  const TErrors extends Record<string, ActionErrorDefinition> = {},
>(
  config: ListenerConfig<
    TPayload,
    string | EventRef<any> | readonly (string | EventRef<any>)[],
    TErrors
  >,
): EventListener<TPayload>;
export function defineListener(
  config: ListenerConfig<any, unknown, any>,
): EventListener {
  const on = (Array.isArray(config.on) ? config.on : [config.on]).map(
    (item: unknown) => (isEventRef(item) ? item.name : item),
  ) as string[];
  validateListener({ ...config, on } as EventListener);
  const helpers = buildErrorHelpers(config.errors);
  return Object.freeze({
    name: config.name,
    on: Object.freeze(on),
    ...(config.run !== undefined
      ? {
          run: ((delivery: EventDelivery) =>
            config.run!(delivery, { error: helpers })) as EventListener["run"],
        }
      : {}),
    ...(config.errors ? { errors: config.errors } : {}),
    ...(config.retry ? { retry: config.retry } : {}),
    ...(config.workflow !== undefined ? { workflow: config.workflow } : {}),
    ...(config.maxAttempts !== undefined
      ? { maxAttempts: config.maxAttempts }
      : {}),
  });
}

/**
 * @throws When the name is empty or contains `:`, `on` is empty, `maxAttempts`
 * is not a positive integer, or the listener has both or neither of `run` and
 * `workflow`.
 */
export function validateListener(listener: EventListener): void {
  const { name, on, maxAttempts, run, workflow } = listener;
  if (typeof name !== "string" || !name)
    throw new Error("An event listener needs a name");
  // A listener's name ends its delivery ids: see `deliveryId`.
  if (name.includes(":"))
    throw new Error(`Event listener name '${name}' must not contain ':'`);
  if (
    !Array.isArray(on) ||
    !on.length ||
    on.some((pattern) => !pattern || typeof pattern !== "string")
  )
    throw new Error(`Event listener '${name}' listens for nothing`);
  if (
    maxAttempts !== undefined &&
    (!Number.isInteger(maxAttempts) || maxAttempts < 1)
  )
    throw new Error(
      `Event listener '${name}': maxAttempts must be a positive integer`,
    );
  if (run !== undefined && workflow !== undefined)
    throw new Error(
      `Event listener '${name}' has both run and workflow; give it one`,
    );
  if (run === undefined && workflow === undefined)
    throw new Error(
      `Event listener '${name}' needs a run handler or a workflow`,
    );
  if (run !== undefined && typeof run !== "function")
    throw new Error(`Event listener '${name}': run must be a function`);
  if (workflow !== undefined && typeof workflow !== "function")
    throw new Error(
      `Event listener '${name}': workflow must be a function marked "use workflow"`,
    );
}

/** The deps a plugin's listener runs with, set by the plugin install; `undefined` for the app's own. */
export const listenerDeps = (listener: object) =>
  (listener as { [PLUGIN_DEPS]?: Record<string, unknown> })[PLUGIN_DEPS];
