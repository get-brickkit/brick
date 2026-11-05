import { brick, isBrickApp } from "@brickkit/core";
import { importEntry } from "./app-entry";
import { writeAppContract } from "./client-contract-file";
import type { WorkerOptions } from "./dev-protocol";
import { sendToSupervisor } from "./dev-telemetry";
import { printBanner, serveApp } from "./serve";
import { buildAppWorkflows } from "./workflows";

/**
 * Start the app `brick dev` runs: the entry's default-exported app, else one
 * with the registered services. Its own dashboard option is ignored: `brick
 * dev` serves the dev dashboard.
 */
export async function startDevApplication(
  options: Omit<WorkerOptions, "entry" | "telemetry"> & { entry?: string },
) {
  const exported = options.entry
    ? await importEntry(options.entry, { run: true })
    : undefined;
  if (isBrickApp(exported) && options.prefix !== undefined) {
    console.warn(
      `[Brick-TS] Ignoring prefix ${options.prefix}: exported BrickApp prefix ${exported.definition.prefix} takes precedence.`,
    );
  }
  if (options.clientOutput) {
    if (!isBrickApp(exported) || !options.entry)
      throw new Error(
        "Brick: client generation requires a default-exported BrickApp.",
      );
    await writeAppContract(exported, options.entry, options.clientOutput);
    void sendToSupervisor({ type: "brick:contract-ready" });
  }
  const app = isBrickApp(exported)
    ? exported
    : brick({ prefix: options.prefix });
  await buildAppWorkflows(app, { reuse: true });
  await serveApp(app, { port: options.port, dashboard: false });
  printBanner(app, { label: "Development", port: options.port });
  return app;
}
