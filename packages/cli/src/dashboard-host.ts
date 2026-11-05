import {
  ConfigError,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_HISTORY_DAYS,
} from "./config";
import { DocsHost } from "./dev-docs";
import {
  startDevDashboard,
  type DevDashboard,
  type DevDashboardOptions,
} from "./dev-dashboard";
import { openHistory } from "./dev-history";
import { DevTelemetryStore } from "./dev-telemetry-store";

export interface DashboardHost extends DevDashboard {
  /** Where the host records what the app reports. */
  readonly store: DevTelemetryStore;
  /** The app's developer documentation, when `docs` was asked for. */
  readonly docs?: DocsHost;
}

/**
 * Open the dashboard with its history, store and docs, for `brick dev`, the
 * Vite plugin and the production dashboard alike. When it cannot start, what
 * it opened is closed, `warn` says why, and the host runs on without it. A
 * configuration mistake (a bad theme, a public host without auth) throws.
 */
export async function openDashboard(
  options: Omit<DevDashboardOptions, "store" | "history" | "docs" | "port"> & {
    /** Default 9400. */
    port?: number;
    /** The project folder; history is kept in `.brick/` inside it. */
    directory: string;
    /** Days of requests to keep on disk; zero for none. Default 90. */
    historyDays?: number;
    warn: (message: string) => void;
    /** Serve the app's developer documentation (the Docs tab). */
    docs?: boolean;
  },
): Promise<DashboardHost | undefined> {
  const {
    port = DEFAULT_DASHBOARD_PORT,
    directory,
    historyDays = DEFAULT_HISTORY_DAYS,
    warn,
    docs: withDocs,
    ...rest
  } = options;
  const history = await openHistory({ directory, days: historyDays, warn });
  const store = new DevTelemetryStore({ history });
  const docs = withDocs
    ? new DocsHost((docs) => store.setDocs(docs), warn)
    : undefined;
  let server: DevDashboard;
  try {
    server = await startDevDashboard({
      ...rest,
      port,
      store,
      history,
      docs: docs && (() => docs.current),
    });
  } catch (error) {
    docs?.close();
    history?.close();
    if (error instanceof ConfigError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    warn(`[Brick-TS] ${reason} Continuing without the dashboard.`);
    return undefined;
  }
  return {
    port: server.port,
    store,
    docs,
    setPluginExtensions: (plugins) => server.setPluginExtensions(plugins),
    stop() {
      server.stop();
      docs?.close();
      history?.close();
    },
  };
}
