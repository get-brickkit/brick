/**
 * RPC client for calling the server's `rpcMethods` via the /api/rpc resource route.
 *
 * Uses CBOR encoding for both requests and responses to preserve
 * Uint8Array values (binary serialized data) across the wire.
 * Client-side code is responsible for hydrating/deserializing the data.
 */

import { decode, encode } from "cbor-x";
import type { RpcMethods } from "~/server/workflow-server-actions.server";

/** Calls a server RPC method; type-checked against the server's own signature. */
export async function rpc<M extends keyof RpcMethods>(
  method: M,
  params: Parameters<RpcMethods[M]>[1],
): Promise<Awaited<ReturnType<RpcMethods[M]>>> {
  const res = await fetch(`${import.meta.env.BASE_URL}api/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/cbor",
      Accept: "application/cbor",
    },
    body: new Uint8Array(encode({ method, params })),
  });
  const buffer = new Uint8Array(await res.arrayBuffer());
  if (res.ok) return decode(buffer);
  let message: string | undefined;
  try {
    message = decode(buffer)?.error?.message;
  } catch {
    // Not a CBOR error body: report the status instead.
  }
  throw new Error(
    message ?? `RPC call ${method} failed: ${res.status} ${res.statusText}`,
  );
}
