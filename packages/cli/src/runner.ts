import { existsSync, watch } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brick, isBrickApp } from "@brickkit/core";
import { importEntry } from "./app-entry";
import { TEMPORARY_FILE_PREFIX } from "./client-contract-file";
import {
  ConfigError,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_HISTORY_DAYS,
  resolvePort,
} from "./config";
import { openDashboard } from "./dashboard-host";
import type { DashboardExtensionOptions } from "./dashboard-extension";
import { startDevApplication } from "./dev-application";
import type { WorkerMessage, WorkerOptions } from "./dev-protocol";
import { writeServiceManifest } from "./manifest";
import { printBanner, serveApp, shutdownOnSignal } from "./serve";
import { buildAppWorkflows } from "./workflows";

export interface DevServerOptions {
  port?: number;
  entry?: string;
  prefix?: string;
  /** Generate a browser contract before starting the backend and frontend. */
  clientOutput?: string;
  /** Frontend command, launched once after the first successful generation. */
  frontend?: string;
  /**
   * Local dashboard with live requests, traces, errors, and reloads. Needs an
   * entry. `port` is where it listens and `historyDays` how long finished
   * requests are kept on disk; zero keeps live data only. `extension` and
   * `theme` customise it (see `DashboardExtensionOptions`).
   */
  dashboard?:
    | ({ port?: number; historyDays?: number } & DashboardExtensionOptions)
    | false;
  /**
   * Keep `<generated>/services.gen.ts` importing every definition file under
   * `services`: written before the app starts and again when files change.
   */
  manifest?: { services: string; generated: string };
}

/**
 * What `brick start` runs: serve the entry's default-exported app as it built
 * it (else one with the registered services), with the monitoring dashboard
 * it asks for, until SIGINT or SIGTERM.
 */
export async function startProdServer(options: {
  entry?: string;
  port?: number;
  /** The production dashboard's extension and theme. */
  dashboard?: DashboardExtensionOptions;
}) {
  let exported: unknown;
  if (options.entry) {
    console.log(
      `[Brick-TS] Loading application entry: ${resolve(options.entry)}`,
    );
    exported = await importEntry(options.entry, { run: true });
  }
  const port = resolvePort(options.port);
  const app = isBrickApp(exported) ? exported : brick();
  await buildAppWorkflows(app);
  const dashboard = await serveApp(app, {
    port,
    dashboard: options.dashboard,
  });
  shutdownOnSignal(app);
  printBanner(app, { label: "Production", port, dashboard });
  return app;
}

/**
 * What `brick worker` runs: load the app and deliver its events from this
 * process, without serving HTTP. Run it beside API processes that only record
 * events (`events: { dispatch: false }`), or alone for an app with no routes.
 * Workflow listeners run here too: the world starts and the steps of every run
 * in it execute in this process.
 *
 * @param options - `entry`: the app file, which must default-export a `brick()` app.
 * @returns The app.
 * @throws When the entry is missing, has no `events`, or only records events.
 */
export async function startWorker(options: { entry: string }) {
  console.log(
    `[Brick-TS] Loading application entry: ${resolve(options.entry)}`,
  );
  const app = await importEntry(options.entry, { run: true });
  if (!isBrickApp(app))
    throw new ConfigError(
      "Brick: a worker needs an entry that default-exports a BrickApp.",
    );
  if (!app.events)
    throw new ConfigError(
      "Brick: this app has no events, so a worker has nothing to deliver.",
    );
  if (!app.events.describe().dispatch)
    throw new ConfigError(
      "Brick: this app only records events (events.dispatch is false), so a worker would deliver nothing. Enable dispatch for the worker process.",
    );
  await buildAppWorkflows(app);
  await app.start();
  app.events.start();
  shutdownOnSignal(app);
  const listeners = app.events.describe().listeners;
  console.log(`\n🧱 Brick-TS Worker`);
  console.log(
    `   Delivering events to ${listeners.length} ${listeners.length === 1 ? "listener" : "listeners"}: ${listeners.map((l) => l.name).join(", ") || "none"}\n`,
  );
  return app;
}

/**
 * What `brick dev` runs: start the application, restart it when its files
 * change, and serve the dashboard beside it. With an `entry`, the app runs in
 * a worker process that restarts on every change to the entry or the files it
 * imports, and reports its requests to the dashboard; without one, a server
 * with the registered services starts in this process.
 *
 * @param options - `entry`, `port` (else `PORT`, else 4000), `prefix`,
 * `clientOutput` to regenerate the typed client's contract on each start,
 * `frontend` to launch a frontend command once, and `dashboard` (`port` and
 * `historyDays`, or `false`).
 * @returns The application, when started in this process.
 * @throws When `frontend` is given without `clientOutput`, or the dashboard
 * would use the app's port.
 */
