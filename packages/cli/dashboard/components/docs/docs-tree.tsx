import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { docsHref } from "@/state";
import type { DocsNode } from "../../../src/dashboard-protocol";

/** A tree route (`/guide/setup`) as the segments the dashboard's route uses. */
export function segmentsOf(url: string): string[] {
  return url.split("/").filter(Boolean);
}

const same = (a: string[], b: string[]) =>
  a.length === b.length && a.every((segment, index) => segment === b[index]);

const holds = (node: DocsNode, current: string[]): boolean =>
  node.type === "page"
    ? same(segmentsOf(node.url), current)
    : node.type === "folder"
      ? (node.index ? same(segmentsOf(node.index.url), current) : false) ||
        node.children.some((child) => holds(child, current))
      : false;

const link =
  "flex min-h-7 items-center rounded-md px-2 py-1 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground";

function Folder({
  node,
  current,
  depth,
}: {
  node: Extract<DocsNode, { type: "folder" }>;
  current: string[];
  depth: number;
}) {
  const containsCurrent = holds(node, current);
  // What the reader chose wins; until then a folder is open when it holds the page.
  const [chosen, setChosen] = useState<boolean>();
  const open = chosen ?? (containsCurrent || node.defaultOpen === true);
  return (
    <div>
      <div className="flex items-center">
        {node.index ? (
          <a
            href={docsHref(segmentsOf(node.index.url))}
            aria-current={
              same(segmentsOf(node.index.url), current) ? "page" : undefined
            }
            className={cn(link, "flex-1 font-medium text-foreground")}
          >
            {node.name}
          </a>
        ) : (
          <button
            type="button"
            onClick={() => setChosen(!open)}
            className={cn(
              link,
              "flex-1 cursor-pointer text-left font-medium text-foreground",
            )}
          >
            {node.name}
          </button>
        )}
        <button
          type="button"
          aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
          aria-expanded={open}
          onClick={() => setChosen(!open)}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
          />
        </button>
      </div>
      {open && (
        <div className="ml-2 border-l pl-1.5">
          <Nodes nodes={node.children} current={current} depth={depth + 1} />
        </div>
      )}
    </div>
  );
}

function Nodes({
  nodes,
  current,
  depth,
}: {
  nodes: DocsNode[];
  current: string[];
  depth: number;
}) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.type === "separator")
          return (
            <div
              key={`separator-${index}`}
              className="mt-4 mb-1 px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase first:mt-0"
            >
              {node.name}
            </div>
          );
        if (node.type === "folder")
          return (
            <Folder
              key={`folder-${node.name}-${index}`}
              node={node}
              current={current}
              depth={depth}
            />
          );
        return (
          <a
            key={node.url}
            href={docsHref(segmentsOf(node.url))}
            aria-current={
              same(segmentsOf(node.url), current) ? "page" : undefined
            }
            className={link}
          >
            {node.name}
          </a>
        );
      })}
    </>
  );
}

/** The docs' folders and pages, with the open page marked. */
export function DocsTree({
  nodes,
  current,
}: {
  nodes: DocsNode[];
  current: string[];
}) {
  return (
    <nav aria-label="Docs pages" className="flex flex-col gap-0.5">
      <Nodes nodes={nodes} current={current} depth={0} />
    </nav>
  );
}

/** The first page in reading order, for opening the docs when there is no index. */
export function firstPage(nodes: DocsNode[]): string[] | undefined {
  for (const node of nodes) {
    if (node.type === "page") return segmentsOf(node.url);
    if (node.type === "folder") {
      if (node.index) return segmentsOf(node.index.url);
      const inside = firstPage(node.children);
      if (inside) return inside;
    }
  }
  return undefined;
}
