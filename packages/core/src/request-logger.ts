import { Elysia, type Context } from "elysia";

export interface RequestLoggingOptions {
  enabled?: boolean;
  logger?: (msg: string) => void;
}

function formatLog(
  method: string,
  path: string,
  status: string | number,
  elapsedMs: number,
): string {
  return `${method} ${path} → ${String(status)} (${elapsedMs}ms)`;
}

/**
 * Status carried by the thrown error (Elysia sets e.g. 404 on NotFoundError
 * while `set.status` may still hold the 200 default when onError runs).
 */
function thrownStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status: unknown = error.status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/**
 * Elysia plugin that logs each request as `METHOD path → status (elapsedms)`.
 * Timing is tracked per-Request via a WeakMap. The onError hook only logs and
 * returns undefined so existing error mapping is preserved. Logging only —
 * no CORS headers are set here.
 *
 * Hooks are registered with the "global" scope so they propagate to the
 * parent app when mounted via `app.use(...)` — Elysia scopes plain instance
 * hooks to the plugin's own routes. Timing is captured in beforeHandle
 * because request hooks are not propagated from a
 * used instance. Unmatched routes (no beforeHandle) fall back to Date.now().
 */
export function requestLoggingPlugin(opts: RequestLoggingOptions = {}): Elysia {
  const plugin = new Elysia();
  const enabled = opts.enabled ?? true;
  if (!enabled) return plugin;
  const logger = opts.logger ?? console.log;
  const startedAt = new WeakMap<object, number>();

  const markStarted = ({ request }: Pick<Context, "request">): void => {
    startedAt.set(request, Date.now());
  };

  const logSuccess = ({
    request,
    set,
  }: Pick<Context, "request" | "set">): void => {
    const start = startedAt.get(request) ?? Date.now();
    const path = new URL(request.url).pathname;
    logger(
      formatLog(request.method, path, set.status ?? 200, Date.now() - start),
    );
  };

  const logError = ({
    request,
    set,
    error,
  }: Pick<Context, "request" | "set"> & { error?: unknown }): undefined => {
    if (request) {
      const start = startedAt.get(request) ?? Date.now();
      const path = new URL(request.url).pathname;
      const status = thrownStatus(error) ?? set.status ?? 500;
      logger(formatLog(request.method, path, status, Date.now() - start));
    }
    return undefined;
  };

  plugin.onBeforeHandle("global", markStarted);
  plugin.onAfterHandle("global", logSuccess);
  plugin.onError("global", logError);

  return plugin;
}
