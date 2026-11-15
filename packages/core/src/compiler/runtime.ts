import {
  ValidationError,
  ActionExecutionError,
  type Action,
  type ActionContext,
  type Logger,
  type ValidationErrorItem,
} from "../types";
import { Value } from "@sinclair/typebox/value";
import { toErrorResponse } from "../error-response";
import { recordWebhook } from "../telemetry";
import {
  serviceStorage,
  StorageUnavailableError,
  storageKey,
  type FrameworkStorage,
} from "../storage";
import { webhookOf, type WebhookDefinition } from "../webhook";
import { baseContext, markResolved, requestIds } from "../context";
import { scopeFiles } from "../file-storage";
import type { ServicePort } from "../service-port";
import { enforceRateLimits, rateLimitsOf } from "../rate-limit";
import {
  auditStage,
  runAudited,
  runUnaudited,
  type AuditStage,
} from "../audit";
import { withRedaction, type Sensitivity } from "../sensitive";
import type { Coercion, RouteIR } from "./ir";

/*
 * The action pipeline, as stages: request ids → read input → validate →
 * rate limit → authorize → [audit] → execute → validate output → map error. `bindRoute` runs them
 * for an HTTP route; `action.execute` runs the same stages in-process.
 */

export type CompiledHandler = (context: any) => unknown | Promise<unknown>;
/** @deprecated `brick build` no longer emits handler factories; see `bindCompiledApplication`. */
export type HandlerFactory = (
  binding: CompiledRoutePlan,
  runtime: typeof compilerRuntime,
) => CompiledHandler;

interface Checker {
  Check(value: unknown): boolean;
  Errors(value: unknown): Iterable<any>;
}

/** Everything one route needs to answer a request, worked out once at startup. */
export interface CompiledRoutePlan {
  readonly route: RouteIR;
  readonly service: ServicePort;
  readonly action: Action<any, any, any, any>;
  readonly execute: (params: any) => unknown;
  readonly authorize?: (params: any) => boolean | Promise<boolean>;
  readonly contextHook?: (baseCtx: any) => unknown;
  readonly inputChecker?: Checker;
  readonly outputChecker?: Checker;
  readonly sensitive?: Sensitivity;
  /** A plugin's check that runs before `inputChecker`. */
  readonly checkInput?: (input: unknown) => ValidationErrorItem[] | undefined;
  readonly errorBuilder: unknown;
  readonly logger: Logger;
  readonly cachedDb: unknown;
  /** The deps of the plugin install that created the action; else the service's. */
  readonly deps?: Readonly<Record<string, unknown>>;
}

function isNonEmpty(value: any): boolean {
  if (value == null) return false;
  for (const _ in value) return true; // NOSONAR
  return false;
}

/** One source alone is the input as it is; several merge, later ones winning. */
function mergeInput(first: any, second: any, third: any) {
  const a = isNonEmpty(first),
    b = isNonEmpty(second),
    c = isNonEmpty(third);
  if (a && !b && !c) return first;
  if (b && !a && !c) return second;
  if (c && !a && !b) return third;
  if (a || b || c) return Object.assign({}, first, second, third);
  return undefined;
}

