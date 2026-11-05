import {
  CSRF_HEADER,
  CSRF_VALUE,
  type IngestPayload,
} from "./dashboard-protocol";
import { installTracing } from "./dev-telemetry";

export interface DevReporterOptions {
  /** The dashboard's ingest endpoint, for example http://127.0.0.1:9400/api/ingest. */
  url: string;
}

/**
 * Report this process's spans to a running dashboard. Dev servers that evaluate
 * the app in a worker (Vite with Nitro or TanStack Start) cannot share memory
 * with the dashboard, so the worker posts its spans over loopback HTTP. Call
 * before the app is constructed. Reporting is best effort: a dashboard that is
 * not running never affects the app.
 */
export function installDevReporter(options: DevReporterOptions): boolean {
  const post = (body: IngestPayload) => {
    void fetch(options.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CSRF_HEADER]: CSRF_VALUE,
      },
      body: JSON.stringify(body),
    }).catch(() => {});
  };
  const registered = installTracing((records) => post({ records }));
  post({ worker: "application loaded" });
  return registered;
}