export async function startDevServer(options: DevServerOptions = {}) {
  const entry = options.entry;
  if (!entry && (options.clientOutput || options.frontend))
    throw new ConfigError(
      "Brick: --client and --frontend require an app entry.",
    );
  if (options.frontend && !options.clientOutput)
    throw new ConfigError("Brick: --frontend requires --client <file>.");
  const port = resolvePort(options.port);
  if (!entry) return startDevApplication({ port, prefix: options.prefix });
  const resolvedEntry = resolve(entry);
  if (!existsSync(resolvedEntry))
    throw new ConfigError(
      `[Brick-TS] Error: Entry file not found: ${resolvedEntry}`,
    );

  const worker = new URL(
    import.meta.url.endsWith(".ts") ? "./dev-worker.ts" : "./dev-worker.js",
    import.meta.url,
  );
  if (
    options.dashboard &&
    (options.dashboard.port ?? DEFAULT_DASHBOARD_PORT) === port
  )
    throw new ConfigError(
      "Brick: dashboard port must differ from the API port. Use --dashboard-port <number>.",
    );
  const manifest = options.manifest;
  if (manifest) await writeServiceManifest(manifest);
  const contract = resolve(
    options.clientOutput ??
      join(manifest?.generated ?? "_brick", "contract.ts"),
  );
  const workerOptions: WorkerOptions = {
    entry: resolvedEntry,
    port,
    prefix: options.prefix,
    clientOutput: options.clientOutput && contract,
    telemetry: Boolean(options.dashboard),
  };
  // Bind the dashboard before the first worker starts, so the worker's spans
  // have somewhere to go.
  const dashboard = options.dashboard
    ? await openDashboard({
        port: options.dashboard.port ?? DEFAULT_DASHBOARD_PORT,
        directory: process.cwd(),
        historyDays: options.dashboard.historyDays ?? DEFAULT_HISTORY_DAYS,
        warn: (message) => console.warn(message),
        docs: true,
        dashboard: {
          extension: options.dashboard.extension,
          theme: options.dashboard.theme,
        },
        restart: () => {
          void restart("dashboard");
        },
        portHint: "Use --dashboard-port <number> or --no-dashboard.",
      })
    : undefined;
  const telemetry = dashboard?.store;
  let frontend: ReturnType<typeof Bun.spawn> | undefined;
  const dependencyFiles = new Set<string>();
  const dependencyWatchers = new Map<string, ReturnType<typeof watch>>();
  let stopped = false;
  const intentionalExits = new WeakSet<ReturnType<typeof Bun.spawn>>();
  const receive = (message: WorkerMessage, generation: number) => {
    switch (message.type) {
      case "brick:telemetry":
        telemetry?.ingest(message.records, generation);
        return;
      case "brick:error":
        telemetry?.recordWorkerError(message.phase, message.error, generation);
        return;
      case "brick:contract-ready":
        if (options.frontend && !frontend && !stopped)
          frontend = Bun.spawn(
            [process.env.SHELL ?? "/bin/sh", "-c", options.frontend],
            {
              detached: true,
              cwd: process.cwd(),
              stdout: "inherit",
              stderr: "inherit",
            },
          );
        telemetry?.recordReload({
          kind: "contract-ready",
          generation,
          detail: "browser contract generated",
        });
        return;
      case "brick:architecture":
        telemetry?.setArchitecture(message.architecture, generation);
        void dashboard?.setPluginExtensions(message.architecture.plugins ?? []);
        return;
      case "brick:inspector":
        if (generation === telemetry?.latestGeneration)
          telemetry.setInspector({ port: message.port, token: message.token });
        return;
      case "brick:documentation":
        void dashboard?.docs?.configure(
          dirname(resolvedEntry),
          message.documentation,
        );
        return;
      case "brick:api-documents":
        telemetry?.setApiDocuments(
          message.documents,
          `http://localhost:${port}`,
        );
        return;
      case "brick:dependencies":
        for (const file of message.files) {
          if (file === contract) continue;
          dependencyFiles.add(file);
          const directory = dirname(file);
          if (!dependencyWatchers.has(directory))
            dependencyWatchers.set(
              directory,
              watch(directory, (_event, filename) => {
                if (
                  !filename ||
                  !dependencyFiles.has(resolve(directory, filename))
                )
                  return;
                scheduleRestart();
              }),
            );
        }
        return;
    }
  };
  const launch = () => {
    // The new process serves its own inspector once it is up.
    telemetry?.setInspector(undefined);
    const generation = telemetry?.startGeneration() ?? 0;
    const application = Bun.spawn(
      [process.execPath, fileURLToPath(worker), JSON.stringify(workerOptions)],
      {
        cwd: process.cwd(),
        stdout: "inherit",
        stderr: "inherit",
        ipc: (message: WorkerMessage) => receive(message, generation),
      },
    );
    void application.exited.then((code) => {
      if (generation === telemetry?.latestGeneration)
        telemetry.setInspector(undefined);
      if (!stopped && !intentionalExits.has(application)) {
        console.error(
          `[Brick-TS] Application process exited with code ${code}. Waiting for changes to restart.`,
        );
        telemetry?.recordReload({
          kind: "exited",
          generation,
          detail: `exit code ${code}`,
        });
      }
      telemetry?.interruptGeneration(generation);
    });
    return application;
  };
  if (dashboard) {
    console.log(`📊 Dev dashboard:       http://127.0.0.1:${dashboard.port}`);
  }
  let child = launch();
  // The worker reports the other files the entry imports (brick:dependencies).
  const watchDirs = [
    ...new Set([
      dirname(resolvedEntry),
      ...(manifest ? [manifest.services] : []),
    ]),
  ].filter(existsSync);
  let pending: ReturnType<typeof setTimeout> | undefined;
  let restarting = false;
  let dirty = false;

  async function restart(trigger: "changes" | "dashboard" = "changes") {
    dirty = true;
    if (restarting || stopped) return;
    restarting = true;
    try {
      while (dirty && !stopped) {
        dirty = false;
        console.log(
          trigger === "changes"
            ? "\n📝 Changes detected. Restarting server..."
            : "\n🔄 Restart requested from the dashboard. Restarting server...",
        );
        telemetry?.recordReload({
          kind: "restarting",
          generation: telemetry.latestGeneration,
          detail:
            trigger === "changes" ? "source changed" : "restart from dashboard",
        });
        intentionalExits.add(child);
        child.kill();
        await child.exited;
        if (!stopped) child = launch();
      }
    } finally {
      restarting = false;
    }
  }

  function scheduleRestart() {
    clearTimeout(pending);
    pending = setTimeout(() => {
      void restart();
    }, 100);
  }
  const extension = options.dashboard && options.dashboard.extension;
  const extensionDir =
    extension && !watchDirs.includes(dirname(resolve(extension)))
      ? `${dirname(resolve(extension))}${sep}`
      : undefined;
  const watchers = watchDirs.map((dir) =>
    watch(dir, { recursive: true }, (_event, filename) => {
      if (!filename || filename.split(/[\\/]/).includes("node_modules")) return;
      const file = resolve(dir, filename);
      if (
        file === contract ||
        basename(file).startsWith(TEMPORARY_FILE_PREFIX) ||
        // The dashboard rebuilds its extension itself; the app restarts only
        // for the files it imports.
        (extensionDir !== undefined &&
          file.startsWith(extensionDir) &&
          !dependencyFiles.has(file))
      )
        return;
      // A definition file was added or removed: refresh the import list first.
      if (manifest && file.startsWith(manifest.services + sep)) {
        void writeServiceManifest(manifest)
          .catch((error: unknown) =>
            console.error("[Brick-TS] Could not write services.gen.ts:", error),
          )
          .finally(scheduleRestart);
        return;
      }
      scheduleRestart();
    }),
  );
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(pending);
    for (const watcher of watchers) watcher.close();
    for (const watcher of dependencyWatchers.values()) watcher.close();
    if (frontend) {
      if (process.platform === "win32") {
        Bun.spawnSync(["taskkill", "/pid", String(frontend.pid), "/t", "/f"]);
      } else {
        try {
          process.kill(-frontend.pid, "SIGTERM");
        } catch (error) {
          if (
            !(
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )
          )
            throw error;
        }
      }
    }
    dashboard?.stop();
    child.kill();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", stop);
  };
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopped) {
      child.kill("SIGKILL");
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
    stop();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    void child.exited.then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", stop);
  console.log(`\n👀 Watching for changes in: ${watchDirs.join(", ")}`);
  return { stop };
}
