/**
 * Server-only module for workflow data access.
 *
 * The `.server.ts` suffix ensures Vite excludes this from client bundles.
 * `rpcMethods` is served by the `api/rpc` route, and its type is what the
 * client's `rpc()` checks calls against.
 */

import * as workflowRunHelpers from "@workflow/core/runtime";
import { resumeHook as resumeHookRuntime } from "@workflow/core/runtime/resume-hook";

import { WorkflowRunNotFoundError, WorkflowWorldError } from "@workflow/errors";
import type {
  Event,
  Hook,
  Step,
  WorkflowRun,
  WorkflowRunStatus,
  World,
} from "@workflow/world";
import type {
  HookListItem,
  PaginatedResult,
  ServerActionError,
  ServerActionResult,
} from "~/lib/types";
import { getInspectorHost } from "./inspector-host.server";

function createServerActionError<T>(
  error: unknown,
  operation: string,
  requestParams?: Record<string, any>,
): ServerActionResult<T> {
  const err = error instanceof Error ? error : new Error(String(error));
  let errorResponse: ServerActionError;

  if (WorkflowWorldError.is(error)) {
    // API-level errors (4xx/5xx from the world backend).
    // 4xx errors are client-recoverable and shouldn't spam logs.
    const status = error.status ?? 500;
    const isClientError = status >= 400 && status < 500;
    if (!isClientError) {
      console.error(`[web-api] ${operation} error:`, err);
    }
    errorResponse = {
      message: getUserFacingErrorMessage(err, error.status),
      layer: "API",
      cause: err.stack || err.message,
      request: {
        operation,
        params: requestParams ?? {},
        status: error.status,
        url: error.url,
        code: error.code ?? undefined,
      },
    };
  } else if (WorkflowRunNotFoundError.is(error)) {
    // Run not found — expected during polling for recently created runs.
    errorResponse = {
      message: getUserFacingErrorMessage(error, 404),
      layer: "API",
      cause: err.stack || err.message,
      request: { operation, status: 404, params: requestParams ?? {} },
    };
  } else {
    // Unrecognized errors (e.g., world backends throwing plain Error for 4xx).
    // The error is returned to the caller — no server-side logging needed.
    errorResponse = {
      message: getUserFacingErrorMessage(err),
      layer: "server",
      cause: err.stack || err.message,
      request: { status: 500, operation, params: requestParams ?? {} },
    };
  }

  return {
    success: false,
    error: errorResponse,
  };
}

/**
 * Converts an error into a user-facing message
 */
function getUserFacingErrorMessage(error: Error, status?: number): string {
  if (!status) {
    return `Error creating response: ${error.message}`;
  }

  // Check for common error patterns
  if (status === 403 || status === 401) {
    return "Access denied. Please check your credentials and permissions.";
  }

  if (status === 404) {
    return "The requested resource was not found.";
  }

  if (status === 500) {
    return "Error connecting to World backend, please try again later.";
  }

  if (error.message?.includes("Network") || error.message?.includes("fetch")) {
    return "Network error. Please check your connection and try again.";
  }

  // Return the original message for other errors
  return error.message || "An unexpected error occurred";
}

type SortOrder = "asc" | "desc";
type ResolveData = "none" | "all";

/**
 * One RPC method: reads the host's world and answers with the data, or with the
 * error as a `ServerActionError` naming the operation that failed.
 */
function method<P extends object, T>(
  operation: string,
  run: (world: World, params: P) => Promise<T>,
): (params: P) => Promise<ServerActionResult<T>> {
  return async (params) => {
    try {
      return {
        success: true,
        data: await run(getInspectorHost().world, params),
      };
    } catch (error) {
      return createServerActionError<T>(error, operation, params);
    }
  };
}

function page<T>(result: {
  data: T[];
  cursor: string | null;
  hasMore: boolean;
}): PaginatedResult<T> {
  return {
    data: result.data,
    cursor: result.cursor ?? undefined,
    hasMore: result.hasMore,
  };
}

function hookToListItem(hook: Hook): HookListItem {
  const { token: _token, ...hookListItem } = hook;
  return hookListItem;
}

/**
 * The calls the browser can make. Data is passed through as-is: CBOR transport
 * preserves Uint8Array and other types, and hydration happens client-side.
 */
