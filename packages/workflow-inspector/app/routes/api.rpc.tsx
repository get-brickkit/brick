/**
 * Resource route that serves the server's `rpcMethods`.
 *
 * Client code calls these via fetch POST to /api/rpc with a CBOR-encoded
 * body containing { method, params }. Responses are CBOR-encoded, which
 * preserves Uint8Array values for client-side hydration/deserialization.
 */

import { decode, encode } from "cbor-x";
import {
  READ_METHODS,
  rpcMethods,
} from "~/server/workflow-server-actions.server";
import type { Route } from "./+types/api.rpc";
import type { World } from "@workflow/world";
import { callerContext, worldContext } from "../server/inspector-host.server";

function cborResponse(data: unknown, status = 200): Response {
  const encoded = encode(data);
  return new Response(new Uint8Array(encoded), {
    status,
    headers: { "Content-Type": "application/cbor" },
  });
}

const withoutToken = ({
  token: _token,
  ...rest
}: Record<string, unknown>): Record<string, unknown> => rest;

/** Brick change: a hook's token resumes it from outside the inspector, so a read-only caller is sent none. */
function withoutHookTokens(row: any): unknown {
  if (row?.hookId) return withoutToken(row);
  if (row?.eventData?.token)
    return { ...row, eventData: withoutToken(row.eventData) };
  return row;
}

export async function action({ request, context }: Route.ActionArgs) {
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

  const caller = context.get(callerContext);
  if (caller?.readOnly && !READ_METHODS.has(method)) {
    return cborResponse(
      { success: false, error: { message: caller.refusal, layer: "server" } },
      403,
    );
  }

  // The client's `rpc()` is typed against `rpcMethods`; the body itself is not checked.
  // Each method catches its own errors and returns them.
  const handler = rpcMethods[method as keyof typeof rpcMethods] as (
    world: World,
    params: object,
  ) => Promise<unknown>;
  const answer = (await handler(context.get(worldContext), params ?? {})) as {
    success: boolean;
    data?: any;
  };
  if (caller?.readOnly && answer.success)
    answer.data = Array.isArray(answer.data?.data)
      ? { ...answer.data, data: answer.data.data.map(withoutHookTokens) }
      : withoutHookTokens(answer.data);
  return cborResponse(answer);
}
