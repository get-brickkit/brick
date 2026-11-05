/*
 * `@brickkit/cli/dashboard`: what a project's dashboard extension imports.
 * The build makes this its own module (`kit.js`), which the page's import map
 * names, so the extension shares the dashboard's components, contexts and
 * React rather than bundling copies.
 */

export {
  defineDashboard,
  type DashboardExtension,
  type DashboardSlots,
  type DrawerTab,
  type DrawerTabContext,
  type ExtensionPage,
  type PageProps,
  type Placement,
  type SidebarLink,
  type SidebarSlotContext,
  type SlotContext,
  type SlotName,
} from "@/extension-registry";
export {
  appFetch,
  createAppClient,
  useAppFetch,
  useAppQuery,
  useArchitecture,
  useRequests,
  type AppFetchResult,
} from "@/extension";
export type { Route } from "@/state";
export type { TraceSummary, TraceSpan } from "../src/dashboard-protocol";

export { Panel } from "@/components/panel";
export { Metric, SparkBars } from "@/components/metric";
export { PageHeader, Empty } from "@/components/page-header";
export { cn } from "@/lib/utils";
export * from "@/components/ui/badge";
export * from "@/components/ui/button";
export * from "@/components/ui/card";
export * from "@/components/ui/checkbox";
export * from "@/components/ui/input";
export * from "@/components/ui/kbd";
export * from "@/components/ui/popover";
export * from "@/components/ui/separator";
export * from "@/components/ui/table";
export * from "@/components/ui/toggle";
export * from "@/components/ui/toggle-group";
export * from "@/components/ui/tooltip";
