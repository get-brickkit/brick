import type { RouteIR } from "./ir";
import type { HandlerFactory } from "./runtime";
import type { ActionContext } from "../types";

function coerceQueryValue(
  value: unknown,
  type: RouteIR["coercions"][number]["type"],
  request: Request | undefined,
  key: string,
) {
  if (type === "number" && value !== undefined) {
    const number = Number(value);
    return Number.isNaN(number) ? value : number;
  }
  if (type === "array") {
    const values = request ? new URL(request.url).searchParams.getAll(key) : [];
    return values.length ? values : Array.isArray(value) ? value : [value];
  }
  if (type === "boolean") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return value;
}

/** Bind route metadata with ordinary closures; emitted factories remain build-only. */
export function createHandlerFactory(route: RouteIR): HandlerFactory {
  return (binding, runtime) => {
    const {
      execute,
      contextHook,
      authorize,
      inputChecker,
      outputChecker,
      errorBuilder,
      logger,
      cachedDb,
      service,
    } = binding;
    const readLike = route.inputPrecedence[0] === "query";
    const objectInput = binding.action.config.input?.type === "object";
    const readInput = route.input
      ? ({ params, body, query, request }: any) => {
          let coercedQuery = query;
          if (query && route.coercions.length) {
            coercedQuery = { ...query };
            for (const { key, type } of route.coercions) {
              if (query[key] !== undefined)
                coercedQuery[key] = coerceQueryValue(
                  query[key],
                  type,
                  request,
                  key,
                );
            }
          }
          // Path segments are strings; numeric ids (`/:id`) need numbers.
          let coercedParams = params;
          if (params && route.coercions.length) {
            for (const { key, type } of route.coercions) {
              if (type !== "number" || typeof params[key] !== "string")
                continue;
              const value = Number(params[key]);
              if (Number.isNaN(value)) continue;
              if (coercedParams === params) coercedParams = { ...params };
              coercedParams[key] = value;
            }
          }
          let input = readLike
            ? runtime.mergeInput(coercedQuery, coercedParams, body)
            : runtime.mergeInput(coercedParams, body, coercedQuery);
          if (objectInput) input ??= {};
          return input;
        }
      : () => undefined;
    const validateInput = (input: unknown) => {
      if (inputChecker) {
        runtime.checkDepth(input, route.action);
        runtime.validate(inputChecker, input, route.action, "input");
      }
    };
    const validateOutput = (result: unknown) => {
      if (route.output && outputChecker)
        runtime.validate(outputChecker, result, route.action, "output");
      return result;
    };
    const createContext = ({
      headers,
      request,
      set,
    }: any): ActionContext & { requestId: string } => {
      const seq = runtime.nextSequence();
      const traceId = headers?.["x-trace-id"] || "tr_" + seq;
      const requestId = headers?.["x-request-id"] || "req_" + seq;
      if (set?.headers) {
        set.headers["x-trace-id"] = traceId;
        set.headers["x-request-id"] = requestId;
      }
      return {
        request: request instanceof Request ? request : runtime.defaultRequest,
        traceId,
        requestId,
        db: cachedDb ?? service.getDb(),
        logger,
        services: runtime.emptyServices,
        deps: service.deps ?? runtime.emptyServices,
        metadata: { headers },
        _resolved: true,
      };
    };
    if (contextHook || authorize) {
      return async function brickAction(context) {
        const input = readInput(context);
        const ctx = createContext(context);
        try {
          if (contextHook) {
            const extra = await contextHook(ctx);
            if (extra) Object.assign(ctx, extra);
          }
          validateInput(input);
          if (authorize && !(await authorize({ ctx, input, user: ctx.user })))
            runtime.deny(route.action, ctx.user);
          return validateOutput(
            await execute({ input, ctx, error: errorBuilder }),
          );
        } catch (err) {
          return runtime.mapError(err, context.set, ctx);
        }
      };
    }
    return function brickAction(context) {
      const input = readInput(context);
      const ctx = createContext(context);
      try {
        validateInput(input);
        const result = execute({ input, ctx, error: errorBuilder });
        if (runtime.isThenable(result))
          return Promise.resolve(result)
            .then(validateOutput)
            .catch((err) => runtime.mapError(err, context.set, ctx));
        return validateOutput(result);
      } catch (err) {
        return runtime.mapError(err, context.set, ctx);
      }
    };
  };
}
