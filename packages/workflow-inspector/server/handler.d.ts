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
 * The server build's one export, as its hosts call it. A declaration file, so
 * the CLI checks its call against it without type-checking the app.
 */
export type CreateFetchHandler = (
  basename: string,
  host: InspectorHost,
) => (request: Request) => Promise<Response>;