export const rpcMethods = {
  fetchRuns: method(
    "world.runs.list",
    async (
      world,
      {
        cursor,
        sortOrder = "desc",
        limit = 10,
        workflowName,
        status,
      }: {
        cursor?: string;
        sortOrder?: SortOrder;
        limit?: number;
        workflowName?: string;
        status?: WorkflowRunStatus;
      },
    ) =>
      // Listed without input and output; the UI reads those per run.
      page(
        await world.runs.list({
          ...(workflowName ? { workflowName } : {}),
          ...(status ? { status } : {}),
          pagination: { cursor, limit, sortOrder },
          resolveData: "none",
        }),
      ) as unknown as PaginatedResult<WorkflowRun>,
  ),

  fetchRun: method(
    "world.runs.get",
    async (
      world,
      {
        runId,
        resolveData = "all",
      }: { runId: string; resolveData?: ResolveData },
    ) => (await world.runs.get(runId, { resolveData })) as WorkflowRun,
  ),

  fetchStep: method(
    "world.steps.get",
    async (
      world,
      {
        runId,
        stepId,
        resolveData = "all",
      }: { runId: string; stepId: string; resolveData?: ResolveData },
    ): Promise<Step> => world.steps.get(runId, stepId, { resolveData }),
  ),

  fetchEvents: method(
    "world.events.list",
    async (
      world,
      {
        runId,
        cursor,
        sortOrder = "asc",
        limit = 1000,
        withData = false,
      }: {
        runId: string;
        cursor?: string;
        sortOrder?: SortOrder;
        limit?: number;
        withData?: boolean;
      },
    ) =>
      page<Event>(
        await world.events.list({
          runId,
          pagination: { cursor, limit, sortOrder },
          resolveData: withData ? "all" : "none",
        }),
      ),
  ),

  fetchEvent: method(
    "world.events.get",
    async (
      world,
      {
        runId,
        eventId,
        resolveData = "all",
      }: { runId: string; eventId: string; resolveData?: ResolveData },
    ): Promise<Event> => world.events.get(runId, eventId, { resolveData }),
  ),

  /**
   * Events for one correlation id. `runId` is required: a correlation id is
   * unique within its run (a slot-numbered run numbers its own steps), not
   * across runs.
   */
  fetchEventsByCorrelationId: method(
    "world.events.listByCorrelationId",
    async (
      world,
      {
        correlationId,
        runId,
        cursor,
        sortOrder = "asc",
        limit = 100,
        withData = false,
      }: {
        correlationId: string;
        runId: string;
        cursor?: string;
        sortOrder?: SortOrder;
        limit?: number;
        withData?: boolean;
      },
    ) =>
      page<Event>(
        await world.events.listByCorrelationId({
          correlationId,
          runId,
          pagination: { cursor, limit, sortOrder },
          resolveData: withData ? "all" : "none",
        }),
      ),
  ),

  /** Hook rows without their secret `token`, which `fetchHookToken` reads one hook at a time. */
  fetchHooks: method(
    "world.hooks.list",
    async (
      world,
      {
        runId,
        cursor,
        sortOrder = "desc",
        limit = 10,
      }: {
        runId?: string;
        cursor?: string;
        sortOrder?: SortOrder;
        limit?: number;
      },
    ): Promise<PaginatedResult<HookListItem>> => {
      const result = await world.hooks.list({
        ...(runId ? { runId } : {}),
        pagination: { cursor, limit, sortOrder },
        resolveData: "none",
      });
      return { ...page(result), data: result.data.map(hookToListItem) };
    },
  ),

  /** One hook's secret token, read only when the user copies it or resumes the hook. */
  fetchHookToken: method(
    "world.hooks.get",
    async (world, { hookId }: { runId: string; hookId: string }) => {
      const hook = await world.hooks.get(hookId, { resolveData: "none" });
      return { token: hook.token };
    },
  ),

  fetchHook: method(
    "world.hooks.get",
    async (
      world,
      {
        hookId,
        resolveData = "all",
      }: { hookId: string; resolveData?: ResolveData },
    ): Promise<Hook> => world.hooks.get(hookId, { resolveData }),
  ),

  cancelRun: method(
    "world.events.create",
    async (world, { runId }: { runId: string }): Promise<void> => {
      await workflowRunHelpers.cancelRun(world, runId);
    },
  ),

  /**
   * Cancels runs in one operation: the world's batch endpoint when it has one,
   * else bounded-concurrency single cancels. Per-run outcomes are in the
   * summary, so a partial failure still resolves.
   */
  bulkCancelRuns: method(
    "world.runs.cancelMany",
    async (world, { runIds }: { runIds: string[] }) =>
      workflowRunHelpers.cancelRuns(world, runIds),
  ),

  /** Starts a new run with the same workflow and input as an existing one. */
  recreateRun: method(
    "recreateRun",
    async (
      world,
      { runId, deploymentId }: { runId: string; deploymentId?: string },
    ) =>
      workflowRunHelpers.recreateRunFromExisting(world, runId, {
        deploymentId,
      }),
  ),

  /**
   * Re-enqueues the workflow orchestration layer. A no-op unless the run got
   * stuck on a World bug; useful for debugging custom Worlds.
   */
  reenqueueRun: method(
    "reenqueueRun",
    async (world, { runId }: { runId: string }): Promise<void> => {
      await workflowRunHelpers.reenqueueRun(world, runId);
    },
  ),

  /**
   * Interrupts pending sleep() calls (all, or only `correlationIds`) and
   * re-enqueues the run.
   */
  wakeUpRun: method(
    "wakeUpRun",
    async (
      world,
      { runId, correlationIds }: { runId: string; correlationIds?: string[] },
    ) => workflowRunHelpers.wakeUpRun(world, runId, { correlationIds }),
  ),

  /**
   * Sends a payload to the hook with this token, which the workflow receives
   * from its `createHook()` call. Brick change: the SDK reads its own world
   * here, and an app that only records events may never have set it, so the
   * host's world is made the SDK's first.
   */
  resumeHook: method(
    "resumeHook",
    async (world, { token, payload }: { token: string; payload: unknown }) => {
      workflowRunHelpers.setWorld(world);
      const hook = await resumeHookRuntime(token, payload);
      return { hookId: hook.hookId, runId: hook.runId };
    },
  ),

  fetchStreams: method(
    "world.streams.list",
    async (world, { runId }: { runId: string }) => world.streams.list(runId),
  ),

  /**
   * The run's encryption key, for decrypting in the browser, or null when the
   * World does not encrypt. The World derives it from the full run.
   */
  getEncryptionKeyForRun: method(
    "getEncryptionKeyForRun",
    async (world, { runId }: { runId: string }): Promise<Uint8Array | null> => {
      if (!world.getEncryptionKeyForRun) return null;
      const run = await world.runs.get(runId);
      return (await world.getEncryptionKeyForRun(run)) ?? null;
    },
  ),
};

