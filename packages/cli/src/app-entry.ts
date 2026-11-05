import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireBrickApp, type BrickApp } from "@brickkit/core";
import { ConfigError } from "./config";
import { registerWorkflowTransform } from "./workflows";

/**
 * Import an app entry and return its default export. `run`: the app will run
 * in this process, so workflow files are transformed as they load.
 *
 * @throws When the file does not exist.
 */
export async function importEntry(
  entry: string,
  options: { run?: boolean } = {},
): Promise<unknown> {
  const file = resolve(entry);
  if (!existsSync(file))
    throw new ConfigError(`[Brick-TS] Error: Entry file not found: ${file}`);
  if (options.run) await registerWorkflowTransform();
  return (await import(pathToFileURL(file).href)).default;
}

/**
 * Import an app entry to inspect it: to build it, or to read its routes. The app
 * is not run, so what creating it opened is released here: a workflow world
 * holds Redis connections that would keep the command from exiting.
 */
export async function loadBrickApp(entry: string): Promise<BrickApp> {
  const app = requireBrickApp(await importEntry(entry));
  await app.events?.stop();
  return app;
}
