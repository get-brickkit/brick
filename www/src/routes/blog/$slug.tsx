import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import browserCollections from "collections/browser";
import { ArrowLeftIcon } from "lucide-react";
import { Suspense } from "react";
import { BlogMeta } from "@/components/blog-meta";
import { EditOnGitHub } from "@/components/edit-on-github";
import { getMDXComponents } from "@/components/mdx";
import { blogSource } from "@/lib/blog";
import { site } from "@/lib/site";
import { socialMeta } from "@/lib/social";

const loadPost = createServerFn({ method: "GET" })
  .validator((slug: string) => slug)
  .handler(({ data: slug }) => {
    const page = blogSource.getPage([slug]);
    if (!page) throw notFound();
    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      date: page.data.date,
      author: page.data.author,
    };
  });

const clientLoader = browserCollections.blog.createClientLoader({
  component({ default: MDX, frontmatter }, { path }: { path: string }) {
    return (
      <article className="mx-auto max-w-3xl">
        <header className="mb-10 border-b border-border pb-10">
          <BlogMeta {...frontmatter} />
          <h1 className="mt-6 text-4xl font-medium tracking-tight sm:text-6xl">
            {frontmatter.title}
          </h1>
          <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
            {frontmatter.description}
          </p>
          <p className="mt-5 text-sm text-muted-foreground">
            By {frontmatter.author}
          </p>
        </header>
        <div className="prose min-w-0">
          <MDX components={getMDXComponents()} />
        </div>
        <footer className="mt-12 border-t border-border pt-6 text-xs">
          <EditOnGitHub path={`www/content/blog/${path}`} />
        </footer>
      </article>
    );
  },
});

export const Route = createFileRoute("/blog/$slug")({
  loader: async ({ params }) => {
    const post = await loadPost({ data: params.slug });
    await clientLoader.preload(post.path);
    return post;
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? socialMeta({
          title: `${loaderData.title} · Brick blog`,
          description: loaderData.description,
          path: loaderData.url,
          type: "article",
        })
      : [],
    scripts: loaderData
      ? [
          {
            type: "application/ld+json",
            children: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "BlogPosting",
              headline: loaderData.title,
              description: loaderData.description,
              datePublished: loaderData.date,
              author: { "@type": "Organization", name: loaderData.author },
              url: new URL(loaderData.url, site.url).href,
              image: new URL(`/og${loaderData.url}.png`, site.url).href,
            }),
          },
        ]
      : [],
  }),
  component: Post,
});

function Post() {
  const { path } = Route.useLoaderData();
  return (
    <main className="py-10 sm:py-16">
      <Link
        to="/blog"
        className="mb-10 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon className="size-4" />
        All posts
      </Link>
      <Suspense fallback={<p>Loading article…</p>}>
        {clientLoader.useContent(path, { path })}
      </Suspense>
    </main>
  );
}
