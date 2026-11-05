import { useEffect, useState, type ComponentType } from "react";
import {
  docsPageUrl,
  DOCS_PATHS,
  type DocsInfo,
  type DocsPage,
} from "../../../src/dashboard-protocol";

async function getJson<T>(
  url: string,
  signal: AbortSignal,
): Promise<T | undefined> {
  const response = await fetch(url, { signal });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()) as T;
}

/** The sidebar tree, loaded again whenever the pages change. */
export function useDocsInfo(revision: number): DocsInfo | undefined {
  const [info, setInfo] = useState<DocsInfo>();
  useEffect(() => {
    const controller = new AbortController();
    getJson<DocsInfo>(DOCS_PATHS.info, controller.signal).then(
      (next) => next && setInfo(next),
      () => {},
    );
    return () => controller.abort();
  }, [revision]);
  return info;
}

export type PageState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "failed"; message: string }
  | { status: "ready"; page: DocsPage };

/** One compiled page, loaded again when it or its neighbors change. */
export function useDocsPage(path: string[], revision: number): PageState {
  const key = path.join("/");
  const [state, setState] = useState<{ key: string; value: PageState }>();
  useEffect(() => {
    const controller = new AbortController();
    const url = docsPageUrl(path);
    getJson<DocsPage>(url, controller.signal).then(
      (page) =>
        setState({
          key,
          value: page ? { status: "ready", page } : { status: "missing" },
        }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          key,
          value: {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      },
    );
    return () => controller.abort();
    // `path` is compared by `key`.
  }, [key, revision]);
  // Never show the last page's content while the next one loads.
  return state && state.key === key ? state.value : { status: "loading" };
}

export interface ProjectComponents {
  components: Record<string, ComponentType<never>>;
  error?: string;
}

/**
 * The project's own MDX components, bundled by the server. The bundle imports
 * React by name; the page's import map points those at the dashboard's copy.
 */
export function useProjectComponents(
  enabled: boolean,
  revision: number,
): ProjectComponents | undefined {
  const [loaded, setLoaded] = useState<{
    revision: number;
    value: ProjectComponents;
  }>();
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const url = `${DOCS_PATHS.components}?v=${revision}`;
    // The address carries the revision, so each edit loads a fresh module.
    import(/* @vite-ignore */ url).then(
      (module: { components?: unknown; default?: unknown }) => {
        const exported = module.components ?? module.default;
        if (current)
          setLoaded({
            revision,
            value: {
              components:
                exported && typeof exported === "object"
                  ? (exported as ProjectComponents["components"])
                  : {},
            },
          });
      },
      async (error: unknown) => {
        // The module failed to load; the server's message says why.
        const reason = await fetch(url)
          .then((response) => (response.ok ? undefined : response.text()))
          .catch(() => undefined);
        if (current)
          setLoaded({
            revision,
            value: {
              components: {},
              error:
                reason ??
                (error instanceof Error ? error.message : String(error)),
            },
          });
      },
    );
    return () => {
      current = false;
    };
  }, [enabled, revision]);
  if (!enabled) return { components: {} };
  return loaded && loaded.revision === revision ? loaded.value : undefined;
}
