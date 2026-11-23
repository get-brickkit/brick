import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import browserCollections from "collections/browser";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "@fumadocs/base-ui/layouts/spacious";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "@fumadocs/base-ui/layouts/spacious/page";
import { Suspense, useState } from "react";
import { StarIcon } from "lucide-react";

import { AISearch, AISearchPanel } from "@/components/ai/search";
import { EditOnGitHub } from "@/components/edit-on-github";
import { InstallCommand } from "@/components/install-command";
import { Wordmark } from "@/components/logo";
import { useMDXComponents } from "@/components/mdx";
import { baseOptions } from "@/lib/layout.shared";
import { gitConfig, repoUrl } from "@/lib/shared";
import { canonicalRedirect } from "@/lib/redirects";
import { slugsToMarkdownPath, source } from "@/lib/source";
import { socialMeta } from "@/lib/social";

export const Route = createFileRoute("/docs/$")({
  beforeLoad: ({ location }) => {
    const target = canonicalRedirect(location.pathname);
    if (target) throw redirect({ href: target, statusCode: 308 });
  },
  component: Page,
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/") ?? [];
    const data = await serverLoader({ data: slugs });
    await clientLoader.preload(data.path);
    return data;
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? socialMeta({
          title: `${loaderData.title} · Brick docs`,
          description: loaderData.description,
          path: loaderData.url,
        })
      : [],
  }),
});

const serverLoader = createServerFn({
  method: "GET",
})
  .validator((slugs: string[]) => slugs)
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs);
    if (!page) throw notFound();

    return {
      title: page.data.title,
      description: page.data.description ?? "",
      url: page.url,
      markdownUrl: slugsToMarkdownPath(page.slugs).url,
      pageTree: await source.serializePageTree(source.getPageTree()),
      path: page.path,
      lastModified: page.data.lastModified?.toISOString(),
    };
  });

const lastUpdatedFormat = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function TocFooter({
  path,
  lastModified,
}: {
  path: string;
  lastModified?: string;
}) {
  return (
    <div className="mt-4 shrink-0 border-t border-border pt-4 text-xs text-muted-foreground">
      {path.startsWith("api-reference/") ? (
        // Built from the JSDoc in the source; there is no file here to edit.
        <p>
          Generated from the JSDoc above each export. Edit the comment there.
        </p>
      ) : (
        <EditOnGitHub path={`www/content/docs/${path}`} />
      )}
      {lastModified ? (
        <p className="mt-2">
          Last updated{" "}
          <time dateTime={lastModified}>
            {lastUpdatedFormat.format(new Date(lastModified))}
          </time>
        </p>
      ) : null}
    </div>
  );
}

const clientLoader = browserCollections.docs.createClientLoader({
  component(
    { toc, frontmatter, default: MDX },
    // you can define props for the component
    {
      markdownUrl,
      path,
      lastModified,
    }: {
      markdownUrl: string;
      path: string;
      lastModified?: string;
    },
  ) {
    const tocFooter = <TocFooter path={path} lastModified={lastModified} />;
    return (
      <DocsPage
        toc={toc}
        tableOfContent={{
          //   style: "clerk",
          footer: tocFooter,
        }}
        tableOfContentPopover={{ footer: tocFooter }}
      >
        <DocsTitle className="docs-title">{frontmatter.title}</DocsTitle>
        <DocsDescription className="docs-description">
          {frontmatter.description}
        </DocsDescription>
        {markdownUrl === "/docs/quickstart.md" && (
          <div className="mb-6 flex flex-wrap items-center gap-3">
            <InstallCommand command="bun add @brickkit/core @brickkit/crud @brickkit/cli" />
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
              data-umami-event="github-click"
              data-umami-event-location="quickstart"
              className="inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm transition-colors hover:border-foreground/25"
            >
              <StarIcon aria-hidden="true" className="size-4" />
              Star on GitHub
            </a>
          </div>
        )}
        <div className="-mt-4 flex flex-row items-center gap-2 border-b pb-6">
          <MarkdownCopyButton
            markdownUrl={markdownUrl}
            data-umami-event="docs-copy-markdown"
          />
          <ViewOptionsPopover
            markdownUrl={markdownUrl}
            githubUrl={`${repoUrl}/blob/${gitConfig.branch}/www/content/docs/${path}`}
          />
          <a
            href="/llms.txt"
            className="text-xs text-fd-muted-foreground hover:text-fd-foreground"
          >
            llms.txt
          </a>
        </div>
        <DocsBody>
          <MDX components={useMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

function Page() {
  const { path, pageTree, markdownUrl, lastModified } = useFumadocsLoader(
    Route.useLoaderData(),
  );
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <AISearch open={chatOpen} onOpenChange={setChatOpen}>
      <DocsLayout
        {...baseOptions()}
        nav={{ title: <Wordmark />, url: "/" }}
        themeSwitch={{ enabled: false }}
        searchToggle={{
          sm: { "data-umami-event": "search-open" } as never,
          full: { "data-umami-event": "search-open" } as never,
        }}
        tree={pageTree}
        aiChat={{
          open: chatOpen,
          onOpenChange: setChatOpen,
          panel: <AISearchPanel />,
        }}
      >
        <Suspense>
          {clientLoader.useContent(path, { markdownUrl, path, lastModified })}
        </Suspense>
      </DocsLayout>
    </AISearch>
  );
}
