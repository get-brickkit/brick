import {
  ValidationError,
  ActionExecutionError,
  type Action,
  type ActionContext,
  type Logger,
  type ValidationErrorItem,
} from "../types";
import { toErrorResponse } from "../error-response";
import { baseContext } from "../context";
import type { ServicePort } from "../service-port";
import type { RouteIR } from "./ir";

/*
 * The action pipeline, as stages: request ids → read input → validate →
 * authorize → execute → validate output → map error. `bindRoute` runs them
 * for an HTTP route; `action.execute` runs the same stages in-process.
 */

export type CompiledHandler = (context: any) => unknown | Promise<unknown>;
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
  readonly errorBuilder: unknown;
  readonly logger: Logger;
  readonly cachedDb: unknown;
  /** The deps of the plugin install that created the action; else the service's. */
  readonly deps?: Readonly<Record<string, unknown>>;
}

function isNonEmpty(value: any): boolean {
  if (value == null) return false;
  // Early return on the first key: an allocation-free emptiness check.
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

function coerceQueryValue(
  value: unknown,
  type: RouteIR["coercions"][number]["type"],
  request: Request | undefined,
  key: string,
) {
  if (type === "number") {
    const number = Number(value);
    return Number.isNaN(number) ? value : number;
  }
  if (type === "array") {
    const values = request ? new URL(request.url).searchParams.getAll(key) : [];
    return values.length ? values : Array.isArray(value) ? value : [value];
  }
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return value;
}

/** The action's input from the path, query and body, coerced by its schema. */
export function readInput(
  route: RouteIR,
  { params, body, query, request }: any,
): unknown {
  if (!route.input) return undefined;
  let coercedQuery = query;
  let coercedParams = params;
  if (route.coercions.length) {
    if (query) {
      coercedQuery = { ...query };
      for (const { key, type } of route.coercions)
        if (query[key] !== undefined)
          coercedQuery[key] = coerceQueryValue(query[key], type, request, key);
    }
    // Path segments are strings; numeric ids (`/:id`) need numbers.
    for (const { key, type } of route.coercions) {
      if (type !== "number" || typeof params?.[key] !== "string") continue;
      const value = Number(params[key]);
      if (Number.isNaN(value)) continue;
      if (coercedParams === params) coercedParams = { ...params };
      coercedParams[key] = value;
    }
  }
  const input = route.readLike
    ? mergeInput(coercedQuery, coercedParams, body)
    : mergeInput(coercedParams, body, coercedQuery);
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

function validateInput(check: Checker, input: unknown, action: string) {
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
export async function authorizeCall(
  authorize: ((params: any) => unknown) | undefined,
  ctx: { user?: unknown },
  input: unknown,
  action: string,
): Promise<void> {
  if (authorize && !(await authorize({ ctx, input, user: ctx.user })))
    deny(action, ctx.user);
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
  const ctx = baseContext({
    request: request instanceof Request ? request : undefined,
    traceId: headers?.["x-trace-id"] || undefined,
    requestId: headers?.["x-request-id"] || undefined,
    db: plan.cachedDb ?? plan.service.getDb(),
    logger: plan.logger,
    metadata: { headers },
    // The service's context hook sees the service's deps; a plugin's action then gets its own.
    deps: plan.contextHook
      ? plan.service.deps
      : (plan.deps ?? plan.service.deps),
  }) as ActionContext & { requestId: string };
  if (set?.headers) {
    set.headers["x-trace-id"] = ctx.traceId;
    set.headers["x-request-id"] = ctx.requestId;
  }
  return ctx;
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
    errorBuilder,
  } = plan;
  const name = route.action;
  const checkOutput = (result: unknown) => {
    if (outputChecker) validate(outputChecker, result, name, "output");
    return result;
  };
  if (contextHook || authorize) {
    return async function brickAction(context) {
      const input = readInput(route, context);
      const ctx = requestContext(plan, context);
      try {
        if (contextHook) {
          const extra = await contextHook(ctx);
          if (extra) Object.assign(ctx, extra);
          if (plan.deps) ctx.deps = plan.deps;
        }
        if (inputChecker) validateInput(inputChecker, input, name);
        await authorizeCall(authorize, ctx, input, name);
        return checkOutput(await execute({ input, ctx, error: errorBuilder }));
      } catch (err) {
        return mapError(err, context.set, ctx);
      }
    };
  }
  return function brickAction(context) {
    const input = readInput(route, context);
    const ctx = requestContext(plan, context);
    try {
      if (inputChecker) validateInput(inputChecker, input, name);
      const result = execute({ input, ctx, error: errorBuilder });
      if (isThenable(result))
        return Promise.resolve(result)
          .then(checkOutput)
          .catch((err) => mapError(err, context.set, ctx));
      return checkOutput(result);
    } catch (err) {
      return mapError(err, context.set, ctx);
    }
  };
}

/** What generated (`brick build`) handler factories call. */
export const compilerRuntime = Object.freeze({ bindRoute });
