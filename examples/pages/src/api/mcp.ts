import {
  createMcpHandler as createBrickMcpHandler,
  traceRoute,
} from "@brickkit/core";
import { requireMcpAuth } from "@better-auth/mcp";

import { getAuth, type PagesAuth } from "./auth";
import { baseUrlSecret, mcpResourceSecret } from "./secrets";
import { pageMcpRegistry } from "./services/pages/mcp";

// MCP JSON-RPC transport over HTTP (Go `server/mcp` parity): bearer tokens
// minted by the better-auth `mcp()` OAuth plugin authorize `tools/call`, and
// missing/invalid tokens yield a 401 with a `WWW-Authenticate` header
// pointing at the protected-resource metadata.

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "pages-agent", version: "0.1.0" };

export function mcpResource(): string {
  return mcpResourceSecret.value() as string;
}

/** RFC 9728 protected-resource metadata document (Go parity shape). */
export function protectedResourceMetadata(): {
  authorization_servers: string[];
  resource: string;
} {
  return {
    authorization_servers: [baseUrlSecret.value() as string],
    resource: mcpResource(),
  };
}

const handleJsonRpc = createBrickMcpHandler({
  registry: pageMcpRegistry,
  protocolVersions: [PROTOCOL_VERSION],
  serverInfo: SERVER_INFO,
});

/**
 * Bearer-protecting `/mcp` handler. Verifies the JWT against the
 * authorization server JWKS (signature, issuer, audience, expiry);
 * unauthenticated requests get a JSON-RPC 401 with the RFC 9728
 * `WWW-Authenticate` challenge.
 */
export function createMcpHandler(auth: PagesAuth = getAuth()) {
  return requireMcpAuth(
    auth,
    (request, claims) =>
      handleJsonRpc(
        request,
        typeof claims.sub === "string"
          ? { user: { id: claims.sub } }
          : undefined,
      ),
    { resource: mcpResource() },
  );
}

/** Forward a root discovery request into the better-auth handler. */
async function forwardToAuth(
  request: Request,
  targetPath: string,
): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = targetPath;
  return getAuth().handler(new Request(url.toString(), request));
}

function discoveryResponse(request: Request, targetPath: string) {
  return forwardToAuth(request, targetPath);
}

/** Mount the MCP transport + OAuth discovery routes (Go `main.go` parity). */
export function registerMcpRoutes(app: {
  get(path: string, handler: (ctx: any) => unknown): unknown;
  post(path: string, handler: (ctx: any) => unknown): unknown;
}): void {
  // Initialize auth on the first request so loading app definitions for client
  // generation does not open a database connection.
  let mcpHandler: ReturnType<typeof createMcpHandler> | undefined;
  app.post(
    "/mcp",
    traceRoute("/mcp", ({ request }: any) => {
      mcpHandler ??= createMcpHandler();
      return mcpHandler(request);
    }),
  );

  const metadata = () => Response.json(protectedResourceMetadata());
  app.get("/.well-known/oauth-protected-resource", metadata);
  app.get("/.well-known/oauth-protected-resource/mcp", metadata);

  // MCP clients discover the AS from the issuer URL and look for metadata at
  // the root /.well-known paths. Proxy them to the plugin endpoints under
  // /api/auth.
  app.get("/jwks", ({ request }: any) =>
    discoveryResponse(request, "/api/auth/jwks"),
  );
  app.get("/.well-known/oauth-authorization-server", ({ request }: any) =>
    discoveryResponse(
      request,
      "/api/auth/.well-known/oauth-authorization-server",
    ),
  );
  app.get("/.well-known/openid-configuration", ({ request }: any) =>
    discoveryResponse(request, "/api/auth/.well-known/openid-configuration"),
  );
}
