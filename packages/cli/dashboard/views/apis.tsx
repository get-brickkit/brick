import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Empty } from "@/components/page-header";
import { cn } from "@/lib/utils";
import type { Route } from "@/state";
import type { ApiDocument } from "@brickkit/core";
import {
  ROUTES,
  type ApiSnapshot,
  type FailureSummary,
  type TraceSummary,
} from "../../src/dashboard-protocol";

// The reference is most of the dashboard's size, so it loads when this view first opens.
const ApiReference = lazy(() => import("@/components/api-reference"));

/** The app's OpenAPI documents, loaded again each time the app starts. */
function useApiDocuments(revision: number | undefined): ApiDocument[] {
  const [documents, setDocuments] = useState<ApiDocument[]>([]);
  useEffect(() => {
    if (revision === undefined) return;
    const controller = new AbortController();
    fetch(ROUTES.openapi.path, { signal: controller.signal })
      .then((response) => response.json() as Promise<ApiDocument[]>)
      .then(setDocuments, () => {});
    return () => controller.abort();
  }, [revision]);
  return documents;
}

/**
 * The reference scrolls with the page, so the place in it is kept here: the
 * other views are shorter and the browser would move the page back to the top.
 */
function useKeptScroll(hidden: boolean): void {
  const kept = useRef(0);
  // Layout effects, so the listener is gone before the page shrinks.
  useLayoutEffect(() => {
    if (hidden) return;
    window.scrollTo(0, kept.current);
    const onScroll = () => {
      kept.current = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [hidden]);
}

/**
 * The app's API reference. It stays mounted once opened (`hidden` only hides
 * it), so it keeps its place and what was typed into Try it while other views
 * are open.
 */
export function ApisView({
  api,
  route,
  traces,
  failures,
  hidden,
}: {
  api: ApiSnapshot | null;
  route: Route;
  traces: TraceSummary[];
  failures: FailureSummary[];
  hidden: boolean;
}) {
  const documents = useApiDocuments(api?.revision);
  useKeptScroll(hidden);
  // Try it opens a dialog outside this view, which must not stay over the
  // others: Escape closes it. What was typed into it is kept for the return.
  useEffect(() => {
    if (hidden)
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
  }, [hidden]);
  // While another view is open the route is not ours, and the APIs link names
  // no operation: either way the one that was open stays.
  const shown = useRef(route.path);
  if (!hidden && route.path.length > 0) shown.current = route.path;
  return (
    <div className={cn("min-h-[calc(100svh-3.5rem)]", hidden && "hidden")}>
      {api && api.titles.length === 0 ? (
        <Empty
          title="No API documents to show"
          hint="The app serves none: docs is false, and reference.documents is empty"
        />
      ) : documents.length === 0 ? (
        <Empty
          title={api ? "Loading API documents" : "Waiting for the app to start"}
        />
      ) : (
        <Suspense fallback={<Empty title="Loading API reference" />}>
          <ApiReference
            documents={documents}
            appUrl={api?.appUrl}
            path={shown.current}
            traces={traces}
            failures={failures}
          />
        </Suspense>
      )}
    </div>
  );
}
