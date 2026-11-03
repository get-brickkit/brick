import { requireMcpAuth } from "@better-auth/mcp";

import { getAuth } from ".";
import { baseUrlSecret, mcpResourceSecret } from "../secrets";

// Better Auth behind `brick({ auth, mcp })`: session cookies for the web app,
// OAuth access tokens minted by the `mcp()` plugin for MCP clients.

const mcpResource = () => mcpResourceSecret.value() as string;
const hasToken = (request: Request) =>
  /^(bearer|dpop) /i.test(request.headers.get("authorization") ?? "");

/**
 * Better Auth's MCP guard: verifies the access token against the JWKS
 * (signature, issuer, audience, expiry, DPoP) and calls `onClaims`, or answers
 * with its 401 `WWW-Authenticate` challenge pointing at the metadata below.
 */
const guardMcp = (request: Request, onClaims: (sub: unknown) => Response) =>
  requireMcpAuth(getAuth(), (_request, claims) => onClaims(claims.sub), {
    resource: mcpResource(),
  })(request);

/** `auth.resolve`: the access token's subject, else the session's user. */
export async function resolveUser(request: Request) {
  if (hasToken(request)) {
    let sub: unknown;
    // A clone: the guard may read the body, and the MCP handler reads it next.
    await guardMcp(request.clone(), (claimed) => {
      sub = claimed;
      return new Response(null);
    });
    return typeof sub === "string" ? { id: sub } : null;
  }
  const session = await getAuth().api.getSession({ headers: request.headers });
  return session?.user ?? null;
}

/** `mcp.authorize`: MCP takes an access token for this resource, never a cookie. */
export function authorizeMcp({
  request,
  user,
}: {
  request: Request;
  user: unknown;
}) {
  return (
    (user != null && hasToken(request)) ||
    guardMcp(request, () => new Response(null, { status: 401 }))
  );
}

// MCP clients look for the authorization server's metadata at the root paths.
const DISCOVERY: Record<string, string> = {
  "/jwks": "/api/auth/jwks",
  "/.well-known/oauth-authorization-server":
    "/api/auth/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration":
    "/api/auth/.well-known/openid-configuration",
};
const PROTECTED_RESOURCE = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
]);

/** `auth.handler`: Better Auth's routes, its discovery, and RFC 9728 metadata. */
export function authRoutes(request: Request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/auth/")) return getAuth().handler(request);
  if (PROTECTED_RESOURCE.has(url.pathname))
    return Response.json({
      authorization_servers: [baseUrlSecret.value() as string],
      resource: mcpResource(),
    });
  const target = DISCOVERY[url.pathname];
  if (!target) return undefined;
  url.pathname = target;
  return getAuth().handler(new Request(url, request));
}
