import { socialMeta } from "@/lib/social";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { ArrowLeftIcon, ArrowUpRightIcon } from "lucide-react";
import { DatabaseTable } from "@/components/examples/database-table";
import { RoutesTable } from "@/components/examples/routes-table";
import { ServiceGraph } from "@/components/examples/service-graph";
import { SourceBrowser } from "@/components/examples/source-browser";
import { InstallCommand } from "@/components/install-command";
import {
  exampleCloneCommand,
  exampleGitHubUrl,
  exampleStats,
  getExample,
} from "@/lib/examples";

export const Route = createFileRoute("/examples/$slug")({
  loader: ({ params }) => {
    const example = getExample(params.slug);
    if (!example) throw notFound();
    return example;
  },
  head: ({ loaderData }) => ({
    meta: loaderData
      ? socialMeta({
          title: `${loaderData.title}: Brick example app`,
          description: loaderData.description,
          path: `/examples/${loaderData.slug}`,
        })
      : [],
  }),
  component: ExampleDetail,
});

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28 border-t pt-10">
      <h2 className="mb-6 text-2xl font-medium tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function ExampleDetail() {
  const example = Route.useLoaderData();
  const { services } = example.architecture;
  const stats = exampleStats(example);
  const tables = services.flatMap((service) =>
    service.tables.map((table) => ({ service: service.name, table })),
  );

  return (
    <main className="space-y-12 py-14 sm:py-20">
      <header className="max-w-3xl">
        <Link
          to="/examples"
          className="mb-8 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" /> All examples
        </Link>
        <h1 className="text-4xl font-medium tracking-tight sm:text-6xl">
          {example.title}
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-muted-foreground">
          {example.description}
        </p>
        <ul className="mt-6 flex flex-wrap gap-2">
          {example.tags.map((tag) => (
            <li key={tag} className="border border-border px-2 py-1 text-xs">
              {tag}
            </li>
          ))}
        </ul>
        <p className="mt-5 text-xs text-muted-foreground">
          {stats.services} services, {stats.actions} actions, {stats.tables}{" "}
          tables, {example.fileCount} files
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <InstallCommand command={exampleCloneCommand(example.slug)} />
          {example.demo && (
            <a
              href={example.demo}
              target="_blank"
              rel="noreferrer"
              className="home-button home-button-primary h-11"
            >
              Live demo <ArrowUpRightIcon className="size-4" />
            </a>
          )}
          <a
            href={exampleGitHubUrl(example.slug)}
            target="_blank"
            rel="noreferrer"
            data-umami-event="github-click"
            data-umami-event-location="example-detail"
            data-umami-event-slug={example.slug}
            className="inline-flex h-11 items-center gap-2 rounded-lg border px-4 text-sm transition-colors hover:border-foreground/25"
          >
            Open in GitHub <ArrowUpRightIcon className="size-4" />
          </a>
        </div>
      </header>

      {example.features.length > 0 && (
        <Section id="features" title="Features">
          <ul className="grid gap-3 sm:grid-cols-2">
            {example.features.map((feature) => (
              <li
                key={feature}
                className="rounded-lg border bg-card p-4 text-sm"
              >
                {feature}
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section id="graph" title="Service graph">
        <ServiceGraph services={services} />
      </Section>

      <Section id="routes" title="Actions and routes">
        <RoutesTable services={services} />
      </Section>

      {tables.length > 0 && (
        <Section id="database" title="Database tables">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {tables.map(({ service, table }) => (
              <DatabaseTable key={`${service}:${table.name}`} {...table} />
            ))}
          </div>
        </Section>
      )}

      <Section id="source" title="Source">
        <SourceBrowser slug={example.slug} entry={example.entry} />
      </Section>

      <Section id="run" title="Run it">
        <div className="space-y-3">
          <InstallCommand command="bun install" />
          {example.run.map((command) => (
            <div key={command}>
              <InstallCommand command={command} />
            </div>
          ))}
        </div>
        {example.runNote && (
          <p className="mt-4 max-w-2xl text-sm text-muted-foreground">
            {example.runNote}
          </p>
        )}
      </Section>
    </main>
  );
}