function coerceScalar(value: unknown, type: Coercion | undefined) {
  if (typeof value !== "string") return value;
  if (type === "number") {
    const number = Number(value);
    return Number.isNaN(number) ? value : number;
  }
  if (type === "boolean") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  if (type === "json") {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

function coerceQueryValue(
  value: unknown,
  { key, type, items }: RouteIR["coercions"][number],
  request: Request | undefined,
) {
  if (type !== "array") return coerceScalar(value, type);
  const values = request ? new URL(request.url).searchParams.getAll(key) : [];
  const list = values.length ? values : Array.isArray(value) ? value : [value];
  return list.map((item) => coerceScalar(item, items));
}

export const BODY_TOO_LARGE = Symbol("brick.bodyTooLarge");

export function bodyLimitParser(limit: number) {
  return ({ request }: { request: Request }) =>
    Number(request.headers.get("content-length")) > limit
      ? BODY_TOO_LARGE
      : undefined;
}

export function rawBodyParser(limit: number) {
  return async ({ request }: { request: Request }) => {
    if (Number(request.headers.get("content-length")) > limit)
      return BODY_TOO_LARGE;
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (request.body)
      for await (const chunk of request.body as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > limit) return BODY_TOO_LARGE;
        chunks.push(chunk);
      }
    return new Uint8Array(Buffer.concat(chunks));
  };
}

/** The action's input from the path, query and body, coerced by its schema. */
export function readInput(
  route: RouteIR,
  { params, body, query, request }: any,
): unknown {
  if (body === BODY_TOO_LARGE)
    throw new ActionExecutionError(
      "PAYLOAD_TOO_LARGE",
      `Request body exceeds ${route.bodyLimit} bytes`,
      413,
    );
  if (!route.input) return undefined;
  let coercedQuery = query;
  let coercedParams = params;
  let coercedBody = body;
  if (route.coercions.length) {
    if (query) {
      coercedQuery = { ...query };
      for (const coercion of route.coercions)
        if (query[coercion.key] !== undefined)
          coercedQuery[coercion.key] = coerceQueryValue(
            query[coercion.key],
            coercion,
            request,
          );
    }
    // Form fields arrive as strings, and a single file as itself, like query values.
    if (
      body &&
      request?.headers.get("content-type")?.startsWith("multipart/form-data")
    ) {
      coercedBody = { ...body };
      for (const coercion of route.coercions)
        if (body[coercion.key] !== undefined)
          coercedBody[coercion.key] = coerceQueryValue(
            body[coercion.key],
            coercion,
            undefined,
          );
    }
    for (const { key, type } of route.coercions) {
      if (type !== "number" || typeof params?.[key] !== "string") continue;
      const value = Number(params[key]);
      if (Number.isNaN(value)) continue;
      if (coercedParams === params) coercedParams = { ...params };
      coercedParams[key] = value;
    }
  }
  const input = route.readLike
    ? mergeInput(coercedQuery, coercedParams, coercedBody)
    : mergeInput(coercedParams, coercedBody, coercedQuery);
  return input === undefined &&
    (route.inputSchema as { type?: string } | undefined)?.type === "object"
    ? {}
    : input;
}

// Generic pre-validation nesting cap for parsed HTTP input. Compiled input
// validators recurse, so unbounded nesting (e.g. a 20k-deep filter object)
// would throw RangeError (HTTP 500) instead of failing validation with a
// 400. The walk is iterative and far above legitimate depths (a max-depth
// CRUD filter is ~45 levels of JSON).
const MAX_INPUT_DEPTH = 128;
export function inputTooDeep(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const stack: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > MAX_INPUT_DEPTH) return true;
    if (node && typeof node === "object") {
      const children = Array.isArray(node) ? node : Object.values(node);
      for (const child of children)
        if (child && typeof child === "object")
          stack.push({ node: child, depth: depth + 1 });
    }
  }
  return false;
}

/** The error for input (400) or output (500) that fails its schema. */
export function invalid(
  action: string,
  stage: "input" | "output",
  errors: ValidationErrorItem[],
): ValidationError {
  return new ValidationError(
    `Validation failed for action '${action}' ${stage}`,
    errors,
    stage === "output" ? 500 : 400,
  );
}

function validate(
  check: Checker,
  value: unknown,
  action: string,
  stage: "input" | "output",
) {
  if (check.Check(value)) return;
  throw invalid(
    action,
    stage,
    Array.from(check.Errors(value), ({ path, message }) => ({ path, message })),
  );
}

