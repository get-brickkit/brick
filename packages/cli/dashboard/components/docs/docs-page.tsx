import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type MouseEvent,
} from "react";
import { Callout } from "@fumadocs/base-ui/components/callout";
import { Empty } from "@/components/page-header";
import {
  useDocsPage,
  type ProjectComponents,
} from "@/components/docs/use-docs";
import {
  PageErrorBoundary,
  PageHeadings,
  mdxComponents,
  runMdx,
} from "@/components/docs/mdx-components";
import { cn } from "@/lib/utils";
import type { DocsHeading, DocsPage } from "../../../src/dashboard-protocol";

function scrollToHeading(id: string): void {
  document.getElementById(id)?.scrollIntoView({ block: "start" });
}

/**
 * Headings link to `#id`, but the dashboard's own address is the hash, so
 * those links scroll instead of navigating.
 */
export function onContentClick(event: MouseEvent): void {
  const link = (event.target as HTMLElement).closest("a");
  const href = link?.getAttribute("href");
  if (!href || !href.startsWith("#") || href.startsWith("#/")) return;
  event.preventDefault();
  let id = href.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {}
  scrollToHeading(id);
}

/** The heading nearest the top of the page, for marking the table of contents. */
function useActiveHeading(
  headings: DocsHeading[],
  page: unknown,
): string | undefined {
  const [active, setActive] = useState<string>();
  useEffect(() => {
    const ids = headings.map((heading) => heading.url.slice(1));
    const update = () => {
      let current = ids[0];
      for (const id of ids) {
        const element = document.getElementById(id);
        if (element && element.getBoundingClientRect().top <= 120) current = id;
      }
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [headings, page]);
  return active;
}

/** The page's headings, with the one being read marked. */
export function Toc({
  headings,
  page,
}: {
  headings: DocsHeading[];
  page: unknown;
}) {
  const active = useActiveHeading(headings, page);
  if (headings.length === 0) return null;
  return (
    <nav aria-label="On this page" className="flex flex-col gap-0.5 text-sm">
      <div className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        On this page
      </div>
      {headings.map((heading) => (
        <a
          key={heading.url}
          href={heading.url}
          onClick={onContentClick}
          aria-current={
            heading.url.slice(1) === active ? "location" : undefined
          }
          style={{
            paddingLeft: `${Math.max(heading.depth - 2, 0) * 12 + 8}px`,
          }}
          className={cn(
            "rounded-md py-1 pr-2 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=location]:font-medium aria-[current=location]:text-foreground",
          )}
        >
          {heading.title}
        </a>
      ))}
    </nav>
  );
}

function Content({
  page,
  project,
}: {
  page: DocsPage;
  project: ProjectComponents | undefined;
}) {
  const components = useMemo(
    () => mdxComponents(project?.components),
    [project],
  );
  const compiled = useMemo(() => {
    try {
      return {
        Page: runMdx(page.code) as ComponentType<{ components?: object }>,
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }, [page.code]);
  if ("error" in compiled)
    return (
      <Callout type="error" title="This page could not run">
        {compiled.error}
      </Callout>
    );
  const { Page } = compiled;
  return (
    <PageHeadings.Provider value={page.toc}>
      <PageErrorBoundary reset={[page.code, components]}>
        <Page components={components} />
      </PageErrorBoundary>
    </PageHeadings.Provider>
  );
}

/** One page of the docs: title, description, and its MDX. */
export function DocsPageView({
  page,
  project,
}: {
  page: DocsPage;
  project: ProjectComponents | undefined;
}) {
  return (
    <article onClick={onContentClick} className="min-w-0">
      <h1 className="text-3xl font-semibold tracking-tight">{page.title}</h1>
      {page.description && (
        <p className="mt-2 mb-8 text-base text-muted-foreground">
          {page.description}
        </p>
      )}
      {project?.error && (
        <Callout type="warn" title="Your components did not load">
          {project.error}
        </Callout>
      )}
      {page.error ? (
        <Callout type="error" title={`${page.path} does not compile`}>
          <pre className="font-mono text-xs whitespace-pre-wrap">
            {page.error}
          </pre>
        </Callout>
      ) : (
        <div className="prose max-w-none">
          <Content page={page} project={project} />
        </div>
      )}
    </article>
  );
}

/** Loads a page and shows it, or says why it cannot. */
export function DocsPageLoader({
  path,
  revision,
  project,
  onPage,
  onMissing,
}: {
  path: string[];
  revision: number;
  project: ProjectComponents | undefined;
  /** Called with each page once loaded, so the view can show its headings. */
  onPage: (page: DocsPage | undefined) => void;
  onMissing: () => void;
}) {
  const state = useDocsPage(path, revision);
  const page = state.status === "ready" ? state.page : undefined;
  useEffect(() => onPage(page), [page, onPage]);
  useEffect(() => {
    if (state.status === "missing") onMissing();
  }, [state.status, onMissing]);
  // A page may use the project's components, so wait until they are in.
  if (state.status === "loading" || (state.status === "ready" && !project))
    return <Empty title="Loading page" />;
  if (state.status === "missing")
    return (
      <Empty
        title="No such page"
        hint={`There is no page at /${path.join("/")}`}
      />
    );
  if (state.status === "failed")
    return (
      <Callout type="error" title="The page could not be loaded">
        {state.message}
      </Callout>
    );
  return <DocsPageView page={state.page} project={project} />;
}
