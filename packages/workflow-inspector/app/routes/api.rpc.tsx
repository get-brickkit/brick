/**
 * Resource route that serves the server's `rpcMethods`.
 *
 * Client code calls these via fetch POST to /api/rpc with a CBOR-encoded
 * body containing { method, params }. Responses are CBOR-encoded, which
 * preserves Uint8Array values for client-side hydration/deserialization.
 */

import { hydrateResourceIO } from "@workflow/web-shared";
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

/** Brick change: values JSON has no form for, as plain ones. */
function plainValue(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
  if (value instanceof Map || value instanceof Headers)
    return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === "bigint") return value.toString();
  return value;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, plainValue), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Brick change: a run, step or event as the page reads it, its serialized input, output and error turned into values. */
function hydrated(row: unknown): unknown {
  try {
    return hydrateResourceIO(row);
  } catch {
    return row;
  }
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
  // Brick change: a caller that asks for JSON (the dashboard's MCP) gets it,
  // with run, step and event data hydrated; the page asks for CBOR as before.
  const json = (request.headers.get("accept") ?? "").includes(
    "application/json",
  );
  const respond = json ? jsonResponse : cborResponse;
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
    return respond(
      {
        success: false,
        error: { message: "Malformed request body", layer: "server" },
      },
      400,
    );
  }

  const { method, params } = body;

  if (typeof method !== "string" || !Object.hasOwn(rpcMethods, method)) {
    return respond(
      {
        success: false,
        error: { message: `Unknown method: ${method}`, layer: "server" },
      },
      400,
    );
  }

  const caller = context.get(callerContext);
  if (caller?.readOnly && !READ_METHODS.has(method)) {
    return respond(
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
  if (json && answer.success)
    answer.data = Array.isArray(answer.data?.data)
      ? { ...answer.data, data: answer.data.data.map(hydrated) }
      : hydrated(answer.data);
  return respond(answer);
}
