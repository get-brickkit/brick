import { createFileRoute } from "@tanstack/react-router";
import { blogSource } from "@/lib/blog";
import { getExamples } from "@/lib/examples";
import { site } from "@/lib/site";
import { redirectFor } from "@/lib/redirects";
import { marketingPages } from "@/lib/social";
import { source } from "@/lib/source";

function lastmod(value: Date | string | undefined): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
    return value;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET() {
        const entries = new Map<string, string | undefined>();
        const add = (path: string, modified?: string) => {
          const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
          if (redirectFor(normalized)) return;
          const current = entries.get(normalized);
          if (!entries.has(normalized)) entries.set(normalized, modified);
          else if (!current && modified) entries.set(normalized, modified);
        };
        for (const path of Object.keys(marketingPages)) add(path);
        for (const page of source.getPages())
          add(page.url, lastmod(page.data.lastModified));
        for (const page of blogSource.getPages())
          add(
            page.url,
            lastmod(page.data.lastModified) ?? lastmod(page.data.date),
          );
        for (const example of getExamples()) add(`/examples/${example.slug}`);
        const urls = [...entries]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, modified]) => {
            const url = new URL(path, site.url).href.replaceAll("&", "&amp;");
            const stamp = modified ? `<lastmod>${modified}</lastmod>` : "";
            return `  <url><loc>${url}</loc>${stamp}</url>`;
          });
        return new Response(
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
            ...urls,
            "</urlset>",
          ].join("\n"),
          { headers: { "Content-Type": "application/xml; charset=utf-8" } },
        );
      },
    },
  },
});
