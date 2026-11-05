import type { TraceSummary } from "../../src/dashboard-protocol";

/** Show the request's own path where the route is a wildcard such as /api/auth/*. */
export function routeLabel(
  trace: Pick<TraceSummary, "route" | "path" | "name">,
): string {
  const wildcard = trace.route?.includes("*") && trace.path;
  return (wildcard ? trace.path : trace.route) ?? trace.name;
}
