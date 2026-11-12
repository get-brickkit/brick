import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The person `dashboard.auth.authorize` let in. */
export interface DashboardUser {
  id: string;
  name?: string;
}

/**
 * Who a request came from, when it reached the app through the dashboard's
 * `/app/*` proxy. `user` is missing when the dashboard let the request in
 * without one: by token, by `authorize` returning `true`, or with no `auth`.
 */
export interface DashboardIdentity {
  user?: DashboardUser;
}

/** The header the dashboard's `/app/*` proxy signs the identity into. */
export const DASHBOARD_IDENTITY_HEADER = "x-brick-dashboard";
/** How `brick dev` hands the signing key to the app's process. */
export const DASHBOARD_KEY_ENV = "BRICK_DASHBOARD_KEY";
/** The proxy signs each request as it forwards it, so a copy goes stale fast. */
const MAX_AGE_MS = 60_000;
// Shared through globalThis: the CLI and the app may each hold their own copy of core.
const KEY = Symbol.for("brickkit.dashboard.key");

/**
 * The key the dashboard signs identities with: random per process, or the one
 * `brick dev` handed the app's process. Taken out of the environment once
 * read, so processes the app starts do not inherit it.
 */
export function dashboardKey(): string {
  const global = globalThis as Record<symbol, string | undefined>;
  if (!global[KEY]) {
    global[KEY] =
      process.env[DASHBOARD_KEY_ENV] || randomBytes(32).toString("base64url");
    delete process.env[DASHBOARD_KEY_ENV];
  }
  return global[KEY];
}

const mac = (payload: string) =>
  createHmac("sha256", dashboardKey()).update(payload).digest();

/** The header value for an identity: `<base64url(json)>.<hmac>`. */
export function signDashboardIdentity(
  identity: DashboardIdentity,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ user: identity.user, exp: now + MAX_AGE_MS }),
  ).toString("base64url");
  return `${payload}.${mac(payload).toString("base64url")}`;
}

/**
 * The identity the dashboard signed into `request`, or undefined when the
 * header is missing, malformed, wrongly signed or stale.
 */
export function dashboardIdentity(
  request: Request | undefined,
): DashboardIdentity | undefined {
  const header = request?.headers.get(DASHBOARD_IDENTITY_HEADER);
  if (!header) return undefined;
  const dot = header.indexOf(".");
  if (dot < 0) return undefined;
  const payload = header.slice(0, dot);
  const given = Buffer.from(header.slice(dot + 1), "base64url");
  const expected = mac(payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return undefined;
  try {
    const { user, exp } = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (typeof exp !== "number" || exp < Date.now()) return undefined;
    return user === undefined ? {} : { user };
  } catch {
    return undefined;
  }
}

/**
 * The dashboard user a request came from, for an endpoint: the person
 * `dashboard.auth.authorize` let in, when the request arrived through the
 * dashboard's `/app/*` proxy. Undefined for any other request, and for one the
 * dashboard let in by token. Actions read it as `ctx.dashboard?.user`.
 */
export function dashboardUser(request: Request): DashboardUser | undefined {
  return dashboardIdentity(request)?.user;
}
