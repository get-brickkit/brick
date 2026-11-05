import { join, resolve } from "node:path";
import { writeAppContract } from "./client-contract-file";
import { CONTRACT_FILE, PROJECT_DEFAULTS } from "./config";
import { ownModule } from "./own-module";
import {
  createServer,
  isRunnableDevEnvironment,
  normalizePath,
  type Plugin,
  type ResolvedConfig,
  type EnvironmentModuleNode,
} from "vite";
import { requireBrickApp } from "@brickkit/core";
import { startViteDashboard, type ViteDashboard } from "./dev-vite-dashboard";
import {
  themeCss,
  type DashboardExtensionOptions,
  type DashboardTheme,
} from "./dashboard-extension";
import { ModuleRunner } from "vite/module-runner";

export type { DashboardTheme };

export interface BrickClientPluginOptions {
  /** Any module whose default export is a BrickApp; do not call listen() there. */
  entry: string;
  /** Generated browser contract, relative to the Vite root (default _brick/contract.ts). */
  output?: string;
  /**
   * Local dashboard for the app's requests, traces, errors, and reloads, served
   * during `vite dev` (default: on at port 9400). Apps must pass
   * `telemetry: true` to brick() to record requests. `historyDays` is how long
   * finished requests are kept in `.brick/` (default 90, 0 for none). Set to
   * false to disable. `extension` (relative to the Vite root) and `theme`
   * customise it, as in `brick dev`.
   */
  dashboard?:
    | ({ port?: number; historyDays?: number } & DashboardExtensionOptions)
    | false;
}