function validateInput(
  check: Checker,
  input: unknown,
  action: string,
  checkInput: CompiledRoutePlan["checkInput"],
) {
  const errors = checkInput?.(input);
  if (errors) throw invalid(action, "input", errors);
  if (inputTooDeep(input))
    throw invalid(action, "input", [
      { path: "", message: "Input exceeds maximum nesting depth" },
    ]);
  validate(check, input, action, "input");
}

/** A refused `authorize`: 401 without a user, 403 with one. */
export function deny(action: string, user: unknown): never {
  throw new ActionExecutionError(
    user == null ? "UNAUTHORIZED" : "FORBIDDEN",
    `Access denied for action '${action}'`,
    user == null ? 401 : 403,
  );
}

/** Runs `authorize`, if any, and denies the call when it refuses. */
async function authorizeCall(
  authorize: ((params: any) => unknown) | undefined,
  ctx: { user?: unknown },
  input: unknown,
  action: string,
): Promise<void> {
  if (authorize && !(await authorize({ ctx, input, user: ctx.user })))
    deny(action, ctx.user);
}

/** What a call runs once its context is ready. */
export interface Stages {
  readonly name: string;
  readonly dashboardOnly?: boolean;
  /** @throws The input's validation error. */
  readonly checkInput: (input: unknown) => void;
  readonly rateLimit?: (input: unknown, ctx: any) => Promise<void>;
  readonly authorize?: (params: any) => unknown;
  readonly audit?: AuditStage;
  readonly execute: (params: any) => unknown;
  readonly errorBuilder: unknown;
  /** @throws The output's validation error; else returns the output. */
  readonly checkOutput: (result: unknown) => unknown;
  readonly sensitive?: Sensitivity;
}

/** The stage order of every call, over HTTP and in-process: check input → rate limit → authorize → execute → check output. */
export async function runStages(
  stages: Stages,
  input: unknown,
  ctx: { user?: unknown; dashboard?: unknown },
): Promise<unknown> {
  if (stages.dashboardOnly && !ctx.dashboard)
    throw new ActionExecutionError(
      "UNAUTHORIZED",
      `Action '${stages.name}' is only for the dashboard`,
      401,
    );
  stages.checkInput(input);
  stages.sensitive?.input(input);
  if (stages.rateLimit) await stages.rateLimit(input, ctx);
  await authorizeCall(stages.authorize, ctx, input, stages.name);
  const output = stages.audit
    ? await runAudited(stages.audit, input, ctx as ActionContext, async () =>
        stages.checkOutput(
          await stages.execute({ input, ctx, error: stages.errorBuilder }),
        ),
      )
    : stages.checkOutput(
        await runUnaudited(() =>
          stages.execute({ input, ctx, error: stages.errorBuilder }),
        ),
      );
  return stages.sensitive
    ? stages.sensitive.output(output, input, ctx)
    : output;
}

function mapError(
  err: unknown,
  set: any,
  options: { logger: Logger; requestId: string },
) {
  const response = toErrorResponse(err, options);
  set.status = response.status;
  const retry = (
    response.details as { retryAfterSeconds?: unknown } | undefined
  )?.retryAfterSeconds;
  if (response.status === 429 && Number.isFinite(retry))
    set.headers["retry-after"] = String(
      BigInt(Math.max(1, Math.ceil(retry as number))),
    );
  return response;
}

const isThenable = (value: any): value is PromiseLike<unknown> =>
  value != null && typeof value.then === "function";

/** The context of one HTTP request, with the trace and request id headers set. */
function requestContext(
  plan: CompiledRoutePlan,
  { headers, request, set }: any,
): ActionContext & { requestId: string } {
  const ctx = baseContext({
    ...requestIds(headers, set),
    request: request instanceof Request ? request : undefined,
    db: plan.cachedDb ?? plan.service.getDb(),
    logger: plan.logger,
    metadata: { headers },
    // resolveServiceContext's rule: the hook sees the service's deps; a plugin's action then gets its own.
    deps: plan.contextHook
      ? plan.service.deps
      : (plan.deps ?? plan.service.deps),
  });
  if (!plan.contextHook) resolveServiceDeps(ctx, plan);
  return ctx as ActionContext & { requestId: string };
}

