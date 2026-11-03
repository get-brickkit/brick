import type { TSchema } from "@sinclair/typebox";
import {
  type Action,
  type ActionConfigWithAuthorize,
  type ActionConfigWithoutAuthorize,
  type ActionContext,
  type ActionErrorDefinition,
  type ErrorBuilder,
  type BaseContext,
  ActionExecutionError,
  ValidationError,
  type Logger,
} from "./types";
import { normalizeActionError } from "./error-response";
import { validateWithSchema } from "./typebox";
import { getGlobalRegistry } from "./registry";
import { createLogger, DEFAULT_LOG_PREFIXES } from "./logger";

const defaultLogger: Logger = createLogger(DEFAULT_LOG_PREFIXES);

const DEFAULT_REQUEST = new Request("http://localhost");
let _defaultCtxSeq = 0;

// Symbol to tie context resolution to a specific service instance and invocation
const RESOLVED_SYMBOL = Symbol("resolved");

const standardErrorDefaults: Record<
  string,
  { status: number; message: string }
> = {
  BAD_REQUEST: { status: 400, message: "Bad Request" },
  UNAUTHORIZED: { status: 401, message: "Unauthorized" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "Not Found" },
  CONFLICT: { status: 409, message: "Conflict" },
  INTERNAL_SERVER_ERROR: { status: 500, message: "Internal Server Error" },
};

function createDefaultContext(partial?: any): BaseContext & any {
  // Only accept pre-resolved context with a service-specific marker or when service will handle resolution
  if (partial?.[RESOLVED_SYMBOL]) return partial;
  const seq = (++_defaultCtxSeq).toString(36);
  const req = partial?.request ?? DEFAULT_REQUEST;
  return {
    request: req,
    traceId: partial?.traceId || `tr_${seq}`,
    requestId: partial?.requestId || `req_${seq}`,
    db: partial?.db,
    user: partial?.user,
    logger: partial?.logger || defaultLogger,
    services: partial?.services || {},
    metadata: partial?.metadata || {},
    ...partial,
    [RESOLVED_SYMBOL]: true,
  };
}

/**
 * The `error` helpers an action receives: one function per error code that
 * throws an `ActionExecutionError` with that code and status. The standard HTTP
 * codes (`BAD_REQUEST`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
 * `INTERNAL_SERVER_ERROR`) are always there; the action's own `errors` add to
 * them or replace one.
 *
 * @param errorsDef - The action's `errors`: for each code, its `message` and
 * `status` (default 400).
 * @returns Helpers that take an optional message, `details`, and `ErrorOptions`,
 * and always throw.
 */
export function buildErrorHelpers<
  TErrors extends Record<string, ActionErrorDefinition>,
>(errorsDef?: TErrors): ErrorBuilder<TErrors> {
  const helpers: Record<string, any> = {};

  // 1. Populate standard HTTP error helpers
  for (const [code, def] of Object.entries(standardErrorDefaults)) {
    helpers[code] = (
      overrideMessage?: string,
      details?: unknown,
      options?: ErrorOptions,
    ) => {
      const message = overrideMessage || def.message;
      const status = def.status;
      throw new ActionExecutionError(code, message, status, details, options);
    };
  }

  // 2. Populate or override with user-defined action errors
  if (errorsDef) {
    for (const [code, def] of Object.entries(errorsDef)) {
      helpers[code] = (
        overrideMessage?: string,
        details?: unknown,
        options?: ErrorOptions,
      ) => {
        const message = overrideMessage || def.message;
        const status = def.status || 400;
        throw new ActionExecutionError(code, message, status, details, options);
      };
    }
  }

  return helpers as ErrorBuilder<TErrors>;
}

// Lives with the step helpers, which workflow code imports without the server.
export { defineError } from "./workflow";

/** The `errors` map of an action, to re-declare in another action or listener: `errors: { ...errorsOf(charge) }`. */
export function errorsOf<
  TErrors extends Record<string, ActionErrorDefinition>,
>(action: { config: { errors?: TErrors } }): TErrors {
  return (action.config.errors ?? {}) as TErrors;
}