/** Load a BrickApp through Vite's server module graph, including dependency HMR. */
export function brickClient(options: BrickClientPluginOptions): Plugin {
  const virtualId = "virtual:brick-app";
  const resolvedId = "\0" + virtualId;
  const reporterId = "virtual:brick-dev-reporter";
  const resolvedReporterId = "\0" + reporterId;
  // Imported by file path: the package name may not resolve from the app's root.
  const reporterModule = ownModule("dev-reporter");
  let entry: string;
  let output: string;
  let config: ResolvedConfig;
  let buildGeneration: Promise<void> | undefined;
  let runner: ModuleRunner | undefined;
  let dashboard: ViteDashboard | undefined;
  let reload = Promise.resolve();
  const dependencies = new Set<string>();
  let revision = 0;
  const changedFiles = new Set<string>();

  function collectDependencies(
    node: EnvironmentModuleNode | undefined,
    seen = new Set<EnvironmentModuleNode>(),
  ) {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (node.file) dependencies.add(node.file);
    for (const imported of node.importedModules)
      collectDependencies(imported, seen);
  }

  return {
    name: "brick:client",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
      entry = normalizePath(resolve(config.root, options.entry));
      output = normalizePath(
        resolve(
          config.root,
          options.output ?? join(PROJECT_DEFAULTS.generated, CONTRACT_FILE),
        ),
      );
      if (options.dashboard) themeCss(options.dashboard.theme);
    },
    async configureServer(server) {
      const environment = server.environments.ssr;
      if (!environment)
        throw new Error(
          "Brick: client generation requires a Vite SSR environment.",
        );
      // Frameworks such as Start own their SSR runner. Use an independent runner
      // on the same transform graph to read app metadata without changing theirs.
      runner = new ModuleRunner({
        hmr: false,
        transport: {
          invoke: (payload) => environment.hot.handleInvoke(payload),
        },
      });
      // The dashboard starts before the app is evaluated, so its tracer is
      // registered before the app's first request can be made.
      if (options.dashboard !== false) {
        const started = await startViteDashboard({
          port: options.dashboard?.port,
          historyDays: options.dashboard?.historyDays,
          dashboard: {
            extension: options.dashboard?.extension
              ? resolve(server.config.root, options.dashboard.extension)
              : undefined,
            theme: options.dashboard?.theme,
          },
          directory: server.config.root,
          entry,
          logger: server.config.logger,
        });
        dashboard = started;
        server.httpServer?.once("close", () => started?.stop());
        server.httpServer?.once("listening", () => {
          const address = server.httpServer?.address();
          if (address && typeof address === "object") {
            const scheme = server.config.server.https ? "https" : "http";
            started?.origin(`${scheme}://localhost:${address.port}`);
          }
        });
      }
      const app = (await runner.import(entry)).default;
      await writeAppContract(app, entry, output);
      dashboard?.architecture(requireBrickApp(app));
      dependencies.clear();
      collectDependencies(environment.moduleGraph.getModuleById(entry));
      dependencies.add(entry);
    },
    async hotUpdate(context) {
      if (
        this.environment.name !== "ssr" ||
        !dependencies.has(context.file) ||
        context.file === output
      )
        return;
      if (!runner) return;
      const currentRunner = runner;
      const currentRevision = ++revision;
      changedFiles.add(context.file);
      reload = reload
        .catch(() => {})
        .then(async () => {
          await new Promise((done) => setTimeout(done, 30));
          if (currentRevision !== revision) return;
          for (const module of context.modules)
            this.environment.moduleGraph.invalidateModule(module);
          const graph = currentRunner.evaluatedModules;
          const seen = new Set<string>();
          const invalidate = (id: string) => {
            if (seen.has(id)) return;
            seen.add(id);
            const node = graph.getModuleById(id);
            if (!node) return;
            for (const importer of node.importers) invalidate(importer);
            // Registration modules mutate imported services. Reevaluate their
            // dependencies too so removed actions cannot survive in a singleton.
            for (const imported of node.imports) invalidate(imported);
            graph.invalidateModule(node);
          };
          for (const file of changedFiles) {
            for (const node of graph.getModulesByFile(file) ?? [])
              invalidate(node.id);
          }
          changedFiles.clear();
          invalidate(entry);
          try {
            const app = (await currentRunner.import(entry)).default;
            await writeAppContract(app, entry, output);
            dashboard?.architecture(requireBrickApp(app));
          } finally {
            collectDependencies(
              this.environment.moduleGraph.getModuleById(entry),
            );
          }
          dependencies.clear();
          collectDependencies(
            this.environment.moduleGraph.getModuleById(entry),
          );
          dependencies.add(entry);
        });
      await reload;
    },
    async closeBundle() {
      await runner?.close();
      dashboard?.stop();
    },
    async buildStart() {
      if (config.command !== "build") return;
      buildGeneration ??= (async () => {
        // Evaluate the server entry through Vite's TS/alias resolver before client compilation.
        // This loader has no app plugins, so it cannot recursively trigger generation.
        const loader = await createServer({
          configFile: false,
          root: config.root,
          mode: config.mode,
          envDir: config.envDir,
          base: config.base,
          define: config.define,
          logLevel: "silent",
          resolve: { alias: config.resolve.alias },
          ssr: config.ssr,
          server: { middlewareMode: true, watch: null },
        });
        try {
          const environment = loader.environments.ssr;
          if (!environment || !isRunnableDevEnvironment(environment))
            throw new Error("Brick: missing build-time SSR loader.");
          await writeAppContract(
            (await environment.runner.import(entry)).default,
            entry,
            output,
          );
        } finally {
          await loader.close();
        }
      })();
      await buildGeneration;
    },
    resolveId(id) {
      if (id !== virtualId && id !== reporterId) return;
      if (this.environment.config.consumer === "client") {
        throw new Error(
          "Brick: virtual:brick-app is server-only; never import the backend app in the browser.",
        );
      }
      return id === virtualId ? resolvedId : resolvedReporterId;
    },
    load(id) {
      if (id === resolvedReporterId) {
        // The app imports the reporter only while the dashboard is running.
        if (!dashboard) return "";
        return `import { installDevReporter } from ${JSON.stringify(reporterModule)};
installDevReporter({ url: ${JSON.stringify(dashboard.ingestUrl)} });
`;
      }
      if (id !== resolvedId) return;
      // The reporter is imported first so tracing is installed before the app is built.
      const reporter = dashboard
        ? `import ${JSON.stringify(reporterId)};\n`
        : "";
      return `${reporter}import { requireBrickApp } from "@brickkit/core";
import app from ${JSON.stringify(entry)};
export default requireBrickApp(app);
`;
    },
  };
}