const HANDLED = "handled";
const IN_FLIGHT_CLAIM_MS = 5 * 60_000;

const eventIdFrom = (value: unknown): string | undefined =>
  Number.isSafeInteger(value)
    ? String(value)
    : typeof value === "string" && value
      ? value
      : undefined;

const refuse = (code: string, message: string, status: number) =>
  new ActionExecutionError(code, message, status);

function fieldsOf(params: URLSearchParams): Record<string, unknown> {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of params)
    grouped.set(name, [...(grouped.get(name) ?? []), value]);
  return Object.fromEntries(
    [...grouped].map(([name, values]) => [
      name,
      values.length > 1 ? values : values[0],
    ]),
  );
}

function webhookInput(route: RouteIR, request: Request, rawBody: Uint8Array) {
  const text = new TextDecoder().decode(rawBody);
  const form =
    route.method === "GET"
      ? new URL(request.url).searchParams
      : /^application\/x-www-form-urlencoded/i.test(
            request.headers.get("content-type") ?? "",
          )
        ? new URLSearchParams(text)
        : undefined;
  if (form) return readInput(route, { query: fieldsOf(form) });
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(route.action, "input", [
      { path: "", message: "Body is not valid JSON" },
    ]);
  }
}

function bindWebhook(plan: CompiledRoutePlan): CompiledHandler {
  const { execute } = plan;
  const name = plan.route.action;
  const webhook = webhookOf(plan.action)!;
  const limits = rateLimitsOf(plan.action.config);
  const audit = auditStage(plan.service, plan.action);
  const storage = webhook.replay ? serviceStorage(plan.service) : undefined;
  if (webhook.replay && !storage)
    throw new Error(
      `Webhook '${name}' remembers the events it has handled, but its service has no key-value storage`,
    );
  const brickWebhook = async (context: any) => {
    const delivery: Delivery = {
      plan,
      webhook,
      storage,
      limits,
      request: context.request,
      ctx: requestContext(plan, context),
      outcome: "failed",
    };
    try {
      rejectOversizedBody(delivery, context.body);
      const rawBody = rawBodyOf(context.body);
      await verifyDelivery(delivery, rawBody);
      const input = parseAndCheckInput(delivery, rawBody);
      plan.sensitive?.input(input);
      await resolveEventId(delivery, input);
      if ((await claimEvent(delivery)) === ALREADY_HANDLED)
        return { duplicate: true };

      let result: unknown;
      try {
        await resolveContext(delivery);
        await enforceWebhookRateLimits(delivery, input);
        const run = () =>
          execute({
            input,
            ctx: delivery.ctx,
            error: plan.errorBuilder,
            eventId: delivery.eventId,
          });
        result = audit
          ? await runAudited(audit, input, delivery.ctx, async () => run())
          : await runUnaudited(run);
        if (plan.sensitive && !(result instanceof Response))
          result = await plan.sensitive.output(result, input, delivery.ctx);
      } catch (error) {
        await releaseClaim(delivery);
        throw error;
      }
      await settleClaim(delivery, result);
      return result === undefined ? { ok: true } : result;
    } catch (err) {
      return mapError(err, context.set, delivery.ctx);
    } finally {
      recordWebhook(name, delivery.eventId, delivery.outcome);
    }
  };
  return plan.sensitive
    ? (context) => withRedaction(() => brickWebhook(context))
    : brickWebhook;
}

interface Claim {
  readonly key: string;
  readonly mine: string;
}
interface Delivery {
  readonly plan: CompiledRoutePlan;
  readonly webhook: WebhookDefinition;
  readonly storage: FrameworkStorage | undefined;
  readonly limits: ReturnType<typeof rateLimitsOf>;
  readonly request: Request;
  readonly ctx: ActionContext & { requestId: string };
  outcome: string;
  eventId?: string;
  claim?: Claim;
}

