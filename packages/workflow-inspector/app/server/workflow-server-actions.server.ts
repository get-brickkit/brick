/**
 * Server-only module for workflow data access.
 *
 * The `.server.ts` suffix ensures Vite excludes this from client bundles.
 * These functions are called from React Router route loaders/actions.
 */

import * as workflowRunHelpers from "@workflow/core/runtime";
import { resumeHook as resumeHookRuntime } from "@workflow/core/runtime/resume-hook";

import { WorkflowRunNotFoundError, WorkflowWorldError } from "@workflow/errors";
import type {
  BulkCancelWorkflowRunsResult,
  Event,
  Hook,
  Step,
  WorkflowRun,
  WorkflowRunStatus,
  World,
} from "@workflow/world";
import type { HookListItem, HookTokenResult } from "~/lib/types";
import { getInspectorHost } from "./inspector-host.server";

/**
 * Environment variable map for world configuration.
 *
 * NOTE: This type is still exported for potential future use cases where
 * dynamic world configuration at runtime may be needed. Currently, the
 * @workflow/web package uses server-side environment variables exclusively
 * and does not pass EnvMap from the client. The server actions still accept
 * this parameter for backwards compatibility and future extensibility.
 */
export type EnvMap = Record<string, string | undefined>;

export interface PaginatedResult<T> {
  data: T[];
  cursor?: string;
  hasMore: boolean;
}

/**
 * Structured error information that can be sent to the client
 */
export interface ServerActionError {
  message: string;
  // "Server" if the error originates in this file, "API" if the error originates in the World interface
  layer: "server" | "API";
  cause?: string;
  request?: {
    operation: string;
    params: Record<string, any>;
    status?: number;
    url?: string;
    code?: string;
  };
}

/**
 * Result wrapper for server actions that can return either data or error
 */
export type ServerActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: ServerActionError };

/**
 * The world the host process runs on. Brick change: upstream builds one from the
 * environment; the host passes its own to `createFetchHandler`. Like
 * upstream it also makes it the SDK's world, which `resumeHook` reads: an app
 * that only records events may never have set it, and the SDK would then build
 * one from the environment.
 */
async function getWorldFromEnv(_userEnvMap?: EnvMap): Promise<World> {
  const { world } = getInspectorHost();
  workflowRunHelpers.setWorld(world);
  return world;
}

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

/**
 * Helper to create successful responses.
 * Data is passed through as-is — CBOR transport preserves Uint8Array
 * and other types. Hydration happens client-side.
 */
function createResponse<T>(data: T): ServerActionResult<T> {
  return {
    success: true,
    data,
  };
}

/**
 * Fetch paginated list of workflow runs
 */
export async function fetchRuns(
  worldEnv: EnvMap,
  params: {
    cursor?: string;
    sortOrder?: "asc" | "desc";
    limit?: number;
    workflowName?: string;
    status?: WorkflowRunStatus;
  },
): Promise<ServerActionResult<PaginatedResult<WorkflowRun>>> {
  const {
    cursor,
    sortOrder = "desc",
    limit = 10,
    workflowName,
    status,
  } = params;
  try {
    const world = await getWorldFromEnv(worldEnv);
    const result = await world.runs.list({
      ...(workflowName ? { workflowName } : {}),
      ...(status ? { status } : {}),
      pagination: { cursor, limit, sortOrder },
      resolveData: "none",
    });
    return createResponse({
      data: result.data as unknown as WorkflowRun[],
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    });
  } catch (error) {
    return createServerActionError<PaginatedResult<WorkflowRun>>(
      error,
      "world.runs.list",
      params,
    );
  }
}

/**
 * Fetch a single workflow run with full data
 */
export async function fetchRun(
  worldEnv: EnvMap,
  runId: string,
  resolveData: "none" | "all" = "all",
): Promise<ServerActionResult<WorkflowRun>> {
  try {
    const world = await getWorldFromEnv(worldEnv);
    const run = await world.runs.get(runId, { resolveData });
    return createResponse(run as WorkflowRun);
  } catch (error) {
    return createServerActionError<WorkflowRun>(error, "world.runs.get", {
      runId,
      resolveData,
    });
  }
}

