import { createFileRoute, notFound } from "@tanstack/react-router";
import {
  getLLMText,
  markdownPathToSlugs,
  markdownResponse,
  source,
} from "@/lib/source";
import { redirectFor } from "@/lib/redirects";

export const Route = createFileRoute("/docs/{$}.md")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const target = redirectFor(`/docs/${params._splat ?? ""}`);
        if (target) {
          return new Response(null, {
            status: 308,
            headers: { Location: target },
          });
        }
        const slugs = markdownPathToSlugs(params._splat?.split("/") ?? []);
        const page = source.getPage(slugs);
        if (!page) throw notFound();

        return markdownResponse(await getLLMText(page), false, page.url);
      },
    },
  },
});
