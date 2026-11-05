/**
 * Shared types that are used by both server and client code.
 * This file should NOT import any server-only modules.
 */

import type { Hook } from "@workflow/world";

/**
 * Environment variable map for world configuration.
 */
export type EnvMap = Record<string, string | undefined>;

/**
 * Structured error information that can be sent to the client
 */
export interface ServerActionError {
  message: string;
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

export interface PaginatedResult<T> {
  data: T[];
  cursor?: string;
  hasMore: boolean;
}

export interface StopSleepResult {
  /** Number of pending sleeps that were stopped */
  stoppedCount: number;
}

export interface StopSleepOptions {
  correlationIds?: string[];
}

export interface ResumeHookResult {
  hookId: string;
  runId: string;
}

/**
 * A hook as shown in list views. The secret `token` is omitted: list rows are
 * metadata-only, and the token is fetched on demand per hook (see
 * `fetchHookToken`) for the copy-token and resume affordances.
 */
export type HookListItem = Omit<Hook, "token">;

/** Result of a lazy per-hook token fetch. */
export interface HookTokenResult {
  token: string;
}