const ALREADY_HANDLED = Symbol("alreadyHandled");

function rejectOversizedBody(delivery: Delivery, body: unknown) {
  if (body !== BODY_TOO_LARGE) return;
  delivery.outcome = "too_large";
  throw refuse(
    "PAYLOAD_TOO_LARGE",
    `Request body exceeds ${delivery.webhook.maxBodyBytes} bytes`,
    413,
  );
}

const rawBodyOf = (body: unknown) =>
  body instanceof Uint8Array ? body : new Uint8Array();

function logVerifierThrowWithoutItsMessage(
  { plan, ctx }: Delivery,
  error: unknown,
) {
  plan.logger.warn("A webhook verifier threw, so its delivery was refused", {
    service: plan.service.name,
    webhook: plan.route.action,
    error: error instanceof Error ? error.constructor.name : typeof error,
    requestId: ctx.requestId,
  });
}

async function verifyDelivery(delivery: Delivery, rawBody: Uint8Array) {
  const { webhook, request } = delivery;
  let verdict: unknown;
  try {
    verdict = await webhook.verify({
      rawBody,
      headers: request.headers,
      url: request.url,
      method: request.method,
    });
  } catch (error) {
    logVerifierThrowWithoutItsMessage(delivery, error);
    verdict = false;
  }
  const given = eventIdFrom((verdict as { eventId?: unknown } | null)?.eventId);
  if (verdict !== true && !given) {
    delivery.outcome = "refused";
    throw refuse("UNAUTHORIZED", "Webhook verification failed", 401);
  }
  delivery.eventId = verdict === true ? undefined : given;
}

function parseAndCheckInput(delivery: Delivery, rawBody: Uint8Array) {
  const { plan, request } = delivery;
  const { route, inputChecker, checkInput } = plan;
  delivery.outcome = "invalid";
  let input = webhookInput(route, request, rawBody);
  if (inputChecker)
    validateInput(inputChecker, input, route.action, checkInput);
  input = Value.Clean(plan.action.config.input, input);
  delivery.outcome = "failed";
  return input;
}

async function resolveEventId(delivery: Delivery, input: unknown) {
  const { webhook, request } = delivery;
  delivery.eventId ??= eventIdFrom(
    await webhook.eventId?.({
      input,
      headers: request.headers,
      url: request.url,
      method: request.method,
    }),
  );
}
async function claimEvent(delivery: Delivery) {
  const { plan, storage, eventId } = delivery;
  if (!storage) return;
  if (!eventId) {
    delivery.outcome = "no_event_id";
    throw refuse("BAD_REQUEST", "The delivery has no event id", 400);
  }
  const claim = (delivery.claim = {
    key: storageKey("webhook", [plan.service.name, plan.route.action, eventId]),
    mine: `pending:${crypto.randomUUID()}`,
  });
  try {
    const claimed = await storage.putIfAbsent(
      claim.key,
      claim.mine,
      IN_FLIGHT_CLAIM_MS,
    );
    if (claimed.stored) return;
    if (claimed.value === HANDLED) {
      delivery.outcome = "duplicate";
      return ALREADY_HANDLED;
    }
    delivery.outcome = "in_flight";
    throw refuse(
      "CONFLICT",
      "Another delivery of this event is being handled; retry later",
      409,
    );
  } catch (error) {
    if (!(error instanceof StorageUnavailableError)) throw error;
    releaseClaim(delivery);
    delivery.outcome = "unavailable";
    throw new ActionExecutionError(
      "SERVICE_UNAVAILABLE",
      "Webhook storage is unavailable; retry later",
      503,
      undefined,
      { cause: error },
    );
  }
}

async function resolveContext({ plan, ctx }: Delivery) {
  if (!plan.contextHook) return;
  const extra = await plan.contextHook(ctx);
  if (extra) Object.assign(ctx, extra);
  resolveServiceDeps(ctx, plan);
}

