import {
  Component,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import type { ArchitectureSchema } from "@brickkit/core";
import {
  createBrickClient,
  type BrickClient,
  type BrickClientOptions,
} from "@brickkit/core/client";
import {
  ROUTES,
  SHELL,
  type ExtensionPart,
  type TraceSummary,
} from "../src/dashboard-protocol";
import {
  mergeExtensions,
  type DashboardExtension,
  type DashboardSlots,
  type SlotContext,
} from "@/extension-registry";
import { initialState, type DashboardState } from "@/state";

/*
 * The extension at run time: the module the page loads, the error boundaries
 * every piece of it sits behind, its slots, and the data hooks it reads the
 * dashboard and the app with.
 */

export interface LoadedExtension {
  extension?: DashboardExtension;
  /** Why it could not be loaded or registered. */
  error?: string;
}

/**
 * Import the module the page names (see the shell's `brick-extension` meta).
 * React and the UI kit it imports are the dashboard's own, by the import map.
 * With plugins it lists several parts instead, which are loaded and merged.
 */
export async function loadExtension(): Promise<LoadedExtension> {
  const src = document
    .querySelector(SHELL.extensionMeta)
    ?.getAttribute("data-src");
  if (!src) return {};
  try {
    const url = new URL(src, location.href).href;
    const module = (await import(/* @vite-ignore */ url)) as {
      default?: unknown;
      parts?: ExtensionPart[];
    };
    if (Array.isArray(module.parts))
      return { extension: await loadParts(module.parts, url) };
    if (!module.default || typeof module.default !== "object")
      throw new Error(
        "The module must default-export defineDashboard({ ... }).",
      );
    return { extension: module.default as DashboardExtension };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Import each part apart, so one that throws leaves the others, and merge
 * them; their roots nest in order.
 */
export async function loadParts(
  parts: readonly ExtensionPart[],
  base: string,
): Promise<DashboardExtension> {
  const loaded = await Promise.allSettled(
    parts.map(
      (part) =>
        import(/* @vite-ignore */ new URL(part.src, base).href) as Promise<{
          default?: unknown;
        }>,
    ),
  );
  const extensions = parts.flatMap((part, index) => {
    const result = loaded[index]!;
    const extension =
      result.status === "fulfilled" ? result.value.default : undefined;
    if (extension && typeof extension === "object")
      return [{ ...part, extension: extension as DashboardExtension }];
    console.error(
      `[Brick dashboard] Extension ${part.name} failed to load:`,
      result.status === "rejected"
        ? result.reason
        : "it must default-export defineDashboard({ ... })",
    );
    return [];
  });
  const merged = mergeExtensions(extensions);
  const roots = extensions.flatMap(({ extension }) =>
    extension.root ? [extension.root] : [],
  );
  if (roots.length)
    merged.root = ({ children }) =>
      roots.reduceRight<ReactNode>(
        (inner, Root) => createElement(Root, null, inner),
        children,
      );
  return merged;
}

export const ExtensionContext = createContext<{
  extension?: DashboardExtension;
  context: SlotContext;
}>({
  context: {
    route: { view: "requests", path: [] },
    theme: "light",
    production: false,
  },
});

/** The dashboard's live state, for the data hooks. */
export const DashboardStateContext =
  createContext<DashboardState>(initialState);

/** An extension's failure, shown where the failing piece would be. */
export function ExtensionError({
  name,
  message,
}: {
  name: string;
  message: string;
}) {
  return (
    <div
      role="alert"
      className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs"
    >
      <div className="font-medium text-destructive">
        Dashboard extension: {name} failed
      </div>
      <pre className="mt-1 font-mono [overflow-wrap:anywhere] whitespace-pre-wrap text-muted-foreground">
        {message}
      </pre>
    </div>
  );
}

/** Keeps a broken page, slot or root from taking the dashboard down with it. */
export class ExtensionBoundary extends Component<
  { name: string; children: ReactNode; fallback?: ReactNode },
  { error?: Error }
> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(`[Brick dashboard] Extension ${this.props.name}:`, error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <>
        <ExtensionError
          name={this.props.name}
          message={this.state.error.message}
        />
        {this.props.fallback}
      </>
    );
  }
}

type ComponentSlot = Exclude<keyof DashboardSlots, "request.drawer.tabs">;

/**
 * Whatever the extension put in `name`, with the context the slot gives (the
 * sidebar's slots also get `expanded`).
 */
export function Slot({
  name,
  expanded,
}: {
  name: ComponentSlot;
  expanded?: boolean;
}) {
  const { extension, context } = useContext(ExtensionContext);
  const Filled = extension?.slots?.[name] as
    | ComponentType<SlotContext & { expanded?: boolean }>
    | undefined;
  if (!Filled) return null;
  return (
    <ExtensionBoundary name={`slot ${name}`}>
      <Filled {...context} {...(expanded === undefined ? {} : { expanded })} />
    </ExtensionBoundary>
  );
}

/** The requests the dashboard holds live, newest first. */
export function useRequests(): TraceSummary[] {
  return useContext(DashboardStateContext).traces;
}

/** The app's services, actions and routes as last started; null before it starts. */
export function useArchitecture(): ArchitectureSchema | null {
  return useContext(DashboardStateContext).architecture?.schema ?? null;
}

/**
 * Call the app through the dashboard's `/app` proxy, from the dashboard's own
 * origin. `path` is the app's: `appFetch("/api/admin/queues")`.
 */
export function appFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(
    `${ROUTES.app.path}${path.startsWith("/") ? path : `/${path}`}`,
    init,
  );
}

