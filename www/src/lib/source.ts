import { loader } from "fumadocs-core/source";
import { docs } from "collections/server";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";
import { docsRoute } from "./shared";
import { site } from "./site";
import type { Node } from "fumadocs-core/page-tree";

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: docsRoute,
  plugins: [lucideIconsPlugin()],
});

export function markdownPathToSlugs(segs: string[]) {
  if (segs.length === 0) return [];

  const out = [...segs];
  out[out.length - 1] = out[out.length - 1].replace(/\.md$/, "");
  if (out.length === 1 && out[0] === "index") out.pop();
  return out;
}

export function slugsToMarkdownPath(slugs: string[]) {
  const segments = [...slugs];
  if (segments.length === 0) {
    segments.push("index.md");
  } else {
    segments[segments.length - 1] += ".md";
  }

  return {
    segments,
    url: `${docsRoute}/${segments.join("/")}`,
  };
}

export async function getLLMText(page: (typeof source)["$inferPage"]) {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title}

${page.data.description ?? ""}

Source: ${page.url}

${processed.trim()}\n`;
}

export function getDocsSections() {
  const pages = new Map(source.getPages().map((page) => [page.url, page]));
  const seen = new Set<string>();
  const sections: { title: string; pages: (typeof source)["$inferPage"][] }[] =
    [];
  function visit(nodes: Node[], title: string) {
    for (const node of nodes) {
      if (node.type === "folder") {
        visit(
          node.index ? [node.index, ...node.children] : node.children,
          String(node.name),
        );
      } else if (node.type === "page" && !seen.has(node.url)) {
        const page = pages.get(node.url);
        if (page) {
          let section = sections.at(-1);
          if (!section || section.title !== title) {
            section = { title, pages: [] };
            sections.push(section);
          }
          section.pages.push(page);
          seen.add(node.url);
        }
      }
    }
  }
  visit(source.getPageTree().children, "Documentation");
  const unlisted = [...pages.values()].filter((page) => !seen.has(page.url));
  if (unlisted.length)
    sections.push({ title: "Additional documentation", pages: unlisted });
  return sections.filter((section) => section.pages.length > 0);
}

export function markdownResponse(
  markdown: string,
  negotiated = false,
  canonicalPath?: string,
) {
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      ...(negotiated ? { Vary: "Accept" } : {}),
      ...(canonicalPath
        ? {
            Link: `<${new URL(canonicalPath, site.url).href}>; rel="canonical"`,
          }
        : {}),
    },
  });
}
