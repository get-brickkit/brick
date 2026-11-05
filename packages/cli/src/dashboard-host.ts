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
 * it opened is closed, `warn` says why, and the host runs on without it.
 */
export async function openDashboard(
  options: Omit<DevDashboardOptions, "store" | "history" | "docs"> & {
    /** The project folder; history is kept in `.brick/` inside it. */
    directory: string;
    /** Days of requests to keep on disk; zero for none. */
    historyDays: number;
    warn: (message: string) => void;
    /** Serve the app's developer documentation (the Docs tab). */
    docs?: boolean;
  },
): Promise<DashboardHost | undefined> {
  const { directory, historyDays, warn, docs: withDocs, ...rest } = options;
  const history = await openHistory({ directory, days: historyDays, warn });
  const store = new DevTelemetryStore({ history });
  const docs = withDocs ? new DocsHost(store, warn) : undefined;
  let server: DevDashboard;
  try {
    server = await startDevDashboard({
      ...rest,
      store,
      history,
      docs: docs && (() => docs.current),
    });
  } catch (error) {
    docs?.close();
    history?.close();
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
