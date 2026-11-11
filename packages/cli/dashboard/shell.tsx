import { Fragment, type ReactNode } from "react";
import {
  Activity,
  Bell,
  Blocks,
  BookOpen,
  BookText,
  CalendarClock,
  LayoutGrid,
  Moon,
  PanelLeft,
  RefreshCw,
  RotateCw,
  ScrollText,
  Search,
  Sun,
  SunMoon,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { routeHref, type SidebarState, type Theme, type View } from "@/state";
import { Slot } from "@/extension";
import type { NavItem } from "@/extension-registry";

const builtIn = (view: View, label: string, icon: ReactNode): NavItem => ({
  key: view,
  view,
  label,
  icon,
  href: routeHref(view),
});

/** The dashboard's own pages; an extension's join them (`mergeNav`). */
export const BUILT_IN_NAV: NavItem[] = [
  builtIn("overview", "Overview", <LayoutGrid />),
  builtIn("requests", "Requests", <Activity />),
  builtIn("logs", "Logs", <ScrollText />),
  builtIn("apis", "APIs", <BookOpen />),
  builtIn("docs", "Docs", <BookText />),
  builtIn("workflows", "Workflows", <Workflow />),
  builtIn("schedules", "Schedules", <CalendarClock />),
  builtIn("errors", "Errors", <TriangleAlert />),
  builtIn("reloads", "Reloads", <RefreshCw />),
];

/**
 * An icon rail that opens to show labels. On narrow screens it slides over the
 * page instead of taking space from it.
 */
export function Sidebar({
  nav,
  current,
  sidebar,
  errorCount,
  hasNewErrors,
  hasDocs,
  hasWorkflows,
  hasSchedules,
  production,
}: {
  nav: NavItem[];
  /** The key of the page showing. */
  current: string | undefined;
  sidebar: SidebarState;
  errorCount: number;
  hasNewErrors: boolean;
  hasDocs: boolean;
  hasWorkflows: boolean;
  hasSchedules: boolean;
  /** The monitoring dashboard, which hides the views that need a developer's machine. */
  production: boolean;
}) {
  if (!sidebar.visible) return null;
  const { expanded, desktop } = sidebar;
  return (
    <>
      {!desktop && (
        <div
          aria-hidden
          className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm"
          onClick={sidebar.close}
        />
      )}
      <nav
        aria-label="Dashboard"
        data-expanded={expanded}
        className={cn(
          "flex shrink-0 flex-col gap-1 overflow-hidden border-r bg-background p-2 transition-[width] duration-200",
          desktop
            ? "sticky top-0 h-screen"
            : "fixed inset-y-0 left-0 z-50 h-screen shadow-xl",
          expanded ? "w-52" : "w-12",
        )}
      >
        <div className="mb-2 flex h-8 items-center gap-2 px-1.5 whitespace-nowrap [&_svg]:size-[18px] [&_svg]:shrink-0">
          <Blocks />
          {expanded && (
            <span className="font-semibold">
              {production ? "Brick" : "Brick dev"}
            </span>
          )}
        </div>
        <Slot name="sidebar.header" expanded={expanded} />
        {nav
          .filter(
            (item) =>
              (item.view !== "docs" || hasDocs) &&
              (item.view !== "workflows" || hasWorkflows) &&
              (item.view !== "schedules" || hasSchedules),
          )
          .map((item, index, shown) => {
            const showCount = item.view === "errors" && errorCount > 0;
            // An extension's section starts with its heading.
            const heading =
              item.section !== undefined &&
              item.section !== shown[index - 1]?.section ? (
                expanded ? (
                  <div className="mt-3 mb-1 truncate px-2 text-xs font-medium text-muted-foreground">
                    {item.section}
                  </div>
                ) : (
                  <Separator className="my-2" />
                )
              ) : null;
            const link = (
              <a
                href={item.href}
                {...(item.external
                  ? { target: "_blank", rel: "noreferrer" }
                  : {})}
                aria-label={item.label}
                aria-current={item.key === current ? "page" : undefined}
                onClick={desktop ? undefined : sidebar.close}
                className={cn(
                  "relative flex h-8 items-center gap-2 rounded-lg text-sm font-medium whitespace-nowrap text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:bg-muted aria-[current=page]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
                  expanded ? "px-2" : "w-8 justify-center",
                )}
              >
                {item.icon}
                {expanded && (
                  <span className="flex-1 truncate">{item.label}</span>
                )}
                {expanded && showCount && (
                  <Badge variant={hasNewErrors ? "destructive" : "outline"}>
                    {errorCount}
                  </Badge>
                )}
                {!expanded && item.view === "errors" && hasNewErrors && (
                  <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-destructive" />
                )}
              </a>
            );
            return (
              <Fragment key={item.key}>
                {heading}
                {expanded ? (
                  <div>{link}</div>
                ) : (
                  <Tooltip>
                    <TooltipTrigger render={link} />
                    <TooltipContent side="right">{item.label}</TooltipContent>
                  </Tooltip>
                )}
              </Fragment>
            );
          })}
        <div className="mt-auto">
          <Slot name="sidebar.footer" expanded={expanded} />
        </div>
      </nav>
    </>
  );
}

const THEME_ICON: Record<Theme, ReactNode> = {
  light: <Sun />,
  dark: <Moon />,
  system: <SunMoon />,
};

export function Topbar({
  current,
  connected,
  hasNewErrors,
  theme,
  canRestart,
  production,
  sidebarOpen,
  onSidebar,
  onSearch,
  onTheme,
  onRestart,
}: {
  /** The page showing, for its title. */
  current: NavItem | undefined;
  connected: boolean;
  hasNewErrors: boolean;
  theme: Theme;
  canRestart: boolean;
  production: boolean;
  sidebarOpen: boolean;
  onSidebar: () => void;
  onSearch: () => void;
  onTheme: () => void;
  onRestart: () => void;
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background/95 px-6 backdrop-blur-sm supports-backdrop-filter:bg-background/50 max-sm:px-4">
      <div className="flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Toggle sidebar"
                aria-expanded={sidebarOpen}
                onClick={onSidebar}
              />
            }
          >
            <PanelLeft />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Toggle sidebar <Kbd>⌘B</Kbd>
          </TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="mr-1 h-4 self-center" />
        <div className="flex items-center gap-2 font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
          {current?.icon}
          <span>{current?.label}</span>
        </div>
        <Slot name="topbar.start" />
      </div>
      <div className="flex items-center gap-2">
        <Slot name="topbar.end" />
        {production && <Badge variant="outline">Production</Badge>}
        <span
          role="status"
          className="mr-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <i
            className={cn(
              "size-1.5 rounded-full",
              connected ? "animate-pulse bg-positive" : "bg-destructive",
            )}
          />
          <span className="max-sm:hidden">
            {connected ? "Live" : "Reconnecting"}
          </span>
        </span>
        <Button
          variant="outline"
          className="gap-3 pr-1 pl-2"
          onClick={onSearch}
          aria-label="Search requests"
        >
          <Search />
          <Kbd className="max-sm:hidden">/</Kbd>
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="relative"
          aria-label="Open errors"
          onClick={() => {
            location.hash = routeHref("errors");
          }}
        >
          <Bell />
          {hasNewErrors && (
            <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-destructive" />
          )}
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={onTheme}
          aria-label={`Theme: ${theme}`}
          title={`Theme: ${theme}`}
        >
          {THEME_ICON[theme]}
        </Button>
        {canRestart && (
          <Button variant="outline" onClick={onRestart}>
            <RotateCw />
            Restart app
          </Button>
        )}
      </div>
    </header>
  );
}