/**
 * Fetch a single step with full data
 */
export async function fetchStep(
  worldEnv: EnvMap,
  runId: string,
  stepId: string,
  resolveData: "none" | "all" = "all",
): Promise<ServerActionResult<Step>> {
  try {
    const world = await getWorldFromEnv(worldEnv);
    const step = await world.steps.get(runId, stepId, { resolveData });
    return createResponse(step as Step);
  } catch (error) {
    return createServerActionError<Step>(error, "world.steps.get", {
      runId,
      stepId,
      resolveData,
    });
  }
}

/**
 * Fetch paginated list of events for a run
 */
export async function fetchEvents(
  worldEnv: EnvMap,
  runId: string,
  params: {
    cursor?: string;
    sortOrder?: "asc" | "desc";
    limit?: number;
    withData?: boolean;
  },
): Promise<ServerActionResult<PaginatedResult<Event>>> {
  const { cursor, sortOrder = "asc", limit = 1000, withData = false } = params;
  try {
    const world = await getWorldFromEnv(worldEnv);
    const result = await world.events.list({
      runId,
      pagination: { cursor, limit, sortOrder },
      resolveData: withData ? "all" : "none",
    });
    return createResponse({
      data: result.data as unknown as Event[],
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    });
  } catch (error) {
    return createServerActionError<PaginatedResult<Event>>(
      error,
      "world.events.list",
      {
        runId,
        ...params,
      },
    );
  }
}

/**
 * Fetch a single event by run ID and event ID
 */
export async function fetchEvent(
  worldEnv: EnvMap,
  runId: string,
  eventId: string,
  resolveData: "none" | "all" = "all",
): Promise<ServerActionResult<Event>> {
  try {
    const world = await getWorldFromEnv(worldEnv);
    const event = await world.events.get(runId, eventId, { resolveData });
    return createResponse(event as Event);
  } catch (error) {
    return createServerActionError<Event>(error, "world.events.get", {
      runId,
      eventId,
      resolveData,
    });
  }
}

/**
 * Fetch paginated events for a step correlation ID.
 */
export async function fetchEventsByCorrelationId(
  worldEnv: EnvMap,
  correlationId: string,
  params: {
    cursor?: string;
    sortOrder?: "asc" | "desc";
    limit?: number;
    withData?: boolean;
    /**
     * The run the correlation id belongs to. A correlation id is unique per
     * run, not globally — a slot-numbered run numbers its own steps — so the
     * search is always made from a run's page and names it.
     */
    runId: string;
  },
): Promise<ServerActionResult<PaginatedResult<Event>>> {
  const {
    cursor,
    sortOrder = "asc",
    limit = 100,
    withData = false,
    runId,
  } = params;
  try {
    const world = await getWorldFromEnv(worldEnv);
    // `runId` is required: a correlation id is unique within its run, not
    // across runs.
    const result = await world.events.listByCorrelationId({
      correlationId,
      runId,
      pagination: { cursor, limit, sortOrder },
      resolveData: withData ? "all" : "none",
    });
    return createResponse({
      data: result.data as unknown as Event[],
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    });
  } catch (error) {
    return createServerActionError<PaginatedResult<Event>>(
      error,
      "world.events.listByCorrelationId",
      {
        correlationId,
        ...params,
      },
    );
  }
}

/**
 * Fetch paginated list of hooks
 */
function hookToListItem(hook: Hook): HookListItem {
  const { token: _token, ...hookListItem } = hook;
  return hookListItem;
}

export async function fetchHooks(
  worldEnv: EnvMap,
  params: {
    runId?: string;
    cursor?: string;
    sortOrder?: "asc" | "desc";
    limit?: number;
  },
): Promise<ServerActionResult<PaginatedResult<HookListItem>>> {
  const { runId, cursor, sortOrder = "desc", limit = 10 } = params;
  try {
    const world = await getWorldFromEnv(worldEnv);
    // The hook list is metadata only: the secret `token` is fetched on demand
    // per hook via `fetchHookToken`, so the list never carries it.
    const result = await world.hooks.list({
      ...(runId ? { runId } : {}),
      pagination: { cursor, limit, sortOrder },
      resolveData: "none",
    });
    return createResponse({
      data: result.data.map(hookToListItem),
      cursor: result.cursor ?? undefined,
      hasMore: result.hasMore,
    });
  } catch (error) {
    return createServerActionError<PaginatedResult<HookListItem>>(
      error,
      "world.hooks.list",
      params,
    );
  }
}

