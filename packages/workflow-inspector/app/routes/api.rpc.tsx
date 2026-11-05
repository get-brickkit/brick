/**
 * Resource route that serves the server's `rpcMethods`.
 *
 * Client code calls these via fetch POST to /api/rpc with a CBOR-encoded
 * body containing { method, params }. Responses are CBOR-encoded, which
 * preserves Uint8Array values for client-side hydration/deserialization.
 */

import { decode, encode } from "cbor-x";
import { rpcMethods } from "~/server/workflow-server-actions.server";
import type { Route } from "./+types/api.rpc";

function cborResponse(data: unknown, status = 200): Response {
  const encoded = encode(data);
  return new Response(new Uint8Array(encoded), {
    status,
    headers: { "Content-Type": "application/cbor" },
  });
}

export async function action({ request }: Route.ActionArgs) {
  // Decode request body — accept both CBOR and JSON
  let body: { method: unknown; params: unknown };
  const contentType = request.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/cbor")) {
      const buffer = await request.arrayBuffer();
      body = decode(new Uint8Array(buffer));
    } else {
      body = await request.json();
    }
  } catch {
    return cborResponse(
      {
        success: false,
        error: { message: "Malformed request body", layer: "server" },
      },
      400,
    );
  }

  const { method, params } = body;

  if (typeof method !== "string" || !Object.hasOwn(rpcMethods, method)) {
    return cborResponse(
      {
        success: false,
        error: { message: `Unknown method: ${method}`, layer: "server" },
      },
      400,
    );
  }

  try {
    // The client's `rpc()` is typed against `rpcMethods`; the body itself is not checked.
    const handler = rpcMethods[method as keyof typeof rpcMethods] as (
      params: object,
    ) => Promise<unknown>;
    return cborResponse(await handler(params ?? {}));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return cborResponse(
      { success: false, error: { message, layer: "server" } },
      500,
    );
  }
}
