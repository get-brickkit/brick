import { getGlobalRegistry, type BrickApp } from "@brickkit/core";
import { isLoopbackHost } from "./dashboard-access";
import {
  themeCss,
  type DashboardExtensionOptions,
} from "./dashboard-extension";
import { DEFAULT_DASHBOARD_PORT } from "./config";
import { openDashboard } from "./dashboard-host";
import { installTracing } from "./dev-telemetry";

export interface ProductionDashboard {
  readonly host: string;
  readonly port: number;
  stop(): void;
}

/**
 * Serve the monitoring dashboard an app asks for with `brick({ dashboard })`,
 * in the process that serves the app. It listens on a port of its own, so it
 * stays up when the app's routes do not answer, and its `/_health` tells an
 * uptime monitor whether the app does. From here on `ctx.logger` and `console`
 * lines written during a request go to the dashboard, not the console.
 *
 * Call it before the app starts listening. Returns undefined when the app
 * asks for no dashboard, or when it cannot start (the app runs on without it,
 * and says so). A configuration that would leave the dashboard open to others
 * throws instead: the app must not start unprotected.
 */
export async function startProductionDashboard(
  app: BrickApp,
  options: {
    /** The port the app listens on, for the health probe. */
    appPort: number;
    /** Where `.brick/` history is kept; the working folder by default. */
    directory?: string;
    warn?: (message: string) => void;
    /**
     * The project's extension (source, or the folder `brick build` wrote) and
     * theme. The app's plugins' extensions join it, from source or as the
     * folder holds them. Only pages marked `production: true` are shown.
     */
    dashboard?: DashboardExtensionOptions;
  },
): Promise<ProductionDashboard | undefined> {
  const config = app.definition.dashboard;
  if (!config) return undefined;
  const warn = options.warn ?? ((message) => console.warn(message));
  // A mistyped token is a configuration error, not a reason to run without the dashboard.
  themeCss(options.dashboard?.theme);
  const host = config.host ?? "127.0.0.1";
  const port = config.port ?? DEFAULT_DASHBOARD_PORT;
  if (!isLoopbackHost(host) && !config.auth) {
    throw new Error(
      `Brick: the dashboard would listen on ${host}, where others can reach it, so it needs access control. Set dashboard.auth with a token or an authorize function.`,
    );
  }

  const started = await openDashboard({
    directory: options.directory ?? process.cwd(),
    historyDays: config.historyDays ?? 0,
    warn,
    port,
    host,
    mode: "production",
    portHint: "Set dashboard.port in brick() to another.",
    auth: config.auth,
    dashboard: options.dashboard,
    plugins: app.definition.plugins,
    appUrl: `http://127.0.0.1:${options.appPort}`,
    probe: async () => {
      const response = await fetch(
        `http://127.0.0.1:${options.appPort}/_health`,
        { signal: AbortSignal.timeout(2000) },
      );
      return response.ok;
    },
  });
  if (!started) return undefined;
  const { store } = started;

  const registered = installTracing((records) =>
    store.ingest(records, store.latestGeneration),
  );
  if (!registered) {
    warn(
      "[Brick-TS] Another tracer provider is already registered, so the dashboard will show no requests or logs.",
    );
  }
  const generation = store.startGeneration("application started");
  store.setArchitecture(
    getGlobalRegistry().exportArchitecture(app.definition),
    generation,
  );
  return { host, port: started.port, stop: () => started.stop() };
}
