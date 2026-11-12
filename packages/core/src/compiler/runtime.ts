import {
  ValidationError,
  ActionExecutionError,
  type Action,
  type ActionContext,
  type Logger,
  type ValidationErrorItem,
} from "../types";
import { toErrorResponse } from "../error-response";
import { baseContext, requestIds } from "../context";
import type { ServicePort } from "../service-port";
import type { Coercion, RouteIR } from "./ir";

/*
 * The action pipeline, as stages: request ids → read input → validate →
 * authorize → execute → validate output → map error. `bindRoute` runs them
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
    Array.from(check.Errors(value)).map((err: any) => ({
      path: err.path,
      message: err.message,
      value: err.value,
    })),
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
  /** Refuse a call that did not come through the dashboard (`dashboard: true`). */
  readonly dashboard?: boolean;
  /** @throws The input's validation error. */
  readonly checkInput: (input: unknown) => void;
  readonly authorize?: (params: any) => unknown;
  readonly execute: (params: any) => unknown;
  readonly errorBuilder: unknown;
  /** @throws The output's validation error; else returns the output. */
  readonly checkOutput: (result: unknown) => unknown;
}

/** The stage order of every call, over HTTP and in-process: check input → authorize → execute → check output. */
export async function runStages(
  stages: Stages,
  input: unknown,
  ctx: { user?: unknown; dashboard?: unknown },
): Promise<unknown> {
  if (stages.dashboard && !ctx.dashboard)
    throw new ActionExecutionError(
      "UNAUTHORIZED",
      `Action '${stages.name}' is only for the dashboard`,
      401,
    );
  stages.checkInput(input);
  await authorizeCall(stages.authorize, ctx, input, stages.name);
  return stages.checkOutput(
    await stages.execute({ input, ctx, error: stages.errorBuilder }),
  );
}

function mapError(
  err: unknown,
  set: any,
  options: { logger: Logger; requestId: string },
) {
  const response = toErrorResponse(err, options);
  set.status = response.status;
  return response;
}

const isThenable = (value: any): value is PromiseLike<unknown> =>
  value != null && typeof value.then === "function";

/** The context of one HTTP request, with the trace and request id headers set. */
function requestContext(
  plan: CompiledRoutePlan,
  { headers, request, set }: any,
): ActionContext & { requestId: string } {
  return baseContext({
    ...requestIds(headers, set),
    request: request instanceof Request ? request : undefined,
    db: plan.cachedDb ?? plan.service.getDb(),
    logger: plan.logger,
    metadata: { headers },
    // resolveServiceContext's rule: the hook sees the service's deps; a plugin's action then gets its own.
    deps: plan.contextHook
      ? plan.service.deps
      : (plan.deps ?? plan.service.deps),
  }) as ActionContext & { requestId: string };
}

/** The HTTP handler of one route: the pipeline's stages, synchronous when no stage needs to wait. */
export function bindRoute(plan: CompiledRoutePlan): CompiledHandler {
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
  const stages: Stages = {
    name,
    dashboard: plan.action.config.dashboard === true,
    checkInput: (input) => {
      if (inputChecker) validateInput(inputChecker, input, name, checkInput);
    },
    authorize,
    execute,
    errorBuilder,
    checkOutput: (result) => {
      if (outputChecker) validate(outputChecker, result, name, "output");
      return result;
    },
  };
  if (contextHook || authorize || stages.dashboard) {
    return async function brickAction(context) {
      const ctx = requestContext(plan, context);
      try {
        const input = readInput(route, context);
        if (contextHook) {
          const extra = await contextHook(ctx);
          if (extra) Object.assign(ctx, extra);
          if (plan.deps) ctx.deps = plan.deps;
        }
        return await runStages(stages, input, ctx);
      } catch (err) {
        return mapError(err, context.set, ctx);
      }
    };
  }
  // Nothing to wait for before `execute`: the same stages, without `authorize`, synchronously.
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