export interface AppFetchResult<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** Fetch again. */
  refetch: () => void;
}

/**
 * The app's typed client, calling it through the dashboard's `/app` proxy:
 * `createAppClient<AppContract>({ contract })`, with both from the contract
 * `brick dev` generates. CRUD and other plugin routes need the `contract`
 * value. Headers, the prefix and timeouts are as for `createBrickClient`.
 */
export function createAppClient<TApp extends Record<string, any>>(
  options: Omit<BrickClientOptions, "baseUrl"> & { contract?: TApp } = {},
): BrickClient<TApp> {
  return createBrickClient<TApp>({
    ...options,
    baseUrl: `${location.origin}${ROUTES.app.path}`,
  });
}

/**
 * Run `query` when the component mounts and whenever `deps` change, as
 * `useEffect` would: `useAppQuery((signal) => api.orders.order.list({}, { signal }), [])`.
 * A `null` query waits. The signal aborts when deps change or on unmount.
 */
export function useAppQuery<T>(
  query: ((signal: AbortSignal) => Promise<T>) | null,
  deps: readonly unknown[],
): AppFetchResult<T> {
  const [result, setResult] = useState<
    Omit<AppFetchResult<T>, "refetch" | "loading">
  >({ data: undefined, error: undefined });
  const [loading, setLoading] = useState(query !== null);
  const [attempt, setAttempt] = useState(0);
  const waiting = query === null;
  useEffect(() => {
    if (!query) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    query(abort.signal)
      .then((data) => {
        // A run whose deps changed must not overwrite the newer one's data.
        if (!abort.signal.aborted) setResult({ data, error: undefined });
      })
      .catch((error: unknown) => {
        if (abort.signal.aborted) return;
        setResult((current) => ({
          data: current.data,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
    // The query is read fresh on each run; deps decide when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, attempt, ...deps]);
  const refetch = useCallback(() => setAttempt((count) => count + 1), []);
  return { ...result, loading, refetch };
}

/**
 * Read `path` from the app (JSON, or text for anything else) when the
 * component mounts and whenever `path` changes. A `null` path waits.
 */
export function useAppFetch<T = unknown>(
  path: string | null,
  init?: RequestInit,
): AppFetchResult<T> {
  const options = JSON.stringify(init ?? {});
  return useAppQuery<T>(
    path === null
      ? null
      : async (signal) => {
          const response = await appFetch(path, {
            ...(JSON.parse(options) as RequestInit),
            signal,
          });
          const body = response.headers.get("content-type")?.includes("json")
            ? await response.json()
            : await response.text();
          if (!response.ok)
            throw new Error(
              `${response.status} ${typeof body === "string" ? body : JSON.stringify(body)}`,
            );
          return body as T;
        },
    [path, options],
  );
}
