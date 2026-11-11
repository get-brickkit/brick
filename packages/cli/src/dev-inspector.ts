import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrickApp, ScheduleControl } from "@brickkit/core";
import type { CreateFetchHandler } from "../../workflow-inspector/server/handler";
import { INSPECTOR_TOKEN_HEADER, ROUTES } from "./dashboard-protocol";

const INSPECTOR_PATH = ROUTES.workflows.path;

export interface Inspector {
  readonly port: number;
  /** Whether it serves the workflow inspector; it may serve only the schedules. */
  readonly workflows: boolean;
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
 * The app's schedules, for the dashboard's Schedules view: `GET` lists them,
 * `POST <path>/<name>` runs one now.
 */
async function schedulesRoute(
  schedules: ScheduleControl,
  request: Request,
  pathname: string,
): Promise<Response> {
  const name = decodeURIComponent(
    pathname.slice(ROUTES.schedules.path.length + 1),
  );
  if (request.method === "GET" && !name)
    return Response.json(await schedules.list());
  if (request.method !== "POST" || !name)
    return new Response("Not found", { status: 404 });
  try {
    return Response.json({ started: await schedules.trigger(name) });
  } catch (error) {
    return new Response((error as Error).message, { status: 404 });
  }
}

/**
 * Serve the Workflow inspector (the Workflow SDK's observability UI, built into
 * this package) for the app's world, and the app's schedules, on a loopback
 * port of its own. The dashboard proxies them at `/workflows` and
 * `/api/schedules`; it is the only caller that knows the token. The UI can
 * cancel runs and resume hooks, and a schedule can be run from it, so nothing
 * else may reach it, and it exists only under `brick dev`.
 *
 * @param app - The loaded app, running in this process.
 * @param directory - The inspector's build; this package's own by default.
 * @returns The inspector, or `undefined` when the app runs no workflows and has no schedules.
 * @throws When the inspector's build is missing.
 */
export async function startInspector(
  app: BrickApp,
  directory = INSPECTOR_DIRECTORY,
): Promise<Inspector | undefined> {
  const target = app.events?.workflows;
  const schedules = app.events?.schedules;
  if (!target && !schedules) return undefined;
  const workflows = target && (await workflowsPage(target, directory));
  const token = randomBytes(16).toString("hex");
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    // The UI streams a run's output and holds the connection open.
    idleTimeout: 0,
    fetch: (request) => {
      if (request.headers.get(INSPECTOR_TOKEN_HEADER) !== token)
        return new Response("Forbidden", { status: 403 });
      const { pathname } = new URL(request.url);
      if (schedules && pathname.startsWith(ROUTES.schedules.path))
        return schedulesRoute(schedules, request, pathname);
      if (!workflows) return new Response("Not found", { status: 404 });
      return browserAsset(request, workflows.client) ?? workflows.page(request);
    },
  });
  return {
    port: server.port!,
    workflows: Boolean(workflows),
    token,
    stop: () => void server.stop(true),
  };
}

async function workflowsPage(
  target: NonNullable<NonNullable<BrickApp["events"]>["workflows"]>,
  directory: string,
) {
  const entry = join(directory, "server", "index.js");
  if (!existsSync(entry))
    throw new Error(
      "The workflow inspector is not built. Build it with: bun run --filter @brickkit/cli build",
    );
  const { createFetchHandler } = (await import(pathToFileURL(entry).href)) as {
    createFetchHandler: CreateFetchHandler;
  };
  const page = createFetchHandler(INSPECTOR_PATH, {
    // Core types only the parts of the world it calls; the world is a whole Workflow SDK World.
    world: target.world as Parameters<CreateFetchHandler>[1]["world"],
  });
  return { page, client: join(directory, "client") };
}
