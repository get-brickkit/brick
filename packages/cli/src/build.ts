import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { compileBrickApplication } from "@brickkit/core";
import { emitCompiledApplication } from "./compiler";
import { brickAot } from "./compiler/aot";
import { loadBrickApp } from "./app-entry";
import { buildAppWorkflows, workflowTransformPlugin } from "./workflows";
import {
  themeCss,
  writeDashboardExtension,
  type DashboardExtensionOptions,
} from "./dashboard-extension";

export interface BuildApplicationOptions {
  /** A module whose default export is a BrickApp, without starting a server. */
  entry: string;
  outdir?: string;
  port?: number;
  /** Precompile Elysia's HTTP handlers at build time (default true). */
  aot?: boolean;
  /**
   * The dashboard's extension, built into `<outdir>/dashboard` with those of
   * the app's plugins for the production dashboard to serve; its theme is
   * checked here too.
   */
  dashboard?: DashboardExtensionOptions;
}

/** Bundle an exported BrickApp with generated handlers and its original configuration. */
export async function buildApplication(options: BuildApplicationOptions) {
  const entry = resolve(options.entry);
  if (!(await Bun.file(entry).exists()))
    throw new Error(`Brick compiler: entry not found: ${entry}`);
  const outdir = resolve(options.outdir ?? "dist/brick");
  if (
    entry === join(outdir, "server.js") ||
    entry === join(outdir, "routes.js")
  )
    throw new Error(
      "Brick compiler: output would overwrite the application entry",
    );
  const port = options.port ?? 4000;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      "Brick compiler: port must be an integer between 1 and 65535",
    );
  themeCss(options.dashboard?.theme);
  const extension = options.dashboard?.extension
    ? resolve(options.dashboard.extension)
    : undefined;
  if (extension && !(await Bun.file(extension).exists()))
    throw new Error(
      `Brick compiler: dashboard extension not found: ${extension}`,
    );
  const app = await loadBrickApp(entry);
  // The bundle stays in the project, where the server finds it from the working
  // directory, as `brick start` does.
  await buildAppWorkflows(app);
  const services = [...app.definition.services];
  const compilation = compileBrickApplication({
    services,
    prefix: app.definition.prefix,
  });
  await mkdir(dirname(outdir), { recursive: true });
  const staging = await mkdtemp(join(dirname(outdir), ".brick-build-"));
  try {
    await Bun.write(
      join(staging, "routes.js"),
      emitCompiledApplication(compilation.ir),
    );
    const source = `import { loadCompiledBrickApp } from "@brickkit/core";
import { ir, bind } from "./routes.js";
export const app = await loadCompiledBrickApp(() => import(${JSON.stringify(entry)}), ir, bind);
if (import.meta.main) {
  const port = Number(process.env.PORT ?? ${port});
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT: must be between 1 and 65535");
  await app.start?.();
  app.listen(port);
  app.events?.start();
  console.log("Brick compiled server listening on http://localhost:" + app.server.port);
  let stopping = false;
  const stop = async (signal: string) => {
    // A second signal exits at once, for a delivery that never finishes.
    if (stopping) process.exit(signal === "SIGINT" ? 130 : 143);
    stopping = true;
    await app.events?.stop();
    await app.stop();
    process.exit(0);
  };
  // on, not once: the workflow runtime bundles signal-exit, which re-raises a signal when no listener is left.
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
`;
    await Bun.write(join(staging, "entry.ts"), source);
    const workflows = app.events?.workflows
      ? await workflowTransformPlugin(app.events.workflows.root)
      : undefined;
    const result = await Bun.build({
      entrypoints: [join(staging, "entry.ts")],
      target: "bun",
      format: "esm",
      outdir: staging,
      naming: "server.js",
      sourcemap: "external",
      // AOT first: the workflow plugin loads every project file it sees, so after
      // it the AOT plugin would never get to transform the entry.
      plugins: [
        ...(options.aot === false
          ? []
          : [
              brickAot(
                join(staging, "entry.ts"),
                app.definition.sockets.length > 0,
              ),
            ]),
        ...(workflows ? [workflows] : []),
      ],
    });
    if (!result.success)
      throw new AggregateError(result.logs, "Brick compiler: bundling failed");
    await Bun.write(
      join(staging, "brick-ir.json"),
      JSON.stringify(compilation.ir, null, 2) + "\n",
    );
    const dashboard = (await writeDashboardExtension(
      extension,
      app.definition.plugins ?? [],
      join(staging, "dashboard"),
    ))
      ? join(outdir, "dashboard")
      : undefined;
    await mkdir(outdir, { recursive: true });
    for (const name of [
      "routes.js",
      "brick-ir.json",
      "server.js.map",
      "server.js",
    ])
      await rename(join(staging, name), join(outdir, name));
    if (dashboard) {
      await rm(dashboard, { recursive: true, force: true });
      await rename(join(staging, "dashboard"), dashboard);
    }
    return {
      outdir,
      entry: join(outdir, "server.js"),
      ir: compilation.ir,
      /** The built dashboard extension's folder, when there is one. */
      dashboard,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
