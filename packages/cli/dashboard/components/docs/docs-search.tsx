import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { segmentsOf } from "@/components/docs/docs-tree";
import {
  docsHref,
  docsSearchUrl,
  type DocsSearchHit,
} from "../../../src/dashboard-protocol";

/** Search over the docs' titles, headings, and text. */
export function DocsSearch({ revision }: { revision: number }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<DocsSearchHit[]>([]);

  useEffect(() => {
    if (!query.trim()) {
      setHits([]);
      return;
    }
    const controller = new AbortController();
    // Wait for a pause in typing before asking.
    const timer = setTimeout(() => {
      fetch(docsSearchUrl(query), {
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : []))
        .then(
          (found: DocsSearchHit[]) => setHits(found.slice(0, 12)),
          () => {},
        );
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, revision]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
      <Input
        type="search"
        value={query}
        placeholder="Search docs"
        aria-label="Search docs"
        className="pl-8"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setQuery("");
        }}
      />
      {query.trim() && (
        <div
          role="listbox"
          aria-label="Search results"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-96 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {hits.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              No results
            </div>
          ) : (
            hits.map((hit) => {
              const [path, anchor] = hit.url.split("#");
              return (
                <a
                  key={hit.id}
                  role="option"
                  aria-selected={false}
                  href={docsHref(segmentsOf(path ?? ""), anchor)}
                  onClick={() => setQuery("")}
                  className="flex flex-col rounded-md px-2 py-1.5 text-sm outline-none hover:bg-muted focus-visible:bg-muted"
                >
                  <span
                    className={hit.type === "page" ? "font-medium" : "truncate"}
                  >
                    {hit.content}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {hit.type === "page"
                      ? "Page"
                      : hit.type === "heading"
                        ? "Heading"
                        : "Text"}
                    {" · "}
                    {hit.url}
                  </span>
                </a>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