async function enforceWebhookRateLimits(
  { plan, limits, ctx }: Delivery,
  input: unknown,
) {
  if (limits)
    await enforceRateLimits(
      plan.service,
      "action",
      plan.route.action,
      limits,
      input,
      ctx,
    );
}
async function releaseClaim({ storage, claim }: Delivery) {
  await storage?.compareAndDelete(claim!.key, claim!.mine).catch(() => {});
}
async function settleClaim(delivery: Delivery, result: unknown) {
  const { plan, webhook, storage, claim, ctx } = delivery;
  const failed = result instanceof Response && result.status >= 400;
  if (storage && failed) await releaseClaim(delivery);
  else if (storage && webhook.replay)
    await storage
      .put(claim!.key, HANDLED, webhook.replay.ttlMs)
      .catch((error) =>
        plan.logger.warn(
          "Webhook handled, but its id was not recorded; a retry may run it again",
          { requestId: ctx.requestId },
          error,
        ),
      );
  delivery.outcome = failed ? "failed" : "processed";
}

function resolveServiceDeps(ctx: any, plan: CompiledRoutePlan) {
  markResolved(ctx, plan.service, plan.service.deps);
  ctx.deps = scopeFiles(plan.deps ?? plan.service.deps, ctx);
}

/** The HTTP handler of one route: the pipeline's stages, synchronous when no stage needs to wait. */
export function bindRoute(plan: CompiledRoutePlan): CompiledHandler {
  if (plan.route.kind === "webhook") return bindWebhook(plan);
  const {
    route,
    execute,
    contextHook,
    authorize,
    inputChecker,
    outputChecker,
    checkInput,
    errorBuilder,
  } = plan;
  const name = route.action;
  const limits = rateLimitsOf(plan.action.config);
  const audit = auditStage(plan.service, plan.action);
  const stages: Stages = {
    name,
    dashboardOnly: plan.action.config.dashboard === true,
    checkInput: (input) => {
      if (inputChecker) validateInput(inputChecker, input, name, checkInput);
    },
    rateLimit:
      limits &&
      ((input, ctx) =>
        enforceRateLimits(
          plan.service,
          (plan.action as { kind?: string }).kind === "tool"
            ? "tool"
            : "action",
          name,
          limits,
          input,
          ctx,
        )),
    authorize,
    audit,
    execute,
    errorBuilder,
    checkOutput: (result) => {
      if (outputChecker) validate(outputChecker, result, name, "output");
      return result;
    },
    sensitive: plan.sensitive,
  };
  if (
    contextHook ||
    authorize ||
    stages.dashboardOnly ||
    limits ||
    audit ||
    stages.sensitive
  ) {
    const brickAction = async (context: any) => {
      const ctx = requestContext(plan, context);
      try {
        const input = readInput(route, context);
        if (contextHook) {
          const extra = await contextHook(ctx);
          if (extra) Object.assign(ctx, extra);
          resolveServiceDeps(ctx, plan);
        }
        return await runStages(stages, input, ctx);
      } catch (err) {
        return mapError(err, context.set, ctx);
      }
    };
    return stages.sensitive
      ? (context) => withRedaction(() => brickAction(context))
      : brickAction;
  }
  // Nothing to wait for before `execute`: the same stages, without `authorize`, `rateLimit` or `audit`, synchronously.
  return function brickAction(context) {
    const ctx = requestContext(plan, context);
    try {
      const input = readInput(route, context);
      stages.checkInput(input);
      const result = execute({ input, ctx, error: errorBuilder });
      if (isThenable(result))
        return Promise.resolve(result)
          .then(stages.checkOutput)
          .catch((err) => mapError(err, context.set, ctx));
      return stages.checkOutput(result);
    } catch (err) {
      return mapError(err, context.set, ctx);
    }
  };
}

/** What `bindCompiledApplication`'s handler factories receive. */
export const compilerRuntime = Object.freeze({ bindRoute });
