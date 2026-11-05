import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { BUILT_IN_NAV, Sidebar, Topbar } from "@/shell";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  type View,
  routeHref,
  useDashboard,
  useMediaQuery,
  useRoute,
  useSidebar,
  useTheme,
} from "@/state";
import { Empty } from "@/components/page-header";
import {
  DashboardStateContext,
  ExtensionBoundary,
  ExtensionContext,
  ExtensionError,
  type LoadedExtension,
} from "@/extension";
import { mergeNav, routeKey, type SlotContext } from "@/extension-registry";
import { ExtensionPageView } from "@/views/extension-page";
import { LogsView } from "@/views/logs";
import { ApisView } from "@/views/apis";
import { ErrorsView } from "@/views/errors";
import { OverviewView } from "@/views/overview";
import { ReloadsView } from "@/views/reloads";
import { RequestsView } from "@/views/requests";
import { WorkflowsView } from "@/views/workflows";
import {
  CSRF_HEADER,
  CSRF_VALUE,
  PRODUCTION_HIDDEN_VIEWS,
  ROUTES,
} from "../src/dashboard-protocol";

// Fumadocs' components and Shiki's styles are only needed for the Docs tab.
const DocsView = lazy(() => import("@/views/docs"));

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

export function App({ loaded = {} }: { loaded?: LoadedExtension }) {
  const state = useDashboard();
  const route = useRoute();
  const { theme, cycle } = useTheme();
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const sidebar = useSidebar();
  const filterRef = useRef<HTMLInputElement>(null);
  const [seenFailure, setSeenFailure] = useState(0);
  // The API reference loads on first visit, then stays alive in the background.
  const production = state.mode === "production";
  // The views whose routes the monitoring dashboard does not serve are hidden there.
  const shown = useCallback(
    (view: View) => !(production && PRODUCTION_HIDDEN_VIEWS.has(view)),
    [production],
  );
  const [apisOpened, setApisOpened] = useState(route.view === "apis");
  // The inspector loads on first visit too, then keeps the run you were reading.
  const [workflowsOpened, setWorkflowsOpened] = useState(
    route.view === "workflows",
  );
  // The extension's pages and links join the sidebar; a mistake in them (a
  // duplicate id, say) drops the extension and says why.
  const { nav, extension, extensionError } = useMemo(() => {
    const visible = (items: typeof BUILT_IN_NAV) =>
      items.filter((item) => !item.view || shown(item.view));
    try {
      return {
        nav: visible(mergeNav(BUILT_IN_NAV, loaded.extension, production)),
        extension: loaded.extension,
        extensionError: loaded.error ?? state.extension?.error,
      };
    } catch (error) {
      return {
        nav: visible(BUILT_IN_NAV),
        extension: undefined,
        extensionError: error instanceof Error ? error.message : String(error),
      };
    }
  }, [loaded, production, shown, state.extension?.error]);
  const current = nav.find((item) => item.key === routeKey(route));
  const slotContext = useMemo<SlotContext>(
    () => ({
      route,
      theme: theme === "system" ? (systemDark ? "dark" : "light") : theme,
      production,
      ...(route.view === "requests" && route.traceId
        ? { selectedRequestId: route.traceId }
        : {}),
    }),
    [route, theme, systemDark, production],
  );
  const newest = state.failures[0]?.id ?? 0;
  const onErrors = route.view === "errors";
  // Changes whenever the app finishes a request, so stored views can catch up.
  const activity = `${state.traces.length}:${state.traces[0]?.traceId}:${state.traces[0]?.status}`;

  useEffect(() => {
    if (route.view === "apis" && shown("apis")) setApisOpened(true);
    if (route.view === "workflows" && shown("workflows"))
      setWorkflowsOpened(true);
  }, [route.view, shown]);

  // The monitoring dashboard has no APIs, Docs or Workflows; an old link lands on Requests.
  useEffect(() => {
    if (!shown(route.view)) location.replace(routeHref("requests"));
  }, [production, route.view, shown]);

  // The errors dot clears once the Errors view has shown the newest failure.
  useEffect(() => {
    if (onErrors) setSeenFailure(newest);
  }, [onErrors, newest]);
  const hasNewErrors = newest > seenFailure;
  // Shown for any app that runs workflows, so the view can say how to turn the inspector on.
  const hasWorkflows =
    state.inspector ||
    (state.architecture?.schema.events?.listeners.some(
      (listener) => listener.kind === "workflow",
    ) ??
      false);

  const focusSearch = useCallback(() => {
    if (route.view === "requests") {
      filterRef.current?.focus();
      return;
    }
    // The filter lives on the Requests view; focus it once that view mounts.
    location.hash = routeHref("requests");
    setTimeout(() => filterRef.current?.focus(), 0);
  }, [route.view]);

  const { toggle: toggleSidebar } = sidebar;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Cmd/Ctrl+B opens and closes the sidebar, as in shadcn's sidebar.
      if (event.key.toLowerCase() === "b" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        isTyping(event.target)
      )
        return;
      event.preventDefault();
      focusSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusSearch, toggleSidebar]);

  const restart = useCallback(() => {
    void fetch(ROUTES.restart.path, {
      method: "POST",
      headers: { [CSRF_HEADER]: CSRF_VALUE },
    });
  }, []);

  const page = route.view === "x" ? current?.page : undefined;
  const content = (
    <TooltipProvider>
      <div className="flex min-h-screen">
        <Sidebar
          nav={nav}
          current={current?.key}
          sidebar={sidebar}
          errorCount={state.failures.length}
          hasNewErrors={hasNewErrors}
          hasDocs={state.docs !== null}
          hasWorkflows={hasWorkflows}
          production={production}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            current={current}
            connected={state.connected}
            hasNewErrors={hasNewErrors}
            theme={theme}
            canRestart={state.canRestart}
            production={production}
            sidebarOpen={sidebar.visible && sidebar.expanded}
            onSidebar={sidebar.toggle}
            onSearch={focusSearch}
            onTheme={cycle}
            onRestart={restart}
          />
          <main
            className={cn(
              "flex flex-col gap-4",
              // The API reference, the docs and the inspector bring their own chrome and fill the page.
              route.view === "apis" ||
                route.view === "docs" ||
                route.view === "workflows" ||
                page?.url
                ? "p-0"
                : "p-6 max-sm:p-4",
            )}
          >
            {extensionError && (
              <ExtensionError name="loading" message={extensionError} />
            )}
            {route.view === "x" &&
              (page ? (
                <ExtensionPageView
                  key={page.id}
                  page={page}
                  context={slotContext}
                />
              ) : (
                <Empty
                  title={`No page named "${route.page ?? ""}"`}
                  hint="The dashboard extension does not have it, or it is not shown here."
                />
              ))}
            {route.view === "requests" && (
              <RequestsView
                traces={state.traces}
                historyDays={state.historyDays}
                selectedId={route.traceId}
                activity={activity}
                filterRef={filterRef}
              />
            )}
            {route.view === "overview" && (
              <OverviewView
                architecture={state.architecture}
                traces={state.traces}
              />
            )}
            {apisOpened && shown("apis") && (
              <ApisView
                api={state.api}
                route={route}
                traces={state.traces}
                failures={state.failures}
                hidden={route.view !== "apis"}
              />
            )}
            {workflowsOpened && shown("workflows") && (
              <WorkflowsView
                available={state.inspector}
                hidden={route.view !== "workflows"}
              />
            )}
            {route.view === "docs" && shown("docs") && (
              <Suspense fallback={<Empty title="Loading docs" />}>
                <DocsView docs={state.docs} route={route} />
              </Suspense>
            )}
            {route.view === "logs" && <LogsView traces={state.traces} />}
            {route.view === "errors" && (
              <ErrorsView
                failures={state.failures}
                traces={state.traces}
                canLookBack={state.historyDays > 0}
              />
            )}
            {route.view === "reloads" && (
              <ReloadsView reloads={state.reloads} />
            )}
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
  const Root = extension?.root;
  return (
    <DashboardStateContext.Provider value={state}>
      <ExtensionContext.Provider value={{ extension, context: slotContext }}>
        {Root ? (
          // A root that fails leaves the dashboard running without it.
          <ExtensionBoundary name="root" fallback={content}>
            <Root>{content}</Root>
          </ExtensionBoundary>
        ) : (
          content
        )}
      </ExtensionContext.Provider>
    </DashboardStateContext.Provider>
  );
}
