import { useCallback, useEffect, useMemo, useState } from "react";
import { Empty } from "@/components/page-header";
import { DocsPageLoader, Toc } from "@/components/docs/docs-page";
import { DocsSearch } from "@/components/docs/docs-search";
import { DocsTree, firstPage } from "@/components/docs/docs-tree";
import { useDocsInfo, useProjectComponents } from "@/components/docs/use-docs";
import { docsHref, useMediaQuery, type Route } from "@/state";
import type { DocsPage } from "../../src/dashboard-protocol";
import type { DocsSnapshot } from "../../src/dashboard-protocol";

/**
 * The app's developer documentation: its folder of pages in the dashboard,
 * with Fumadocs' page tree, search, and components. Loaded on first use.
 */
export default function DocsView({
  docs,
  route,
}: {
  docs: DocsSnapshot | null;
  route: Route;
}) {
  if (!docs)
    return (
      <Empty
        title="No documentation"
        hint="Set documentation: './docs' in brick() to show a folder of pages here"
      />
    );
  if (docs.status === "missing")
    return (
      <Empty
        title="The docs need two packages"
        hint={`Install them with: bun add -d ${docs.packages?.join(" ") ?? "fumadocs-core @mdx-js/mdx"}`}
      />
    );
  if (docs.status === "error")
    return <Empty title="The docs cannot be shown" hint={docs.message} />;
  return <Ready docs={docs} route={route} />;
}

function Ready({ docs, route }: { docs: DocsSnapshot; route: Route }) {
  const info = useDocsInfo(docs.revision);
  const project = useProjectComponents(docs.components, docs.revision);
  const [page, setPage] = useState<DocsPage>();
  const toc = useMemo(() => page?.toc ?? [], [page]);
  const { path, anchor } = route;

  // Open the first page when the docs have no index page of their own.
  const openFirst = useCallback(() => {
    if (path.length > 0 || !info) return;
    const first = firstPage(info.tree.children);
    if (first) location.replace(docsHref(first));
  }, [path.length, info]);

  // A new page starts at the top, or at the heading named in the address. Images
  // above the heading change the layout as they load, so the scroll is repeated
  // for a moment, until the reader scrolls on their own.
  useEffect(() => {
    if (!page) return;
    const reveal = () => {
      const target = anchor ? document.getElementById(anchor) : undefined;
      if (target) target.scrollIntoView({ block: "start" });
      else window.scrollTo(0, 0);
    };
    reveal();
    if (!anchor) return;
    const stop = () => {
      document.removeEventListener("load", reveal, true);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchstart", stop);
      window.removeEventListener("keydown", stop);
      clearTimeout(timer);
    };
    const timer = setTimeout(stop, 2000);
    document.addEventListener("load", reveal, true);
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchstart", stop, { passive: true });
    window.addEventListener("keydown", stop);
    return stop;
  }, [page?.path, anchor]);

  // One sidebar, so one search box: beside the page on wide screens, in a fold
  // above it on narrow ones.
  const wide = useMediaQuery("(min-width: 1024px)");
  const name = info?.tree.name ?? docs.title;
  const sidebar = (
    <>
      <DocsSearch revision={docs.revision} />
      {info && <DocsTree nodes={info.tree.children} current={path} />}
    </>
  );
  return (
    <div className="flex min-h-[calc(100svh-3.5rem)]">
      {wide && (
        <aside className="sticky top-14 flex h-[calc(100svh-3.5rem)] w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r p-3">
          <div className="px-1 pt-1 text-sm font-semibold">{name}</div>
          {sidebar}
        </aside>
      )}
      <div className="min-w-0 flex-1">
        {!wide && (
          <details className="border-b p-3">
            <summary className="cursor-pointer text-sm font-medium">
              {name}: pages and search
            </summary>
            <div className="mt-3 flex flex-col gap-3">{sidebar}</div>
          </details>
        )}
        <div className="mx-auto max-w-3xl px-6 py-10 max-sm:px-4">
          <DocsPageLoader
            path={path}
            revision={docs.revision}
            project={project}
            onPage={setPage}
            onMissing={openFirst}
          />
        </div>
      </div>
      <aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] w-56 shrink-0 overflow-y-auto p-4 pt-10 xl:block">
        <Toc headings={toc} page={page?.path} />
      </aside>
    </div>
  );
}
