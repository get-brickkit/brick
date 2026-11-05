import type { TSchema } from "@sinclair/typebox";
import {
  type Action,
  type ActionConfigWithAuthorize,
  type ActionConfigWithoutAuthorize,
  type ActionContext,
  type ActionErrorDefinition,
  type ErrorBuilder,
  ActionExecutionError,
} from "./types";
import { normalizeActionError } from "./error-response";
import { validateWithSchema } from "./typebox";
import { actionMeta } from "./action-meta";
import { baseContext } from "./context";
import { authorizeCall, invalid } from "./compiler/runtime";

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
    const errors = actionMeta(actionFn).checkInput?.(input);
    return errors
      ? { success: false as const, errors }
      : validateWithSchema(config.input, input);
  };

  actionFn.validateOutput = (output: unknown) =>
    validateWithSchema(
      actionMeta(actionFn).runtimeOutput ?? config.output,
      output,
    );

  actionFn.run = async (input?: any, ctx?: any) => {
    return actionFn.execute({ input, ctx });
  };

  actionFn.execute = async (params: { input?: any; ctx?: any }) => {
    const meta = actionMeta(actionFn);
    // The registered service resolves the context once per request, and
    // recognizes one it already resolved.
    let ctx: any = meta.service
      ? await meta.service.resolveContext(params?.ctx)
      : { ...baseContext(params?.ctx ?? {}), ...params?.ctx };
    // A plugin's action runs with the deps of the install that created it.
    if (meta.deps) ctx = { ...ctx, deps: meta.deps.values };
    const input = params?.input;
    try {
      if (config.input) {
        const checked = actionFn.validateInput(input);
        if (!checked.success)
          throw invalid(config.name, "input", checked.errors);
      }
      await authorizeCall(config.authorize, ctx, input, config.name);
      const result = await config.execute({ input, ctx, error: errorHelpers });
      if (actionMeta(actionFn).runtimeOutput ?? config.output) {
        const checked = actionFn.validateOutput(result);
        if (!checked.success)
          throw invalid(config.name, "output", checked.errors);
      }
      return result;
    } catch (err) {
      throw normalizeActionError(err, ctx);
    }
  };

  return actionFn;
}
