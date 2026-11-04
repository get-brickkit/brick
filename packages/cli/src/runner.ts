import { existsSync } from "fs";
import { watch } from "fs";
import { resolve, dirname, basename, sep } from "path";
import { fileURLToPath } from "node:url";
import {
  brick,
  getActionRoute,
  isBrickApp,
  internalToken,
  remoteEnv,
  startRemoteServices,
  type ApiDocument,
  type RemoteProcesses,
  type RemoteService,
  type ArchitectureSchema,
  type BrickApp,
  type DocumentationOptions,
  type EventsHub,
} from "@brickkit/core";
import {
  DEFAULT_DASHBOARD_PORT,
  startDevDashboard,
  type DevDashboard,
} from "./dev-dashboard";
import type { DashboardExtensionOptions } from "./dashboard-extension";
import { DocsHost } from "./dev-docs";
import { DEFAULT_HISTORY_DAYS, openHistory } from "./dev-history";
import { DevTelemetryStore } from "./dev-telemetry-store";
import { parsePort } from "./port-utils";
import { writeServiceManifest } from "./manifest";
import { buildAppWorkflows, registerWorkflowTransform } from "./workflows";
import { startProductionDashboard } from "./production-dashboard";
import { noticeExperimental, startDevRemotes } from "./polyglot";
import type {
  SerializedError,
  TelemetryRecord,
  WorkerErrorPhase,
} from "./dev-telemetry";

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
   * entry. `port` defaults to 9400. `historyDays` is how long finished
   * requests are kept on disk (default 90); zero keeps live data only.
   * `extension` and `theme` customise it (see `DashboardExtensionOptions`);
   * `brick start` reads only those two, for the production dashboard.
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

async function createServer(
  options: DevServerOptions,
  label: string,
  application?: BrickApp,
) {
  let port: number;
  if (options.port !== undefined) {
    port = options.port;
  } else if (process.env.PORT !== undefined && process.env.PORT !== "") {
    port = Number(process.env.PORT);
  } else {
    port = 4000;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid port: ${port}. Port must be an integer between 1 and 65535`,
    );
  }

  const app =
    application ??
    brick({
      port,
      prefix: options.prefix,
    });

  await buildAppWorkflows(app, { reuse: label === "Development" });
  // Plugins open their connections before the first request.
  await app.start?.();
  await app.listen({ port });
  app.events?.start();

  const prefix = app.definition.prefix;
  const services = app.definition.services;

  console.log(`\n🧱 Brick-TS ${label} Server`);
  console.log(`   Registered Services: ${services.length}`);

  for (const svc of services) {
    const actions = svc.listActions();
    console.log(`   • ${svc.name} (${actions.length} actions)`);
    for (const act of actions) {
      const route = getActionRoute(act, prefix);
      if (route === false) continue;
      console.log(`     -> ${route.method.padEnd(6)} ${route.path}`);
    }
  }

  console.log(`\n⚡ API Gateway running on: http://localhost:${port}`);
  console.log(`🩺 Health check:        http://localhost:${port}/_health`);
  console.log(
    `🗺️ Architecture graph:  http://localhost:${port}/_brick/services\n`,
  );

  return app;
}

/**
 * Finish the deliveries in flight at SIGINT or SIGTERM, then exit. A second
 * signal exits at once, for a delivery that never finishes.
 */
export function finishDeliveriesOnSignal(
  events: Pick<EventsHub, "stop">,
  signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"],
) {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return process.exit(signal === "SIGINT" ? 130 : 143);
    stopping = true;
    void events.stop().finally(() => process.exit(0));
  };
  // `on`, not `once`: the workflow bundle loads signal-exit, which re-raises the
  // signal itself when it finds no listener left, and `once` removes ours first.
  for (const signal of signals) process.on(signal, stop);
}

/** What the dev worker tells the supervisor about the app's remote services. */
interface RemoteMessage {
  type: "brick:remote";
  remote: { name: string; dir: string; dev: string; port?: number }[];
  services: string[];
  env: Record<string, string>;
}

