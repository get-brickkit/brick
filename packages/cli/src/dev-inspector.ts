import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrickApp } from "@brickkit/core";
import { INSPECTOR_TOKEN_HEADER, ROUTES } from "./dashboard-protocol";

/** Where the dashboard serves the inspector. */
const INSPECTOR_PATH = ROUTES.workflows.path;

export interface Inspector {
  readonly port: number;
  /** Every request must carry it in `INSPECTOR_TOKEN_HEADER`. */
  readonly token: string;
  stop(): void;
}

/** The built inspector, next to `src/` in the repo and next to `dist/` when published. */
const INSPECTOR_DIRECTORY = fileURLToPath(
  new URL("../inspector-dist/", import.meta.url),
);

/** Whether a path is a regular file; any failure to find out (not a directory, name too long) says no. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A file of the inspector's browser build. Its names carry a hash of their
 * content, so a browser may keep them for good. Anything else under `assets/`
 * is a plain 404: the page would answer with HTML. `undefined` for requests
 * outside `assets/`, which are the page's to answer.
 */
function browserAsset(request: Request, client: string): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${INSPECTOR_PATH}/assets/`)) return undefined;
  const file = resolve(client, pathname.slice(INSPECTOR_PATH.length + 1));
  if (!file.startsWith(client + sep) || !isFile(file))
    return new Response("Not found", { status: 404 });
  return new Response(Bun.file(file), {
    headers: { "cache-control": "public, max-age=31536000, immutable" },
  });
}

/**
 * Serve the Workflow inspector (the Workflow SDK's observability UI, built into
 * this package) for the app's world, on a loopback port of its own. The
 * dashboard proxies it at `/workflows`; it is the only caller that knows the
 * token. The UI can cancel runs and resume hooks, so nothing else may reach it,
 * and it exists only under `brick dev`.
 *
 * @param app - The loaded app, running in this process.
 * @param directory - The inspector's build; this package's own by default.
 * @returns The inspector, or `undefined` when the app runs no workflows.
 * @throws When the inspector's build is missing.
 */
export async function startInspector(
  app: BrickApp,
  directory = INSPECTOR_DIRECTORY,
): Promise<Inspector | undefined> {
  const target = app.events?.workflows;
  if (!target) return undefined;
  const entry = join(directory, "server", "index.js");
  if (!existsSync(entry))
    throw new Error(
      "The workflow inspector is not built. Build it with: bun run --filter @brickkit/cli build",
    );
  const { createFetchHandler } = (await import(pathToFileURL(entry).href)) as {
    createFetchHandler(
      basename: string,
      host: { world: unknown },
    ): (request: Request) => Promise<Response>;
  };
  const page = createFetchHandler(INSPECTOR_PATH, { world: target.world });
  const client = join(directory, "client");
  const token = randomBytes(16).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // The UI streams a run's output and holds the connection open.
    idleTimeout: 0,
    fetch: (request) =>
      request.headers.get(INSPECTOR_TOKEN_HEADER) === token
        ? (browserAsset(request, client) ?? page(request))
        : new Response("Forbidden", { status: 403 }),
  });
  return { port: server.port!, token, stop: () => void server.stop(true) };
}