/**
 * Define an action: a typed, validated function that Brick serves over HTTP,
 * runs in-process, and exposes to the typed client and OpenAPI.
 *
 * A call runs in order: the input is validated against `input` (an invalid one
 * is a `VALIDATION_FAILED` error, HTTP 400); `authorize` runs, if there is one;
 * `execute` runs; and its result is validated against `output` (a mismatch is a
 * server error, HTTP 500). Throw `error.CODE(...)` from `execute` for a declared
 * failure or a standard one such as `error.NOT_FOUND()`. Any other thrown value
 * becomes `INTERNAL_SERVER_ERROR` (500), with the cause kept out of the response
 * and in the log.
 *
 * `authorize` returns `false` to refuse: the call fails with `UNAUTHORIZED`
 * (401) when there is no `ctx.user`, and `FORBIDDEN` (403) when there is one.
 * Where it is given, `execute` can rely on what it checked.
 *
 * @param config - `name`, `execute`, and optionally `description`, `input` and
 * `output` (TypeBox schemas), `errors`, `authorize`, `method` and `path` to
 * change the route (POST by default), `tags`, and `emits`.
 * @returns The action. Register it with `service.action(action)`; call it
 * directly with `action.run(input, ctx)`.
 * @example
 * import { defineAction, t } from "@brickkit/core";
 *
 * export const getPage = defineAction({
 *   name: "get",
 *   method: "GET",
 *   input: t.Object({ id: t.String() }),
 *   output: t.Object({ id: t.String(), title: t.String() }),
 *   errors: { PAGE_GONE: { message: "That page was removed", status: 410 } },
 *   authorize: ({ user }) => user != null,
 *   execute: async ({ input, ctx, error }) => {
 *     const page = await findPage(ctx.db, input.id);
 *     if (!page) throw error.NOT_FOUND("No such page");
 *     return page;
 *   },
 * });
 */
export function defineAction<
  TInputSchema extends TSchema | undefined = undefined,
  TOutputSchema extends TSchema | undefined = undefined,
  TErrors extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  TContext extends ActionContext = ActionContext,
>(
  config: ActionConfigWithAuthorize<
    TInputSchema,
    TOutputSchema,
    TErrors,
    TContext
  >,
): Action<TInputSchema, TOutputSchema, TErrors, TContext>;

export function defineAction<
  TInputSchema extends TSchema | undefined = undefined,
  TOutputSchema extends TSchema | undefined = undefined,
  TErrors extends Record<string, ActionErrorDefinition> = Record<
    string,
    ActionErrorDefinition
  >,
  TContext extends ActionContext = ActionContext,
>(
  config: ActionConfigWithoutAuthorize<
    TInputSchema,
    TOutputSchema,
    TErrors,
    TContext
  >,
): Action<TInputSchema, TOutputSchema, TErrors, TContext>;

export function defineAction(config: any): any {
  const errorHelpers = buildErrorHelpers(config.errors);

  const actionFn = (async (params: { input?: any; ctx?: any }) => {
    return actionFn.execute(params);
  }) as any;

  Object.defineProperty(actionFn, "name", {
    value: config.name,
    configurable: true,
  });

  actionFn.config = config;
  actionFn.errorHelpers = errorHelpers;

  actionFn.validateInput = (input: unknown) => {
    return validateWithSchema(config.input, input);
  };

  actionFn.validateOutput = (output: unknown) => {
    const runtimeSchema =
      (actionFn as { outputValidationSchema?: TSchema })
        .outputValidationSchema ?? config.output;
    return validateWithSchema(runtimeSchema, output);
  };

  actionFn.run = async (input?: any, ctx?: any) => {
    return actionFn.execute({ input, ctx });
  };

  actionFn.execute = async (params: { input?: any; ctx?: any }) => {
    const boundService = actionFn.service;
    // The bound service resolves the context once per request, and recognizes
    // one it already resolved.
    const fullCtx: any = boundService?.resolveContext
      ? await boundService.resolveContext(params?.ctx)
      : createDefaultContext(params?.ctx);

    try {
      // Fill ctx.db from the bound service or the registry when the call has none.
      if (!fullCtx.db) {
        const service =
          boundService ??
          (actionFn.serviceName
            ? getGlobalRegistry().get(actionFn.serviceName)
            : undefined);
        if (service?.getDb()) fullCtx.db = service.getDb();
      }

      // 1. Validate Input
      if (config.input) {
        const inputValidation = actionFn.validateInput(params?.input);
        if (!inputValidation.success) {
          throw new ValidationError(
            `Validation failed for action '${config.name}' input` as string,
            inputValidation.errors,
          );
        }
      }

      // 2. Authorize
      if (config.authorize) {
        const allowed = await config.authorize({
          user: fullCtx.user,
          input: params?.input,
          ctx: fullCtx,
        });
        if (!allowed) {
          throw new ActionExecutionError(
            fullCtx.user == null ? "UNAUTHORIZED" : "FORBIDDEN",
            `Access denied for action '${config.name}'`,
            fullCtx.user == null ? 401 : 403,
          );
        }
      }

      // 3. Execute implementation
      const result = await config.execute({
        input: params?.input,
        ctx: fullCtx,
        error: errorHelpers,
      });

      // 4. Validate Output
      const runtimeOutputSchema =
        (actionFn as { outputValidationSchema?: TSchema })
          .outputValidationSchema ?? config.output;
      if (runtimeOutputSchema) {
        const outputValidation = actionFn.validateOutput(result);
        if (!outputValidation.success) {
          throw new ValidationError(
            `Validation failed for action '${config.name}' output` as string,
            outputValidation.errors,
            500,
          );
        }
      }

      return result;
    } catch (err) {
      throw normalizeActionError(err, fullCtx);
    }
  };

  return actionFn;
}
