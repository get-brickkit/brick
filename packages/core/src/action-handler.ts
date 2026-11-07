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
 * An Elysia handler for one action. Use it to mount an action on your own
 * Elysia app; `brick()` does it for you.
 *
 * @deprecated Serve actions with `brick()`, or bind every route at once with
 * `compileBrickApplication`.
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
  return bindRoute(
    planRoute(
      describeRoute(
        service,
        action,
        (method ?? "POST") as RouteIR["method"],
        routePath,
      ),
      service,
      action,
    ),
  );
}
