import "react-router";
// The React Router server build (virtual module).
import * as serverBuild from "virtual:react-router/server-build";
import {
  createRequestHandler,
  RouterContextProvider,
  type ServerBuild,
} from "react-router";
import {
  callerContext,
  worldContext,
} from "../app/server/inspector-host.server";
import { BASE_PATH } from "../base-path";
import type { CreateFetchHandler } from "./handler";

/**
 * Build a Web `Request` -> `Response` handler for the observability UI, the SSR
 * build's only export. Static files are not served here: the host serves the
 * client build's `assets/` itself.
 *
 * @param basename - Where the host mounts it. The build writes its URLs under
 *   `BASE_PATH`, so it must be that path.
 * @param host - What the host gives the inspector: the world to read.
 */
export const createFetchHandler: CreateFetchHandler = (basename, host) => {
  if (basename.replace(/\/$/, "") !== BASE_PATH)
    throw new Error(
      `The workflow inspector is built to be served at ${BASE_PATH}, not ${basename}.`,
    );
  const handler = createRequestHandler(
    serverBuild as unknown as ServerBuild,
    "production",
  );
  return (request, caller) => {
    const context = new RouterContextProvider();
    context.set(worldContext, host.world);
    context.set(callerContext, caller);
    return handler(request, context);
  };
};
