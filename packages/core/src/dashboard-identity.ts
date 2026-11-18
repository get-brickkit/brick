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

const sign = (claims: object, now: number): string => {
  const payload = Buffer.from(
    JSON.stringify({ ...claims, exp: now + SIGNATURE_TTL_MS }),
  ).toString("base64url");
  return `${payload}.${mac(payload).toString("base64url")}`;
};

/** The header value for an identity: `<base64url(json)>.<hmac>`. */
export function signDashboardIdentity(
  identity: DashboardIdentity,
  now = Date.now(),
): string {
  return sign({ user: identity.user }, now);
}

/** The claims of a request's signed header, when the signature and its time are good. */
function verifiedClaims(
  request: Request | undefined,
): { user?: DashboardUser; scope?: unknown; write?: unknown } | undefined {
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
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const now = (request && arrivedAt.get(request)) ?? Date.now();
    if (typeof claims?.exp !== "number" || claims.exp < now) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

/**
 * Who a request came from, through the dashboard's `/app/*` proxy. A signature
 * made for the MCP route carries a `scope`, and is not an identity here.
 */
export function dashboardIdentity(
  request: Request | undefined,
): DashboardIdentity | undefined {
  const claims = verifiedClaims(request);
  if (!claims || claims.scope !== undefined) return undefined;
  return claims.user === undefined ? {} : { user: claims.user };
}

/** Who a call forwarded by the dashboard's `/mcp` is for, and whether tools that change data may run. */
export interface DashboardMcpCaller extends DashboardIdentity {
  write: boolean;
}

/**
 * The header value for a call the dashboard's `/mcp` forwards to the app. It is
 * scoped to the MCP route: the `/app` proxy never signs one, and a signature
 * made for `/app` is not accepted there.
 */
export function signDashboardMcp(
  caller: DashboardMcpCaller,
  now = Date.now(),
): string {
  return sign({ user: caller.user, scope: "mcp", write: caller.write }, now);
}

/** The caller of a request signed with `signDashboardMcp`; undefined for any other. */
export function dashboardMcpCaller(
  request: Request | undefined,
): DashboardMcpCaller | undefined {
  const claims = verifiedClaims(request);
  if (claims?.scope !== "mcp") return undefined;
  return {
    ...(claims.user === undefined ? {} : { user: claims.user }),
    write: claims.write === true,
  };
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
