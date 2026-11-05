import type { BrickApp } from "@brickkit/core";
import type { DashboardExtensionOptions } from "./dashboard-extension";
import type { ProductionDashboard } from "./production-dashboard";

/**
 * Serve an app: the monitoring dashboard it asks for with `brick({ dashboard })`
 * (unless `dashboard` is false), then the app itself. What `brick dev`'s
 * worker, `brick start` and a built server run.
 */
export async function serveApp(
  app: BrickApp,
  options: { port: number; dashboard?: DashboardExtensionOptions | false },
): Promise<ProductionDashboard | undefined> {
  // Before listening, so the first request is already traced and its logs kept.
  // Loaded only when asked for: a built server bundles this file, and resolves
  // the dashboard from @brickkit/cli at run time (see build.ts).
  const dashboard =
    app.definition.dashboard && options.dashboard !== false
      ? await (
          await import("./production-dashboard")
        ).startProductionDashboard(app, {
          appPort: options.port,
          dashboard: options.dashboard,
        })
      : undefined;
  await app.serve({ port: options.port });
  return dashboard;
}

/**
 * Shut the app down at SIGINT or SIGTERM, finishing the deliveries in flight,
 * then exit. A second signal exits at once, for a delivery that never finishes.
 */
export function shutdownOnSignal(app: Pick<BrickApp, "shutdown">) {
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return process.exit(signal === "SIGINT" ? 130 : 143);
    stopping = true;
    void app.shutdown().finally(() => process.exit(0));
  };
  // `on`, not `once`: the workflow bundle loads signal-exit, which re-raises the
  // signal itself when it finds no listener left, and `once` removes ours first.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
}

/** The startup lines: each service's routes as mounted, then where to reach the app. */
export function printBanner(
  app: BrickApp,
  options: {
    label: string;
    port: number;
    dashboard?: Pick<ProductionDashboard, "host" | "port">;
  },
) {
  const { services, routes } = app.definition;
  console.log(`\n🧱 Brick-TS ${options.label} Server`);
  console.log(`   Registered Services: ${services.length}`);
  for (const svc of services) {
    console.log(`   • ${svc.name} (${svc.listActions().length} actions)`);
    for (const route of routes)
      if (route.service === svc.name)
        console.log(`     -> ${route.method.padEnd(6)} ${route.path}`);
  }
  const base = `http://localhost:${options.port}`;
  console.log(`\n⚡ API Gateway running on: ${base}`);
  console.log(`🩺 Health check:        ${base}/_health`);
  const dashboard = options.dashboard;
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
  console.log(`🗺️ Architecture graph:  ${base}/_brick/services\n`);
}
