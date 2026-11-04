import { publicOrigin } from "./socket";

/**
 * Which origins may call the app: an exact origin (`"https://app.example.com"`),
 * a list of them, or a predicate. `true` allows only the app's own origin.
 */
export type CorsOrigin =
  | true
  | string
  | readonly string[]
  | ((origin: string, request: Request) => boolean);

/** `brick({ cors })`: an origin rule, or the rule plus `credentials`. */
export type CorsOptions =
  | CorsOrigin
  | {
      /** Default `true`: the app's own origin only. */
      origin?: CorsOrigin;
      /** Send `Access-Control-Allow-Credentials: true` to allowed origins (cookies, auth headers). */
      credentials?: boolean;
    };

const METHODS = "GET, POST, PUT, PATCH, DELETE";

/**
 * A request hook that adds CORS headers for allowed origins and answers
 * preflights. An origin that doesn't match gets no `Access-Control-Allow-Origin`,
 * so the browser blocks it; origins are compared exactly and never reflected
 * unless the rule allows them.
 */
export function corsHook(cors: CorsOptions) {
  const { origin = true, credentials = false } =
    typeof cors === "object" && !Array.isArray(cors)
      ? (cors as Exclude<CorsOptions, CorsOrigin>)
      : { origin: cors as CorsOrigin };
  const list =
    typeof origin === "string"
      ? [origin]
      : Array.isArray(origin)
        ? (origin as readonly string[])
        : undefined;
  if (list?.includes("*"))
    throw new Error(
      'Brick: cors origin "*" is not supported. List the origins, or pass a predicate.',
    );
  const allows = (from: string, request: Request) =>
    origin === true
      ? from === publicOrigin(request)
      : typeof origin === "function"
        ? origin(from, request) === true
        : list!.includes(from);

  return ({
    request,
    set,
  }: {
    request: Request;
    set: { headers: Record<string, unknown> };
  }) => {
    const from = request.headers.get("origin");
    if (from === null) return;
    const headers: Record<string, string> = { vary: "Origin" };
    if (allows(from, request)) {
      headers["access-control-allow-origin"] = from;
      if (credentials) headers["access-control-allow-credentials"] = "true";
    }
    const preflight =
      request.method === "OPTIONS" &&
      request.headers.has("access-control-request-method");
    if (!preflight) {
      Object.assign(set.headers, headers);
      return;
    }
    if (headers["access-control-allow-origin"]) {
      headers["access-control-allow-methods"] = METHODS;
      const requested = request.headers.get("access-control-request-headers");
      if (requested) headers["access-control-allow-headers"] = requested;
    }
    return new Response(null, { status: 204, headers });
  };
}