/**
 * Fetch a single hook's secret token on demand.
 *
 * Hook list rows are metadata-only; the token is read from the runtime storage
 * API one hook at a time, only when the user reveals/copies it or resumes the
 * hook. This keeps the secret out of bulk list responses.
 */
export async function fetchHookToken(
  worldEnv: EnvMap,
  runId: string,
  hookId: string,
): Promise<ServerActionResult<HookTokenResult>> {
  try {
    const world = await getWorldFromEnv(worldEnv);
    const hook = await world.hooks.get(hookId, { resolveData: "none" });
    return createResponse({ token: hook.token });
  } catch (error) {
    return createServerActionError<HookTokenResult>(error, "world.hooks.get", {
      runId,
      hookId,
    });
  }
}

/**
 * Fetch a single hook with full data
 */
export async function fetchHook(
  worldEnv: EnvMap,
  hookId: string,
  resolveData: "none" | "all" = "all",
): Promise<ServerActionResult<Hook>> {
  try {
    const world = await getWorldFromEnv(worldEnv);
    const hook = await world.hooks.get(hookId, { resolveData });
    return createResponse(hook as Hook);
  } catch (error) {
    return createServerActionError<Hook>(error, "world.hooks.get", {
      hookId,
      resolveData,
    });
  }
}

/**
 * Cancel a workflow run
 */
export async function cancelRun(
  worldEnv: EnvMap,
  runId: string,
): Promise<ServerActionResult<void>> {
  try {
    const world = await getWorldFromEnv(worldEnv);
    await workflowRunHelpers.cancelRun(world, runId);
    return createResponse(undefined);
  } catch (error) {
    return createServerActionError<void>(error, "world.events.create", {
      runId,
    });
  }
}

/**
 * Bulk-cancel workflow runs in a single operation.
 *
 * Delegates to `cancelRuns`, which uses the world's native batch endpoint when
 * available and otherwise falls back to bounded-concurrency single-run
 * cancellation. Per-run outcomes are reported in the returned summary rather
 * than thrown, so a partial failure still resolves.
 */
export async function bulkCancelRuns(
  worldEnv: EnvMap,
  runIds: string[],
): Promise<ServerActionResult<BulkCancelWorkflowRunsResult>> {
  try {
    const world = await getWorldFromEnv(worldEnv);
    const result = await workflowRunHelpers.cancelRuns(world, runIds);
    return createResponse(result);
  } catch (error) {
    return createServerActionError<BulkCancelWorkflowRunsResult>(
      error,
      "world.runs.cancelMany",
      { runIdCount: runIds.length },
    );
  }
}

/**
 * Start a new workflow run.
 *
 * This requires the ID of an existing run of which to re-use the deployment ID of.
 */
export async function recreateRun(
  worldEnv: EnvMap,
  runId: string,
  deploymentId?: string,
): Promise<ServerActionResult<string>> {
  try {
    const world = await getWorldFromEnv({ ...worldEnv });
    const newRunId = await workflowRunHelpers.recreateRunFromExisting(
      world,
      runId,
      {
        deploymentId,
      },
    );
    return createResponse(newRunId);
  } catch (error) {
    return createServerActionError<string>(error, "recreateRun", { runId });
  }
}

/**
 * Re-enqueue a workflow run.
 *
 * This re-enqueues the workflow orchestration layer. It's a no-op unless the workflow
 * got stuck due to an implementation issue in the World. Useful for debugging custom Worlds.
 */
export async function reenqueueRun(
  worldEnv: EnvMap,
  runId: string,
): Promise<ServerActionResult<void>> {
  try {
    const world = await getWorldFromEnv({ ...worldEnv });
    await workflowRunHelpers.reenqueueRun(world, runId);
    return createResponse(undefined);
  } catch (error) {
    return createServerActionError<void>(error, "reenqueueRun", { runId });
  }
}

