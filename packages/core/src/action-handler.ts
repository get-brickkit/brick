import type { Service, Action } from "./types";
import { getCompiledCheck } from "./typebox";
import { createLogger } from "./logger";
import { actionMeta } from "./action-meta";
import { describeRoute, type RouteIR } from "./compiler/ir";
import { portOf } from "./service-port";
import { bindRoute, type CompiledRoutePlan } from "./compiler/runtime";

/** The plan of an analyzed route: its callbacks, validators and logger. */
export function planRoute(
  route: RouteIR,
  service: Service,
  action: Action,
): CompiledRoutePlan {
  const meta = actionMeta(action);
  const outputSchema = meta.runtimeOutput ?? action.config.output;
  return {
    route,
    service: portOf(service),
    action,
    execute: action.config.execute,
    authorize: action.config.authorize,
    contextHook: service.options.context,
    inputChecker: action.config.input
      ? (getCompiledCheck(action.config.input) as any)
      : undefined,
    outputChecker: outputSchema
      ? (getCompiledCheck(outputSchema) as any)
      : undefined,
    errorBuilder: action.errorHelpers,
    logger: createLogger(`[${service.name}:${action.name}]`),
    cachedDb: service.getDb(),
    checkInput: meta.checkInput,
    deps: meta.deps?.values,
  };
}

/**
 * Work out, once at startup, everything an action's route needs to answer a
 * request: where its input comes from (body, query, or path), the validators,
 * the authorization and execute functions, and its logger. Low level: `brick()`
 * does this for every route.
 *
 * @param service - The service the action belongs to.
 * @param action - The action.
 * @param routePath - The route's path.
 * @param method - The HTTP method (POST by default).
 * @returns The plan `executeCompiledRoute` runs.
 */
export function compileRoutePlan(
  service: Service,
  action: Action,
  routePath: string,
  method?: string,
): CompiledRoutePlan {
  return planRoute(
    describeRoute(
      service,
      action,
      (method ?? "POST") as RouteIR["method"],
      routePath,
    ),
    service,
    action,
  );
}

/**
 * Answer one request for a compiled route: read the input, run the action, and
 * return its output or the error response, with the `x-trace-id` and
 * `x-request-id` headers set. Low level: `brick()` mounts this for every route.
 *
 * @param plan - From `compileRoutePlan`.
 * @param elysiaCtx - The Elysia request context: `params`, `body`, `query`,
 * `headers`, `request`, and `set`.
 * @returns The action's output, or an error envelope with the status set on `set`.
 */
export async function executeCompiledRoute(
  plan: CompiledRoutePlan,
  elysiaCtx: any,
) {
  return bindRoute(plan)(elysiaCtx);
}

/**
 * An Elysia handler for one action: `compileRoutePlan` and
 * `executeCompiledRoute` together. Use it to mount an action on your own
 * Elysia app; `brick()` does it for you.
 *
 * @param service - The service the action belongs to.
 * @param action - The action.
 * @param routePath - The route's path.
 * @param method - The HTTP method (POST by default).
 * @returns A function from the Elysia context to the response.
 */
export function createActionHandler(
  service: Service,
  action: Action,
  routePath: string,
  method?: string,
) {
  return bindRoute(compileRoutePlan(service, action, routePath, method));
}
