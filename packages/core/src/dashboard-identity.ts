import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GLOBAL_SYMBOL } from "./telemetry-names";

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
const SIGNATURE_TTL_MS = 60_000;
const KEY = Symbol.for(GLOBAL_SYMBOL.dashboardKey);
const global = globalThis as Record<symbol, string | undefined>;
function hideKeyFromChildProcesses(): void {
  const handedOver = process.env[DASHBOARD_KEY_ENV];
  if (!handedOver) return;
  global[KEY] = handedOver;
  delete process.env[DASHBOARD_KEY_ENV];
}
hideKeyFromChildProcesses();

/**
 * The key the dashboard signs identities with: random per process, or the one
 * `brick dev` or the Vite plugin handed the app.
 */
export function dashboardKey(): string {
  return (global[KEY] ??= randomBytes(32).toString("base64url"));
}

// When each request reached the app, so a slow upload's body does not age its signature.
const arrivedAt = new WeakMap<Request, number>();

/** Note when `request` arrived, before its body is read. */
export function markDashboardArrival(request: Request): void {
  arrivedAt.set(request, Date.now());
}

const mac = (payload: string) =>
  createHmac("sha256", dashboardKey()).update(payload).digest();

/** The header value for an identity: `<base64url(json)>.<hmac>`. */
export function signDashboardIdentity(
  identity: DashboardIdentity,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ user: identity.user, exp: now + SIGNATURE_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${mac(payload).toString("base64url")}`;
}

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
    const now = (request && arrivedAt.get(request)) ?? Date.now();
    if (typeof exp !== "number" || exp < now) return undefined;
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
