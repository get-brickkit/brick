import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DashboardAuth } from "@brickkit/core";

/** What to do with a request: let it through, or answer it with this. */
export type Access =
  | { allowed: true }
  | {
      allowed: false;
      status: number;
      headers: Record<string, string | string[]>;
      body: string | Uint8Array;
    };

/** How long the app's `authorize` may take before the request is refused. */
const AUTHORIZE_TIMEOUT_MS = 5000;

/** Whether `host` can only be reached from the machine it runs on. */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase();
  return (
    name === "localhost" ||
    name === "::1" ||
    name === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(name)
  );
}

const NOT_COPIED = new Set([
  "set-cookie",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Whether `candidate` is one of `tokens`, in the same time whichever it is. */
function isToken(candidate: string | undefined, tokens: readonly string[]) {
  if (candidate === undefined) return false;
  const given = digest(candidate);
  let match = false;
  // Every token is compared, so the time does not say which one was close.
  for (const token of tokens)
    if (timingSafeEqual(given, digest(token))) match = true;
  return match;
}

/** The secret in an `Authorization` header: a Bearer token, or a Basic password. */
function credential(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const space = header.indexOf(" ");
  if (space < 0) return undefined;
  const scheme = header.slice(0, space).toLowerCase();
  const value = header.slice(space + 1).trim();
  if (scheme === "bearer") return value;
  if (scheme === "basic") {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon < 0 ? undefined : decoded.slice(colon + 1);
  }
  return undefined;
}

/** The protocol the client used: https when a proxy in front terminated TLS and says so. */
export function requestProtocol(request: IncomingMessage): "http" | "https" {
  const forwarded = request.headers["x-forwarded-proto"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded)
    ?.split(",")[0]
    ?.trim() === "https"
    ? "https"
    : "http";
}

/** The request as the app's `authorize` sees it: standard, with no body. */
function webRequest(request: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    try {
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    } catch {
      // A header the platform will not take cannot matter to a check.
    }
  }
  const protocol = requestProtocol(request);
  const host = request.headers.host ?? "localhost";
  let url: string;
  try {
    url = new URL(request.url ?? "/", `${protocol}://${host}`).href;
  } catch {
    url = `${protocol}://localhost${request.url ?? "/"}`;
  }
  return new Request(url, { method: request.method ?? "GET", headers });
}

const refusal = (
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Access => ({
  allowed: false,
  status,
  body,
  headers: { "content-type": "text/plain; charset=utf-8", ...headers },
});

/**
 * The check for the dashboard's requests. A request passes with a valid token,
 * or when the app's `authorize` returns `true`. Anything else is answered:
 * what `authorize` returned if it returned a `Response`, else 401 (with a
 * browser sign-in prompt when tokens are in use), and 503 when `authorize`
 * threw or ran out of time, since a check that cannot answer must not let
 * anyone in.
 */
export function createAccess(
  auth: DashboardAuth,
  onError: (error: unknown) => void = () => {},
  timeoutMs = AUTHORIZE_TIMEOUT_MS,
): (request: IncomingMessage) => Promise<Access> {
  const tokens =
    auth.token === undefined
      ? []
      : typeof auth.token === "string"
        ? [auth.token]
        : [...auth.token];
  const prompt: Record<string, string> =
    tokens.length > 0
      ? { "www-authenticate": 'Basic realm="Brick dashboard", charset="UTF-8"' }
      : {};
  return async (request) => {
    if (tokens.length > 0 && isToken(credential(request), tokens))
      return { allowed: true };
    if (!auth.authorize) return refusal(401, "Unauthorized", prompt);

    let decision: boolean | Response;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      decision = await Promise.race([
        Promise.resolve(auth.authorize(webRequest(request))),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("dashboard authorize timed out")),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      onError(error);
      return refusal(503, "Sign-in is unavailable.");
    } finally {
      clearTimeout(timer);
    }
    if (decision === true) return { allowed: true };
    if (decision instanceof Response) {
      const headers: Record<string, string | string[]> = {};
      decision.headers.forEach((value, name) => {
        // The body is sent as bytes with its own length; these describe the
        // connection or an encoding already undone.
        if (!NOT_COPIED.has(name)) headers[name] = value;
      });
      const cookies = decision.headers.getSetCookie();
      if (cookies.length > 0) headers["set-cookie"] = cookies;
      return {
        allowed: false,
        status: decision.status,
        headers,
        body: new Uint8Array(await decision.arrayBuffer()),
      };
    }
    return refusal(401, "Unauthorized", prompt);
  };
}