export interface StopSleepResult {
  /** Number of pending sleeps that were stopped */
  stoppedCount: number;
}

export interface StopSleepOptions {
  /**
   * Optional list of specific correlation IDs to target.
   * If provided, only these sleep calls will be interrupted.
   * If not provided, all pending sleep calls will be interrupted.
   */
  correlationIds?: string[];
}

/**
 * Wake up a workflow run by interrupting pending sleep() calls.
 *
 * This finds wait_created events without matching wait_completed events,
 * creates wait_completed events for them, and then re-enqueues the run.
 *
 * @param worldEnv - Environment configuration for the World
 * @param runId - The run ID to wake up
 * @param options - Optional settings to narrow down targeting (specific correlation IDs)
 */
export async function wakeUpRun(
  worldEnv: EnvMap,
  runId: string,
  options?: StopSleepOptions,
): Promise<ServerActionResult<StopSleepResult>> {
  try {
    const world = await getWorldFromEnv({ ...worldEnv });
    const result = await workflowRunHelpers.wakeUpRun(world, runId, options);
    return createResponse(result);
  } catch (error) {
    return createServerActionError<StopSleepResult>(error, "wakeUpRun", {
      runId,
      correlationIds: options?.correlationIds,
    });
  }
}

export interface ResumeHookResult {
  /** The hook ID that was resumed */
  hookId: string;
  /** The run ID associated with the hook */
  runId: string;
}

/**
 * Resume a hook by sending a payload.
 *
 * This sends a payload to a hook identified by its token, which resumes
 * the associated workflow run. The payload will be available as the return
 * value of the `createHook()` call in the workflow.
 *
 * @param worldEnv - Environment configuration for the World
 * @param token - The hook token
 * @param payload - The JSON payload to send to the hook
 */
export async function resumeHook(
  worldEnv: EnvMap,
  token: string,
  payload: unknown,
): Promise<ServerActionResult<ResumeHookResult>> {
  try {
    // Initialize the world so resumeHookRuntime can access it
    await getWorldFromEnv({ ...worldEnv });

    const hook = await resumeHookRuntime(token, payload);

    return createResponse({
      hookId: hook.hookId,
      runId: hook.runId,
    });
  } catch (error) {
    return createServerActionError<ResumeHookResult>(error, "resumeHook", {
      token,
    });
  }
}

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
  env: EnvMap,
  streamId: string,
  runId: string,
  startCursor?: string,
): Promise<StreamChunksResult | ServerActionError> {
  try {
    const world = await getWorldFromEnv(env);
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

/**
 * List all stream IDs for a run
 */
export async function fetchStreams(
  env: EnvMap,
  runId: string,
): Promise<ServerActionResult<string[]>> {
  try {
    const world = await getWorldFromEnv(env);
    const streams = await world.streams.list(runId);
    return createResponse(streams);
  } catch (error) {
    return createServerActionError<string[]>(error, "world.streams.list", {
      runId,
    });
  }
}

// ---------------------------------------------------------------------------
// Encryption key retrieval for client-side decryption
// ---------------------------------------------------------------------------

/**
 * Retrieve the encryption key for a specific run.
 *
 * The World resolves the per-run AES-256 key (including HKDF derivation
 * and cross-deployment key retrieval). The raw key bytes are returned
 * to the browser for client-side decryption via core's AES-GCM.
 */
export async function getEncryptionKeyForRun(
  worldEnv: EnvMap,
  runId: string,
): Promise<ServerActionResult<Uint8Array | null>> {
  try {
    const world = await getWorldFromEnv(worldEnv);
    if (!world.getEncryptionKeyForRun) {
      return createResponse(null);
    }
    // Fetch the full run so the World can inspect deploymentId etc.
    const run = await world.runs.get(runId);
    const key = await world.getEncryptionKeyForRun(run);
    return createResponse(key ?? null);
  } catch (error) {
    return createServerActionError<Uint8Array | null>(
      error,
      "getEncryptionKeyForRun",
      { runId },
    );
  }
}
