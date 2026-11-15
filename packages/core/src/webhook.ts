import type { Static, TSchema } from "@sinclair/typebox";
import { actionMeta } from "./action-meta";
import type {
  Action,
  ActionErrorDefinition,
  ErrorBuilder,
  RateLimits,
  Service,
} from "./types";
import { checkRateLimits } from "./rate-limit";
import { serviceStorage } from "./storage";

/** What a verifier sees of a delivery. */
export interface WebhookRequest {
  /** The body exactly as it arrived. */
  rawBody: Uint8Array;
  headers: Headers;
  url: string;
  method: string;
}

/**
 * Decides whether the provider sent a delivery. `false`, or a throw, refuses it
 * (401); `true` accepts; `{ eventId }` accepts and names the event.
 * Set `suppliesEventId` on a verifier that always returns one, so a webhook
 * needs no `eventId` option.
 */
export type WebhookVerifier = ((
  request: WebhookRequest,
) =>
  | boolean
  | { eventId: string | number }
  | Promise<boolean | { eventId: string | number }>) & {
  suppliesEventId?: true;
  /** Set on a verifier that signs the body (a GET has none, so it cannot serve one). */
  signsBody?: true;
};

/** What `service.webhook` takes. */
export interface WebhookConfig<
  TInput extends TSchema,
  TErrors extends Record<string, ActionErrorDefinition>,
  TContext,
> {
  /** Its route is `POST /api/<service>/<name>`, as for an action. */
  name: string;
  description?: string;
  /** Relative to the service, as for an action. */
  path?: string;
  /** Default `"POST"`. With `"GET"` the input is the query string. */
  method?: "POST" | "GET";
  /** Runs first, on the raw body. Nothing else runs until it accepts. */
  verify: WebhookVerifier;
  /** The payload: JSON, or a form (`application/x-www-form-urlencoded`). Properties it does not declare are dropped. */
  input: TInput;
  /**
   * The delivery's id, so one sent twice runs once: a non-empty string or a
   * safe integer (`7` and `"7"` are one id); anything else, `undefined`
   * included, is no id. Not needed when the verifier supplies one.
   */
  eventId?: (args: {
    input: Static<TInput>;
    headers: Headers;
    url: string;
    method: string;
  }) => string | number | undefined | Promise<string | number | undefined>;
  /** `false` runs every delivery, with no check for repeats. Else `ttlMs` is how long a handled id is remembered (default 7 days). */
  replay?: false | { ttlMs?: number };
  /** Largest body accepted, in bytes (default 1 MiB). */
  maxBodyBytes?: number;
  rateLimit?: RateLimits<Static<TInput>, TContext>;
  errors?: TErrors;
  tags?: string[];
  /** What the provider is answered: the return value, which may be a `Response`; `{ ok: true }` for nothing. */
  execute: (params: {
    input: Static<TInput>;
    ctx: TContext;
    error: ErrorBuilder<TErrors>;
    /** `undefined` when `replay` is `false` and the delivery has no id. */
    eventId: string | undefined;
  }) => unknown;
}

/** What Brick keeps of a webhook besides its action: how a delivery is verified and remembered. */
export interface WebhookDefinition {
  readonly verify: WebhookVerifier;
  readonly eventId?: WebhookConfig<any, any, any>["eventId"];
  readonly replay: false | { readonly ttlMs: number };
  readonly maxBodyBytes: number;
}

export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const DEFAULT_REPLAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The webhook behind an action, if it is one. */
export function webhookOf(
  action: object | undefined,
): WebhookDefinition | undefined {
  return action ? actionMeta(action).webhook : undefined;
}

/** Whether an action was declared with `service.webhook`. */
export function isWebhook(action: object): boolean {
  return webhookOf(action) !== undefined;
}

/** @throws When the config is not one a webhook can run on. */
export function defineWebhookMeta(
  service: string,
  config: WebhookConfig<any, any, any>,
): WebhookDefinition {
  const where = `Service "${service}": webhook '${config?.name}'`;
  if (typeof config?.verify !== "function")
    throw new Error(
      `${where} needs verify: a verifier such as hmacSignature({ secret, header }), standardWebhooks({ secret }) or twilioSignature({ authToken, url }), or your own (request) => boolean. A webhook cannot run without one.`,
    );
  if (!config.input || typeof config.input !== "object")
    throw new Error(
      `${where} needs input: the schema of the payload, such as t.Object({ ... }).`,
    );
  if (config.method !== undefined && !["POST", "GET"].includes(config.method))
    throw new Error(`${where}: method must be "POST" or "GET".`);
  if (config.method === "GET" && config.verify.signsBody)
    throw new Error(
      `${where}: method "GET" has no body, and this verifier signs the body, so it would accept one signature for every query. Use twilioSignature (it signs the URL) or a verifier of your own, or method "POST".`,
    );
  for (const option of ["authorize", "output"])
    if ((config as object as Record<string, unknown>)[option] !== undefined)
      throw new Error(
        `${where}: ${option} is not an option of a webhook, and would be ignored. verify is the check.`,
      );
  const { maxBodyBytes = DEFAULT_MAX_BODY_BYTES, replay } = config;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1)
    throw new Error(`${where}: maxBodyBytes must be a positive integer.`);
  const ttlMs =
    replay === false ? undefined : (replay?.ttlMs ?? DEFAULT_REPLAY_TTL_MS);
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1))
    throw new Error(`${where}: replay.ttlMs must be a positive integer.`);
  return {
    verify: config.verify,
    eventId: config.eventId,
    replay: ttlMs === undefined ? false : { ttlMs },
    maxBodyBytes,
  };
}

/**
 * Checks at startup what a webhook's replay check needs: a way to name each
 * delivery, and a key-value storage to remember them in.
 */
export function checkWebhook(
  service: Service<any, any>,
  action: Action<any, any, any, any>,
  deps: Readonly<Record<string, unknown>>,
): void {
  const webhook = webhookOf(action);
  if (!webhook) return;
  checkRateLimits(service, action, deps);
  if (webhook.replay === false) return;
  const where = `Service "${service.name}": webhook '${action.name}'`;
  if (!webhook.eventId && !webhook.verify.suppliesEventId)
    throw new Error(
      `${where} has no event id to tell deliveries apart by, so a delivery sent twice would run twice. Add eventId: ({ headers }) => headers.get("<the provider's delivery id header>") ?? undefined, use a verifier that supplies one (standardWebhooks), or set replay: false to run every delivery.`,
    );
  if (!serviceStorage(service))
    throw new Error(
      `${where} remembers the events it has handled, but the service has no key-value storage. Add one: defineService("${service.name}", { deps: { cache: defineStorage({ driver: redis() }) } }), or set replay: false.`,
    );
}