export async function startProdServer(options: DevServerOptions = {}) {
  const entry = options.entry;

  let exported: BrickApp | undefined;
  if (entry) {
    const resolvedEntry = resolve(process.cwd(), entry);
    if (!existsSync(resolvedEntry)) {
      console.error(`[Brick-TS] Error: Entry file not found: ${resolvedEntry}`);
      process.exit(1);
    }
    console.log(`[Brick-TS] Loading application entry: ${resolvedEntry}`);
    await registerWorkflowTransform();
    const module = await import(resolvedEntry);
    // An entry that default-exports its app is served as it built it, with its
    // options (telemetry, dashboard, and the rest), as `brick dev` does.
    if (isBrickApp(module?.default)) exported = module.default;
  }
  if (exported && options.prefix !== undefined) {
    console.warn(
      `[Brick-TS] Ignoring prefix ${options.prefix}: exported BrickApp prefix ${exported.definition.prefix} takes precedence.`,
    );
  }

  const port =
    options.port !== undefined
      ? options.port
      : process.env.PORT !== undefined && process.env.PORT !== ""
        ? Number(process.env.PORT)
        : 4000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid port: ${port}. Port must be an integer between 1 and 65535`,
    );
  }

  const app =
    exported ??
    brick({
      port,
      prefix: options.prefix,
    });

  const prefix = app.definition.prefix;
  const services = app.definition.services;

  console.log(`\n🧱 Brick-TS Production Server`);
  console.log(`   Registered Services: ${services.length}`);

  for (const svc of services) {
    const actions = svc.listActions();
    console.log(`   • ${svc.name} (${actions.length} actions)`);
    for (const act of actions) {
      const route = getActionRoute(act, prefix);
      if (route === false) continue;
      console.log(`     -> ${route.method.padEnd(6)} ${route.path}`);
    }
  }

  await buildAppWorkflows(app);
  const remote = app.definition.remote ?? [];
  noticeExperimental(remote);
  const children = remote.length
    ? await startRemoteServices(remote, {
        mode: "start",
        appUrl: `http://127.0.0.1:${port}`,
        services: services.map((service) => service.name),
        env: remoteEnv(app.definition),
      })
    : undefined;
  // Before listening, so the first request is already traced and its logs kept.
  const dashboard = await startProductionDashboard(app, {
    appPort: port,
    dashboard: options.dashboard || undefined,
  });
  await app.start?.();
  app.listen(port);
  app.events?.start();
  // Finish deliveries, then stop the server and the plugins (reverse order).
  finishDeliveriesOnSignal({
    stop: async () => {
      await app.events?.stop();
      await app.stop();
      await children?.stop();
    },
  });
  for (const service of remote)
    console.log(
      `   • ${service.name} (remote) -> ${children!.urls[service.name]}`,
    );

  console.log(`\n⚡ API Gateway running on: http://localhost:${port}`);
  console.log(`🩺 Health check:        http://localhost:${port}/_health`);
  if (dashboard) {
    const shown =
      dashboard.host === "0.0.0.0" || dashboard.host === "::"
        ? "localhost"
        : dashboard.host.includes(":")
          ? `[${dashboard.host.replace(/^\[|\]$/g, "")}]`
          : dashboard.host;
    console.log(
      `📊 Dashboard:           http://${shown}:${dashboard.port} (health: /_health)`,
    );
  }
  console.log(
    `🗺️ Architecture graph:  http://localhost:${port}/_brick/services\n`,
  );

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
  const resolvedEntry = resolve(process.cwd(), options.entry);
  if (!existsSync(resolvedEntry)) {
    console.error(`[Brick-TS] Error: Entry file not found: ${resolvedEntry}`);
    process.exit(1);
  }
  console.log(`[Brick-TS] Loading application entry: ${resolvedEntry}`);
  await registerWorkflowTransform();
  const app = (await import(resolvedEntry))?.default;
  if (!isBrickApp(app))
    throw new Error(
      "Brick: a worker needs an entry that default-exports a BrickApp.",
    );
  if (!app.events)
    throw new Error(
      "Brick: this app has no events, so a worker has nothing to deliver.",
    );
  if (!app.events.describe().dispatch)
    throw new Error(
      "Brick: this app only records events (events.dispatch is false), so a worker would deliver nothing. Enable dispatch for the worker process.",
    );
  await buildAppWorkflows(app);
  const events = app.events;
  await app.start?.();
  events.start();
  finishDeliveriesOnSignal({
    stop: async () => {
      await events.stop();
      await app.stop();
    },
  });
  const listeners = app.events.describe().listeners;
  console.log(`\n🧱 Brick-TS Worker`);
  console.log(
    `   Delivering events to ${listeners.length} ${listeners.length === 1 ? "listener" : "listeners"}: ${listeners.map((l) => l.name).join(", ") || "none"}\n`,
  );
  return app;
}