export type RpcMethods = typeof rpcMethods;

const CHUNKS_PAGE_SIZE = 500;

export interface StreamChunksResult {
  buffer: Uint8Array;
  /** Cursor the client should send back on the next poll to resume, or null */
  cursor: string | null;
  /** Whether the stream is fully closed (no more chunks will ever be written) */
  done: boolean;
}

/**
 * Fetch stream chunks using paginated batch API.
 *
 * When `startCursor` is provided, only chunks after that position are
 * returned — used for incremental polling so previously-seen data is
 * never re-transferred. Returns a `cursor` the client passes back on
 * the next request.
 */
export async function readStreamChunksServerAction(
  streamId: string,
  runId: string,
  startCursor?: string,
): Promise<StreamChunksResult | ServerActionError> {
  try {
    const { world } = getInspectorHost();
    const allChunks: Uint8Array[] = [];
    let pageCursor: string | undefined = startCursor;
    let streamDone = false;
    // Track the last non-null cursor so we can resume from the start of
    // the final page on the next poll. When getChunks returns
    // cursor=null we've exhausted all pages, but this saved cursor lets
    // the client re-fetch only the last page + any new chunks.
    let resumeCursor: string | null = startCursor ?? null;

    do {
      const result = await world.streams.getChunks(runId, streamId, {
        limit: CHUNKS_PAGE_SIZE,
        cursor: pageCursor,
      });

      for (const chunk of result.data) {
        allChunks.push(chunk.data);
      }

      streamDone = result.done;
      if (result.cursor) {
        resumeCursor = result.cursor;
      }
      pageCursor = result.cursor ?? undefined;
    } while (pageCursor);

    let totalSize = 0;
    for (const chunk of allChunks) {
      totalSize += chunk.length;
    }

    const body = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of allChunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }

    return { buffer: body, cursor: resumeCursor, done: streamDone };
  } catch (error) {
    const actionError = createServerActionError(
      error,
      "world.streams.getChunks",
      { streamId, runId },
    );
    if (!actionError.success) {
      return actionError.error;
    }
    throw new Error();
  }
}
