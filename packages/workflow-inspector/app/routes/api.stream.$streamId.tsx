/**
 * Resource route for streaming data.
 * GET /api/stream/:streamId?runId=...&cursor=...
 *
 * Returns concatenated binary data — deserialization and decryption happen
 * client-side. When `cursor` is provided, only chunks after that position
 * are returned (used for incremental polling).
 *
 * Response headers:
 *   X-Stream-Cursor  – cursor to send back on the next request
 *   X-Stream-Done    – "true" when the stream is fully closed
 */

import { STREAM_CURSOR_HEADER, STREAM_DONE_HEADER } from "~/lib/types";
import { readStreamChunksServerAction } from "~/server/workflow-server-actions.server";
import type { Route } from "./+types/api.stream.$streamId";

export async function loader({ params, request, context }: Route.LoaderArgs) {
  const { streamId } = params;

  if (!streamId || !/^[\w-]+$/.test(streamId)) {
    return Response.json(
      { message: "Invalid stream ID", layer: "server" },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");

  if (!runId) {
    return Response.json(
      { message: "Missing runId parameter", layer: "server" },
      { status: 400 },
    );
  }

  const cursor = url.searchParams.get("cursor") ?? undefined;

  // The action catches its own errors and returns them.
  const result = await readStreamChunksServerAction(
    context.world,
    streamId,
    runId,
    cursor,
  );

  if (!("buffer" in result)) {
    return Response.json(result, { status: result.request?.status ?? 500 });
  }

  const headers: HeadersInit = {
    "Content-Type": "application/octet-stream",
    [STREAM_DONE_HEADER]: String(result.done),
    [STREAM_CURSOR_HEADER]: result.cursor,
  };

  return new Response(new Uint8Array(result.buffer), { headers });
}
