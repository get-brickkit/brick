import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { compileBrickApplication } from "@brickkit/core";
import type { BunPlugin } from "bun";
import { emitCompiledApplication } from "./compiler";
import { brickAot } from "./compiler/aot";
import { loadBrickApp } from "./app-entry";
import { ownModule } from "./own-module";
import { DEFAULT_OUTDIR, resolvePort } from "./config";
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

/**
 * The production dashboard stays out of the bundle: it serves files that ship
 * with @brickkit/cli, so a built server whose app asks for it imports it from
 * there at run time. Without a dashboard the bundle needs nothing installed.
 */
const productionDashboardAtRunTime: BunPlugin = {
  name: "brick:production-dashboard",
  setup(build) {
    build.onResolve({ filter: /^\.\/production-dashboard(\.[jt]s)?$/ }, () => ({
      path: "@brickkit/cli/production-dashboard",
      external: true,
    }));
  },
};

/** The files `brick build` writes to the output folder, `server.js` last. */
const OUTPUTS = ["routes.js", "brick-ir.json", "server.js.map", "server.js"];

/** Bundle an exported BrickApp with its compiled IR and its original configuration. */
export async function buildApplication(options: BuildApplicationOptions) {
  const entry = resolve(options.entry);
  if (!(await Bun.file(entry).exists()))
    throw new Error(`Brick compiler: entry not found: ${entry}`);
  const outdir = resolve(options.outdir ?? DEFAULT_OUTDIR);
  if (OUTPUTS.some((name) => entry === join(outdir, name)))
    throw new Error(
      "Brick compiler: output would overwrite the application entry",
    );
  const port = resolvePort(options.port, undefined, "");
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
    const dashboard = (await writeDashboardExtension(
      extension,
      app.definition.plugins ?? [],
      join(staging, "dashboard"),
    ))
      ? join(outdir, "dashboard")
      : undefined;
    const theme = JSON.stringify(options.dashboard?.theme);
    const source = `import { fileURLToPath } from "node:url";
import { loadCompiledBrickApp } from "@brickkit/core";
import { resolvePort } from ${JSON.stringify(ownModule("config"))};
import { serveApp, shutdownOnSignal } from ${JSON.stringify(ownModule("serve"))};
import { ir } from "./routes.js";
export const app = await loadCompiledBrickApp(() => import(${JSON.stringify(entry)}), ir);
if (import.meta.main) {
  await serveApp(app, {
    port: resolvePort(undefined, ${port}),
    dashboard: { extension: ${dashboard ? 'fileURLToPath(new URL("./dashboard", import.meta.url))' : "undefined"}, theme: ${theme} },
  });
  console.log("Brick compiled server listening on http://localhost:" + app.server.port);
  shutdownOnSignal(app);
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
        productionDashboardAtRunTime,
      ],
    });
    if (!result.success)
      throw new AggregateError(result.logs, "Brick compiler: bundling failed");
    await Bun.write(
      join(staging, "brick-ir.json"),
      JSON.stringify(compilation.ir, null, 2) + "\n",
    );
    await mkdir(outdir, { recursive: true });
    for (const name of OUTPUTS)
      await rename(join(staging, name), join(outdir, name));
    if (dashboard) {
      await rm(dashboard, { recursive: true, force: true });
      await rename(join(staging, "dashboard"), dashboard);
    }
    return {
      outdir,
      entry: join(outdir, "server.js"),
      ir: compilation.ir,
      dashboard,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
