import {
  useCallback,
  useEffect,
  useReducer,
  useState,
  useSyncExternalStore,
} from "react";
import {
  LIVE_LIMITS,
  ROUTES,
  TELEMETRY_EVENTS,
  THEME_STORAGE_KEY,
  type DashboardEvents,
  type DashboardSnapshot,
  type DevTelemetryEvent,
  type ExtensionBuild,
} from "../src/dashboard-protocol";

export interface DashboardState extends DashboardSnapshot {
  connected: boolean;
  loaded: boolean;
}

/**
 * The page runs the extension it was served with. When the server has built
 * another since, the page reloads to run that one.
 */
function followExtension(build: ExtensionBuild | null) {
  const served = document
    .querySelector('meta[name="brick-extension"]')
    ?.getAttribute("data-revision");
  // A page served without an extension reloads when one appears (a plugin's).
  if (build && served !== String(build.revision)) location.reload();
}

type Action =
  | { type: "snapshot"; snapshot: DashboardSnapshot }
  | DevTelemetryEvent
  | { type: "connection"; connected: boolean };

export const initialState: DashboardState = {
  traces: [],
  failures: [],
  reloads: [],
  architecture: null,
  api: null,
  docs: null,
  inspector: false,
  canRestart: false,
  historyDays: 0,
  mode: "dev",
  extension: null,
  connected: false,
  loaded: false,
};

export function reduce(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case "snapshot":
      return { ...state, ...action.snapshot, loaded: true };
    case "trace": {
      const index = state.traces.findIndex(
        (trace) => trace.traceId === action.trace.traceId,
      );
      if (index >= 0) {
        const traces = state.traces.slice();
        traces[index] = action.trace;
        return { ...state, traces };
      }
      return {
        ...state,
        traces: [action.trace, ...state.traces].slice(0, LIVE_LIMITS.traces),
      };
    }
    case "failure":
      return {
        ...state,
        failures: [action.failure, ...state.failures].slice(
          0,
          LIVE_LIMITS.failures,
        ),
      };
    case "reload":
      return {
        ...state,
        reloads: [action.reload, ...state.reloads].slice(
          0,
          LIVE_LIMITS.reloads,
        ),
      };
    case "architecture":
      return { ...state, architecture: action.architecture };
    case "api":
      return { ...state, api: action.api };
    case "docs":
      return { ...state, docs: action.docs };
    case "inspector":
      return { ...state, inspector: action.inspector };
    case "connection":
      return { ...state, connected: action.connected };
  }
}

/** Subscribe to the dashboard's event stream; it reconnects on its own. */
export function useDashboard(): DashboardState {
  const [state, dispatch] = useReducer(reduce, initialState);
  useEffect(() => {
    const source = new EventSource(ROUTES.events.path);
    const listen = <K extends keyof DashboardEvents>(
      name: K,
      handle: (data: DashboardEvents[K]) => void,
    ) =>
      source.addEventListener(name, (event) =>
        handle(
          JSON.parse(
            (event as MessageEvent<string>).data,
          ) as DashboardEvents[K],
        ),
      );
    listen("snapshot", (snapshot) => {
      followExtension(snapshot.extension);
      dispatch({ type: "snapshot", snapshot });
    });
    listen("extension", followExtension);
    for (const name of TELEMETRY_EVENTS) listen(name, dispatch);
    source.onopen = () => dispatch({ type: "connection", connected: true });
    source.onerror = () => dispatch({ type: "connection", connected: false });
    return () => source.close();
  }, []);
  return state;
}

export type View =
  | "requests"
  | "logs"
  | "overview"
  | "apis"
  | "docs"
  | "workflows"
  | "errors"
  | "reloads"
  /** An extension's page, at `#/x/<id>/…`, so it never clashes with a built-in one. */
  | "x";
export interface Route {
  view: View;
  traceId?: string;
  /** Segments after the view, for views with pages of their own (APIs, Docs). For `x`, after the page's id. */
  path: string[];
  /** The `#heading` after a docs page's path. */
  anchor?: string;
  /** The extension page's id, for `x`. */
  page?: string;
}

const VIEWS: View[] = [
  "requests",
  "logs",
  "overview",
  "apis",
  "docs",
  "workflows",
  "errors",
  "reloads",
];

/** A path segment as written, when it is not valid percent-encoding. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseRoute(hash: string): Route {
  const body = hash.replace(/^#\/?/, "");
  // A second `#` names a heading inside a docs page: #/docs/guide/setup#install
  const anchorAt = body.indexOf("#");
  const location = anchorAt >= 0 ? body.slice(0, anchorAt) : body;
  const anchor = anchorAt >= 0 ? decode(body.slice(anchorAt + 1)) : undefined;
  const [view, ...rest] = location.split("/");
  const path = rest.filter(Boolean).map(decode);
  if (view === "x" && path[0])
    return {
      view: "x",
      page: path[0],
      path: path.slice(1),
      ...(anchor ? { anchor } : {}),
    };
  return {
    // History became part of Requests; old links still land there.
    view: VIEWS.includes(view as View) ? (view as View) : "requests",
    traceId: path[0],
    path,
    ...(anchor ? { anchor } : {}),
  };
}

export function routeHref(view: View, traceId?: string): string {
  return traceId ? `#/${view}/${encodeURIComponent(traceId)}` : `#/${view}`;
}

/** The address of a docs page, optionally at one of its headings. */
export function docsHref(path: string[], anchor?: string): string {
  const pages = path.map(encodeURIComponent).join("/");
  return `#/docs${pages ? `/${pages}` : ""}${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
}

/** The view and selected request, kept in the URL hash so links can be shared. */
export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  return route;
}

export type Theme = "light" | "dark" | "system";
const THEME_KEY = THEME_STORAGE_KEY;

function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function useTheme(): { theme: Theme; cycle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  });
  useEffect(() => {
    applyTheme(theme);
    if (theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => applyTheme("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [theme]);
  const cycle = useCallback(() => {
    setTheme((current) => {
      const next: Theme =
        current === "system" ? "dark" : current === "dark" ? "light" : "system";
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
      return next;
    });
  }, []);
  return { theme, cycle };
}

/** Current time, refreshed while `active` so running requests keep growing. */
export function useNow(active: boolean, intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    () => window.matchMedia(query).matches,
    () => true,
  );
}

const SIDEBAR_KEY = "brick-dashboard-sidebar";

export interface SidebarState {
  /** Wide screens keep the sidebar in the layout; narrow ones overlay it. */
  desktop: boolean;
  /** Whether labels are showing next to the icons. */
  expanded: boolean;
  /** Whether the sidebar is on screen at all. */
  visible: boolean;
  toggle: () => void;
  close: () => void;
}

/**
 * The sidebar is an icon rail that opens to show labels. The choice is saved
 * for wide screens; on narrow screens it opens as an overlay instead.
 */
export function useSidebar(): SidebarState {
  const desktop = useMediaQuery("(min-width: 768px)");
  const [expanded, setExpanded] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) === "expanded",
  );
  const [overlay, setOverlay] = useState(false);

  useEffect(() => {
    if (desktop) setOverlay(false);
  }, [desktop]);

  const toggle = useCallback(() => {
    if (!desktop) {
      setOverlay((open) => !open);
      return;
    }
    setExpanded((open) => {
      localStorage.setItem(SIDEBAR_KEY, open ? "collapsed" : "expanded");
      return !open;
    });
  }, [desktop]);

  return {
    desktop,
    expanded: desktop ? expanded : true,
    visible: desktop || overlay,
    toggle,
    close: useCallback(() => setOverlay(false), []),
  };
}
