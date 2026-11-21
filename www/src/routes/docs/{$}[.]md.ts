import { createFileRoute, notFound } from "@tanstack/react-router";
import {
  getLLMText,
  markdownPathToSlugs,
  markdownResponse,
  source,
} from "@/lib/source";
import { canonicalRedirect } from "@/lib/redirects";

export const Route = createFileRoute("/docs/{$}.md")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const target = canonicalRedirect(new URL(request.url).pathname);
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
