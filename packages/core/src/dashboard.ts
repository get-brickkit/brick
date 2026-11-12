import type { DashboardIdentity } from "./dashboard-identity";

/** Who may open the dashboard that `brick start` serves for monitoring. */
export interface DashboardAuth {
  /**
   * Secrets that let a request in. A browser asks for one in its sign-in
   * prompt (any user name, the secret as the password), and monitors and
   * scripts send `Authorization: Bearer <secret>`. Give several to rotate one
   * while the other still works. Each is at least 16 characters long;
   * `openssl rand -base64 32` makes a good one.
   */
  token?: string | readonly string[];
  /**
   * Your own check, to sign people in with the auth the app already has: read
   * a session cookie, verify a Better Auth or Clerk session, look at a header
   * a proxy adds. It receives the request (method, URL, and headers; no body)
   * and returns `true` to let it in, `false` to refuse it with 401, or a
   * `Response` to send instead, such as a redirect to your login page. If it
   * throws or takes longer than five seconds, the request is refused with 503.
   *
   * Return `{ user: { id, name } }` to let it in and say who it is: requests
   * the dashboard's pages send to the app through `/app/*` carry that user,
   * signed, which the app reads with `ctx.dashboard?.user` in an action or
   * `dashboardUser(request)` in an endpoint.
   *
   * A request is let in when it carries a valid `token`, or when this
   * returns `true`; give both to let monitors in by token and people in by
   * sign-in.
   */
  authorize?: (
    request: Request,
  ) =>
    | boolean
    | Response
    | DashboardIdentity
    | Promise<boolean | Response | DashboardIdentity>;
}

/**
 * The monitoring dashboard `brick start` serves beside the app, on a port of
 * its own: live requests, logs, errors, and the shape of the service, so it
 * stays reachable when the app's own routes are not. `brick dev` has its own
 * dashboard, set by command line options, and ignores this.
 *
 * Setting it turns on `telemetry`, since the dashboard shows what is traced.
 * While it is on, `ctx.logger` and `console` lines written during a request
 * go to the dashboard instead of the console.
 */
export interface DashboardOptions {
  /** Default 9400. */
  port?: number;
  /**
   * The address to listen on. Default `127.0.0.1`, reachable only from the same
   * machine. In a container use `0.0.0.0`, which needs `auth`: the dashboard
   * will not start on any other address without it.
   */
  host?: string;
  auth?: DashboardAuth;
  /**
   * Days of finished requests to keep on disk, in `.brick/` of the working
   * folder. Default 0: only what happened since the process started, which is
   * lost when it restarts. Needs a folder that outlives the container.
   */
  historyDays?: number;
}

const MIN_TOKEN_LENGTH = 16;

/**
 * Check what `brick()` was given, and freeze it. The secrets sit behind a getter
 * that is not enumerable, so logging or serializing the application definition
 * does not print them.
 */
export function normalizeDashboard(
  options: DashboardOptions | undefined,
): DashboardOptions | undefined {
  if (options === undefined) return undefined;
  const { port, host, auth, historyDays } = options;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw new Error(
      `Brick: dashboard port must be an integer from 1 to 65535, not ${String(port)}.`,
    );
  if (host !== undefined && (typeof host !== "string" || host.trim() === ""))
    throw new Error(
      "Brick: dashboard host must be an address, such as '0.0.0.0'.",
    );
  if (
    historyDays !== undefined &&
    (!Number.isInteger(historyDays) || historyDays < 0)
  )
    throw new Error(
      `Brick: dashboard historyDays must be a whole number of days, not ${String(historyDays)}.`,
    );
  const normalized: DashboardOptions = {
    ...(port !== undefined ? { port } : {}),
    ...(host !== undefined ? { host: host.trim() } : {}),
    ...(historyDays !== undefined ? { historyDays } : {}),
  };
  if (auth !== undefined) {
    const tokens =
      auth.token === undefined
        ? undefined
        : typeof auth.token === "string"
          ? [auth.token]
          : [...auth.token];
    if (
      tokens?.some(
        (token) => typeof token !== "string" || token.length < MIN_TOKEN_LENGTH,
      )
    )
      throw new Error(
        `Brick: a dashboard token must be at least ${MIN_TOKEN_LENGTH} characters. Try: openssl rand -base64 32`,
      );
    if (auth.authorize !== undefined && typeof auth.authorize !== "function")
      throw new Error("Brick: dashboard authorize must be a function.");
    if ((tokens === undefined || tokens.length === 0) && !auth.authorize)
      throw new Error(
        "Brick: dashboard auth needs a token or an authorize function.",
      );
    const secrets = Object.freeze({
      ...(tokens ? { token: Object.freeze(tokens) } : {}),
      ...(auth.authorize ? { authorize: auth.authorize } : {}),
    });
    // A getter, so inspecting the object (Bun prints hidden fields too) shows
    // `[Getter]` and not the secrets.
    Object.defineProperty(normalized, "auth", {
      enumerable: false,
      get: () => secrets,
    });
  }
  return Object.freeze(normalized);
}
