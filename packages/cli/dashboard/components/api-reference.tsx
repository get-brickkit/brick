import {
  Component,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { Search } from "lucide-react";
import { Callout } from "@fumadocs/base-ui/components/callout";
import { createOpenAPIPage } from "fumadocs-openapi/ui";
import { createCodeUsageGeneratorRegistry } from "fumadocs-openapi/requests/generators";
import { csharp } from "fumadocs-openapi/requests/generators/csharp";
import { curl } from "fumadocs-openapi/requests/generators/curl";
import { go } from "fumadocs-openapi/requests/generators/go";
import { java } from "fumadocs-openapi/requests/generators/java";
import { javascript } from "fumadocs-openapi/requests/generators/javascript";
import { python } from "fumadocs-openapi/requests/generators/python";
import { rust } from "fumadocs-openapi/requests/generators/rust";
import type { Document } from "fumadocs-openapi";
import {
  apiEntries,
  apiHref,
  filterGroups,
  selectOperation,
  type ApiEntry,
  type ApiMethod,
  type ApiSelection,
} from "@/api-operations";
import { TraceContext, TracedResult } from "@/components/api-trace";
import { Empty } from "@/components/page-header";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/state";
import type { ApiDocument } from "@brickkit/core";
import {
  ROUTES,
  type FailureSummary,
  type TraceSummary,
} from "../../src/dashboard-protocol";

// Examples are JavaScript fetch calls first, as the app's own client makes them.
const codeUsages = createCodeUsageGeneratorRegistry();
codeUsages.add("js", javascript);
codeUsages.add("curl", curl);
codeUsages.add("python", python);
codeUsages.add("go", go);
codeUsages.add("java", java);
codeUsages.add("csharp", csharp);
codeUsages.add("rust", rust);

const OpenAPIPage = createOpenAPIPage({
  codeUsages,
  storageKeyPrefix: "brick-dashboard-openapi-",
  // Each response shows the app's trace of that request below it.
  playground: { components: { ResultDisplay: TracedResult } },
});

// The app is another origin; the dashboard forwards Try it requests.
const PROXY_URL = ROUTES.proxy.path;

const METHOD_COLOR: Record<ApiMethod, string> = {
  get: "text-green-600 dark:text-green-400",
  post: "text-blue-600 dark:text-blue-400",
  put: "text-yellow-600 dark:text-yellow-400",
  patch: "text-orange-600 dark:text-orange-400",
  delete: "text-red-600 dark:text-red-400",
  head: "text-muted-foreground",
  options: "text-muted-foreground",
  trace: "text-muted-foreground",
};

const link =
  "flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground";

/** Shows what went wrong in an operation instead of blanking the whole view. */
class RenderBoundary extends Component<
  { reset: unknown; children: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("API operation failed to render", error, info.componentStack);
  }

  componentDidUpdate(previous: { reset: unknown }) {
    if (previous.reset !== this.props.reset && this.state.error)
      this.setState({ error: undefined });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Callout type="error" title="This operation failed to render">
        {error.message}
      </Callout>
    );
  }
}

