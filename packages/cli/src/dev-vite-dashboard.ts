import { dirname } from "node:path";
import {
  getGlobalRegistry,
  type ApiDocument,
  type BrickApp,
} from "@brickkit/core";
import { DEFAULT_DASHBOARD_PORT, DEFAULT_HISTORY_DAYS } from "./config";
import { openDashboard } from "./dashboard-host";
import { ROUTES } from "./dashboard-protocol";
import type { DashboardExtensionOptions } from "./dashboard-extension";

export interface DashboardLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface ViteDashboard {
  /** Where the app reports its spans; see installDevReporter. */
  readonly ingestUrl: string;
  /** Record the architecture of the application module Vite loaded. */
  architecture(app: BrickApp): void;
  /** Where the dev server is reachable, once it is listening. */
  origin(url: string): void;
  stop(): void;
}

/**
 * Serve the dashboard from inside the Vite dev server. Dev servers run the app
 * in a worker, which reports its spans here over HTTP. This process keeps the
 * history, so it survives worker restarts.
 */
export async function startViteDashboard(options: {
  port?: number;
  /** The project folder; history is kept in `.brick/` inside it. */
  directory: string;
  /** The app entry module; the paths in `documentation` start at its folder. */
  entry: string;
  /** Days of requests to keep on disk; zero for none. */
  historyDays?: number;
  /** The extension (an absolute path) and theme. */
  dashboard?: DashboardExtensionOptions;
  logger: DashboardLogger;
}): Promise<ViteDashboard | undefined> {
  const dashboard = await openDashboard({
    port: options.port ?? DEFAULT_DASHBOARD_PORT,
    directory: options.directory,
    historyDays: options.historyDays ?? DEFAULT_HISTORY_DAYS,
    warn: (message) => options.logger.warn(message),
    docs: true,
    dashboard: options.dashboard,
    portHint:
      "Set dashboard.port in brickClient() to another, or dashboard: false.",
  });
  if (!dashboard) return undefined;
  const { store, docs } = dashboard;
  options.logger.info(
    `  ➜  Brick dashboard: http://127.0.0.1:${dashboard.port}`,
  );

  let stopped = false;
  let origin: string | undefined;
  let documents: ApiDocument[] | undefined;
  let loads = 0;
  // The server starts listening after the app first loads, so the documents
  // are published again once its address is known.
  const publishDocuments = () => {
    if (documents) store.setApiDocuments(documents, origin);
  };
  return {
    ingestUrl: `http://127.0.0.1:${dashboard.port}${ROUTES.ingest.path}`,
    architecture(app) {
      store.setArchitecture(
        getGlobalRegistry().exportArchitecture(app.definition),
        store.latestGeneration,
      );
      void docs?.configure(
        dirname(options.entry),
        app.definition.documentation,
      );
      // A later load supersedes this one if it finishes first.
      const load = ++loads;
      app.referenceDocuments().then(
        (loaded) => {
          if (load !== loads || stopped) return;
          documents = loaded;
          publishDocuments();
        },
        (error: unknown) =>
          options.logger.warn(
            `[Brick-TS] Could not load the API documents: ${error instanceof Error ? error.message : String(error)}`,
          ),
      );
    },
    origin(url) {
      origin = url;
      publishDocuments();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      dashboard.stop();
    },
  };
}
