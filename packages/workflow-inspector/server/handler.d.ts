import type { World } from "@workflow/world";

/**
 * What the host process hands the inspector: the world to read. Brick change:
 * upstream resolves the world from `WORKFLOW_TARGET_WORLD` and friends; here
 * the host passes its own, as each request's load context.
 */
export interface InspectorHost {
  world: World;
}

/**
 * Brick change: who a request is from, when the host lets some callers look
 * without changing anything. A read-only caller's RPC calls that cancel,
 * replay, re-enqueue or wake a run, resume a hook, or read a hook's token, are
 * refused with 403 and `refusal` as the message. It reads all else the UI
 * shows, with every hook's token left out.
 */
export interface InspectorCaller {
  readOnly: boolean;
  refusal: string;
}

/**
 * The server build's one export, as its hosts call it. A declaration file, so
 * the CLI checks its call against it without type-checking the app.
 */
export type CreateFetchHandler = (
  basename: string,
  host: InspectorHost,
) => (request: Request, caller?: InspectorCaller) => Promise<Response>;