export async function startDevApplication(options: DevServerOptions) {
  if (options.entry) await registerWorkflowTransform();
  const module = options.entry
    ? await import(resolve(options.entry))
    : undefined;
  if (isBrickApp(module?.default) && options.prefix !== undefined) {
    console.warn(
      `[Brick-TS] Ignoring prefix ${options.prefix}: exported BrickApp prefix ${module.default.definition.prefix} takes precedence.`,
    );
  }
  if (options.clientOutput) {
    if (!isBrickApp(module?.default))
      throw new Error(
        "Brick: client generation requires a default-exported BrickApp.",
      );
    const { generateClientContract } = await import("./client-contract");
    const { writeContractSource } = await import("./client-contract-file");
    const { requireBrickApp } = await import("./app-entry");
    const output = resolve(options.clientOutput);
    if (output === resolve(options.entry!))
      throw new Error(
        "Brick: contract output must not overwrite the app entry.",
      );
    await writeContractSource(
      output,
      generateClientContract(requireBrickApp(module.default)),
    );
    process.send?.({ type: "brick:contract-ready" });
  }
  return createServer(
    options,
    "Development",
    isBrickApp(module?.default) ? module.default : undefined,
  );
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
    throw new Error("Brick: --client and --frontend require an app entry.");
  if (!entry) return createServer(options, "Development");
  const resolvedEntry = resolve(entry);
  if (!existsSync(resolvedEntry)) {
    console.error(`[Brick-TS] Error: Entry file not found: ${resolvedEntry}`);
    process.exit(1);
  }

  const worker = new URL(
    import.meta.url.endsWith(".ts") ? "./dev-worker.ts" : "./dev-worker.js",
    import.meta.url,
  );
  if (options.frontend && !options.clientOutput)
    throw new Error("Brick: --frontend requires --client <file>.");
  if (
    options.dashboard &&
    options.port !== undefined &&
    (options.dashboard.port ?? DEFAULT_DASHBOARD_PORT) === options.port
  )
    throw new Error(
      "Brick: dashboard port must differ from the API port. Use --dashboard-port <number>.",
    );
  // The worker resolves its port the same way, so this is where the app listens.
  const appPort = () =>
    parsePort(
      options.port === undefined ? undefined : String(options.port),
      process.env.PORT,
    );
  const manifest = options.manifest;
  if (manifest) await writeServiceManifest(manifest);
  const history = options.dashboard
    ? await openHistory({
        directory: process.cwd(),
        days: options.dashboard.historyDays ?? DEFAULT_HISTORY_DAYS,
        warn: (message) => console.warn(message),
      })
    : undefined;
  const telemetry = options.dashboard
    ? new DevTelemetryStore({ history })
    : undefined;
  const docs = telemetry
    ? new DocsHost(telemetry, (message) => console.warn(message))
    : undefined;
  let frontend: ReturnType<typeof Bun.spawn> | undefined;
  const dependencyFiles = new Set<string>();
  const dependencyWatchers = new Map<string, ReturnType<typeof watch>>();
  let stopped = false;
  const intentionalExits = new WeakSet<ReturnType<typeof Bun.spawn>>();
  let generationCount = 0;
  let childGeneration = 0;
  // Go and Rust services: started once, restarted only when their own files change.
  internalToken();
  let children: Promise<RemoteProcesses> | undefined;
  const startChildren = async (
    message: RemoteMessage,
    worker: ReturnType<typeof Bun.spawn>,
  ) => {
    // shortcut: remote services added after the first start need a `brick dev` restart.
    children ??= startDevRemotes(
      message.remote.map((options) => ({
        kind: "remote" as const,
        name: options.name,
        options,
      })) as RemoteService[],
      {
        appUrl: `http://127.0.0.1:${appPort()}`,
        services: message.services,
        env: message.env,
      },
    );
    const processes = await children;
    if (!stopped) worker.send({ type: "brick:services", urls: processes.urls });
  };
  const launch = () => {
    const generation = ++generationCount;
    childGeneration = generation;
    // The new process serves its own inspector once it is up.
    telemetry?.setInspector(undefined);
    telemetry?.recordReload({ kind: "started", generation });
    const application = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(worker),
        resolvedEntry,
        String(options.port ?? ""),
        options.prefix ?? "",
        options.clientOutput ? resolve(options.clientOutput) : "",
        telemetry ? "1" : "",
      ],
      {
        cwd: process.cwd(),
        // Explicit, so the worker sees the internal token and BRICK_SERVICES set above.
        env: { ...process.env },
        stdout: "inherit",
        stderr: "inherit",
        ipc(message) {
          if (!message || typeof message !== "object" || !("type" in message))
            return;
          if (message.type === "brick:remote" && "remote" in message) {
            void startChildren(
              message as unknown as RemoteMessage,
              application,
            ).catch((error: unknown) =>
              console.error(
                "[Brick-TS] Could not start remote services:",
                error,
              ),
            );
          }
          if (
            telemetry &&
            message.type === "brick:telemetry" &&
            "records" in message &&
            Array.isArray(message.records)
          ) {
            telemetry.ingest(message.records as TelemetryRecord[], generation);
          }
          if (
            telemetry &&
            message.type === "brick:error" &&
            "phase" in message &&
            "error" in message
          ) {
            telemetry.recordWorkerError(
              message.phase as WorkerErrorPhase,
              message.error as SerializedError,
              generation,
            );
          }
          if (
            message.type === "brick:contract-ready" &&
            options.frontend &&
            !frontend &&
            !stopped
          ) {
            frontend = Bun.spawn(
              [process.env.SHELL ?? "/bin/sh", "-c", options.frontend],
              {
                detached: true,
                cwd: process.cwd(),
                stdout: "inherit",
                stderr: "inherit",
              },
            );
          }
          if (
            telemetry &&
            message.type === "brick:architecture" &&
            "architecture" in message
          ) {
            telemetry.setArchitecture(
              message.architecture as ArchitectureSchema,
              generation,
            );
            void dashboard?.setPluginExtensions(
              (message.architecture as ArchitectureSchema).plugins ?? [],
            );
          }
          if (
            telemetry &&
            message.type === "brick:inspector" &&
            generation === childGeneration &&
            "port" in message &&
            "token" in message
          ) {
            telemetry.setInspector({
              port: message.port as number,
              token: message.token as string,
            });
          }
          if (docs && message.type === "brick:documentation") {
            void docs.configure(
              dirname(resolvedEntry),
              "documentation" in message
                ? (message.documentation as DocumentationOptions | undefined)
                : undefined,
            );
          }
          if (
            telemetry &&
            message.type === "brick:api-documents" &&
            "documents" in message &&
            Array.isArray(message.documents)
          ) {
            telemetry.setApiDocuments(
              message.documents as ApiDocument[],
              `http://localhost:${appPort()}`,
            );
          }
          if (telemetry && message.type === "brick:contract-ready") {
            telemetry.recordReload({
              kind: "contract-ready",
              generation,
              detail: "browser contract generated",
            });
          }
          if (
            message.type === "brick:dependencies" &&
            "files" in message &&
            Array.isArray(message.files)
          ) {
            for (const file of message.files) {
              if (
                typeof file !== "string" ||
                file === resolve(options.clientOutput ?? "_brick/contract.ts")
              )
                continue;
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
          }
        },
      },
    );
    void application.exited.then((code) => {
      if (generation === childGeneration) telemetry?.setInspector(undefined);
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
  // Bind the dashboard before the first worker starts, so a port conflict
  // does not leave an application process running.
  const dashboard: DevDashboard | undefined =
    telemetry && options.dashboard
      ? await startDevDashboard({
          port: options.dashboard.port ?? DEFAULT_DASHBOARD_PORT,
          store: telemetry,
          history,
          docs: () => docs?.current,
          dashboard: {
            extension: options.dashboard.extension,
            theme: options.dashboard.theme,
          },
          restart: () => {
            void restart("dashboard");
          },
        }).catch((error: unknown) => {
          history?.close();
          throw error;
        })
      : undefined;
  if (dashboard) {
    console.log(`📊 Dev dashboard:       http://127.0.0.1:${dashboard.port}`);
  }
  let child = launch();
  const watchDirs = [
    ...new Set([
      resolve("src"),
      resolve("app"),
      resolve(resolvedEntry, ".."),
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
          generation: childGeneration,
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
        file === resolve(options.clientOutput ?? "_brick/contract.ts") ||
        basename(file).startsWith(".brick-contract-") ||
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
    docs?.close();
    history?.close();
    void children?.then((processes) => processes.stop());
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
