/**
 * Types shared by the server's RPC methods and the browser.
 * This file should NOT import any server-only modules.
 */

import type { Hook } from "@workflow/world";

/**
 * Structured error information that can be sent to the client
 */
export interface ServerActionError {
  message: string;
  // "server" if the error originates in the inspector, "API" if it originates in the World
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

/**
 * A hook as shown in list views. The secret `token` is omitted: list rows are
 * metadata-only, and the token is fetched on demand per hook (see
 * `fetchHookToken`) for the copy-token and resume affordances.
 */
export type HookListItem = Omit<Hook, "token">;