function Sidebar({
  entries,
  selected,
}: {
  entries: ApiEntry[];
  selected: ApiSelection | undefined;
}) {
  const [query, setQuery] = useState("");
  const named = entries.length > 1;
  const shown = entries
    .map((entry) => ({ entry, groups: filterGroups(entry.groups, query) }))
    .filter(({ groups }) => groups.length > 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
        <Input
          type="search"
          value={query}
          placeholder="Filter operations"
          aria-label="Filter operations"
          className="pl-8"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
          }}
        />
      </div>
      <nav aria-label="API operations" className="flex flex-col gap-0.5">
        {shown.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-muted-foreground">
            No operations
          </div>
        )}
        {shown.map(({ entry, groups }) => (
          <div key={entry.slug} className="flex flex-col gap-0.5">
            {named && (
              <div className="mt-4 mb-1 px-2 text-sm font-semibold first:mt-0">
                {entry.title}
              </div>
            )}
            {groups.map((group) => (
              <div
                key={group.name}
                className="flex flex-col gap-0.5 not-first:mt-3"
              >
                {(group.name || groups.length > 1) && (
                  <div className="mb-1 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {group.name || "Other"}
                  </div>
                )}
                {group.operations.map((operation) => {
                  const current =
                    selected?.entry === entry &&
                    selected.operation.method === operation.method &&
                    selected.operation.path === operation.path;
                  return (
                    <a
                      key={`${operation.method} ${operation.path}`}
                      href={apiHref(
                        entry.slug,
                        operation.method,
                        operation.path,
                      )}
                      aria-current={current ? "page" : undefined}
                      title={`${operation.method.toUpperCase()} ${operation.path}`}
                      className={link}
                    >
                      <span
                        className={cn(
                          "w-10 shrink-0 font-mono text-[10px] font-semibold uppercase",
                          METHOD_COLOR[operation.method],
                        )}
                      >
                        {operation.method}
                      </span>
                      <span
                        className={cn(
                          "min-w-0 truncate",
                          operation.deprecated && "line-through",
                        )}
                      >
                        {operation.title}
                      </span>
                    </a>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </nav>
    </div>
  );
}

/**
 * The app's API reference by Fumadocs OpenAPI: the operations of each OpenAPI
 * document in a sidebar, and the open one beside it with its parameters,
 * responses, example requests, and Try it. It is loaded on demand, since
 * it is a large part of the dashboard's size. Colors come from the dashboard's
 * own styles (the Fumadocs tokens map to them in styles.css).
 */
export default function ApiReference({
  documents,
  appUrl,
  path,
  traces,
  failures,
}: {
  documents: ApiDocument[];
  appUrl: string | undefined;
  /** The address after `#/apis/`, which names the operation to open. */
  path: string[];
  /** What the app has recorded, for the trace under each Try it response. */
  traces: TraceSummary[];
  failures: FailureSummary[];
}) {
  const entries = useMemo(
    () => apiEntries(documents, appUrl),
    [documents, appUrl],
  );
  const selected = selectOperation(entries, path);
  const key = selected
    ? `${selected.entry.slug} ${selected.operation.method} ${selected.operation.path}`
    : "";
  const payload = useMemo(
    () => ({
      // Documents are the app's own, so they are already bundled.
      bundled: selected?.entry.document as unknown as Document,
      proxyUrl: PROXY_URL,
    }),
    [selected?.entry],
  );

  // Another operation starts at the top of the page.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [key]);

  // One sidebar: beside the operation on wide screens, in a fold above it on
  // narrow ones.
  const wide = useMediaQuery("(min-width: 1024px)");
  const sidebar = <Sidebar entries={entries} selected={selected} />;
  const recorded = useMemo(() => ({ traces, failures }), [traces, failures]);
  return (
    <TraceContext value={recorded}>
      <div className="flex min-h-[calc(100svh-3.5rem)]">
        {wide && (
          <aside className="sticky top-14 h-[calc(100svh-3.5rem)] w-72 shrink-0 overflow-y-auto border-r p-3">
            {sidebar}
          </aside>
        )}
        <div className="min-w-0 flex-1">
          {!wide && (
            <details className="border-b p-3">
              <summary className="cursor-pointer text-sm font-medium">
                Operations
              </summary>
              <div className="mt-3">{sidebar}</div>
            </details>
          )}
          {/*
           * `prose` is the typography Fumadocs' pages are written for. The
           * example column sticks below the dashboard's top bar.
           */}
          <div className="prose mx-auto max-w-[90rem] px-6 py-8 [--fd-docs-row-3:3.5rem] max-sm:px-4">
            {selected ? (
              <RenderBoundary reset={key}>
                <OpenAPIPage
                  key={key}
                  payload={payload}
                  operations={[
                    {
                      path: selected.operation.path,
                      method: selected.operation.method,
                    },
                  ]}
                  showTitle
                  showDescription
                />
              </RenderBoundary>
            ) : (
              <Empty
                title="No operations to show"
                hint="The API documents list no paths"
              />
            )}
          </div>
        </div>
      </div>
    </TraceContext>
  );
}
