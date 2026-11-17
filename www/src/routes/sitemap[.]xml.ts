import { createFileRoute } from "@tanstack/react-router";
import { blogSource } from "@/lib/blog";
import { getExamples } from "@/lib/examples";
import { site } from "@/lib/site";
import { redirects } from "@/lib/redirects";
import { marketingPages } from "@/lib/social";
import { source } from "@/lib/source";

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET() {
        const paths = new Set([
          ...Object.keys(marketingPages),
          ...source.getPages().map((page) => page.url),
          ...blogSource.getPages().map((page) => page.url),
          ...getExamples().map((example) => `/examples/${example.slug}`),
        ]);
        // Only final URLs: never a path that redirects.
        const urls = [...paths]
          .filter((path) => !(path in redirects))
          .sort()
          .map((path) => {
            const url = new URL(path, site.url).href.replaceAll("&", "&amp;");
            return `  <url><loc>${url}</loc></url>`;
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
