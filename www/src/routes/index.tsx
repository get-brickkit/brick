import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import * as React from "react";

import { InstallOptions } from "@/components/install-command";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";
import { SourceCode } from "@/components/source-code";
import { HomeCapabilities } from "@/components/home-capabilities";
import { HomeTour } from "@/components/home-tour";
import usersSource from "../../../examples/showcase/src/services/users.ts?raw";
import mainSource from "../../../examples/showcase/src/main.ts?raw";
import serverSource from "../../../examples/showcase/src/server.ts?raw";

export const Route = createFileRoute("/")({
  component: Home,
});

const features = [
  {
    title: "Services and actions",
    text: "Validated, typed units of work you call in process or over HTTP.",
    link: "services-and-actions",
  },
  {
    title: "Resources",
    text: "A Drizzle table becomes CRUD routes with field policies and filters.",
    link: "resources",
  },
  {
    title: "Commands",
    text: "Business rules that write a row and emit events in one transaction.",
    link: "commands",
  },
  {
    title: "Events",
    text: "Events recorded with the write, delivered to listeners after commit.",
    link: "events",
  },
  {
    title: "Realtime",
    text: "Typed WebSockets with rooms, fan-out, and reconnect.",
    link: "websockets",
  },
  {
    title: "Typed client",
    text: "A generated browser contract, with TanStack Query options.",
    link: "typed-client",
  },
  {
    title: "MCP tools",
    text: "Expose tools to AI agents over the Model Context Protocol.",
    link: "tools-and-mcp",
  },
  {
    title: "Access control",
    text: "Authorization guards on actions and row scoping on resources.",
    link: "access-control",
  },
  {
    title: "OpenAPI",
    text: "An OpenAPI document generated from the same definitions.",
    link: "openapi",
  },
  {
    title: "Migrations",
    text: "Create tables in development and run migrations in production.",
    link: "migrations",
  },
  {
    title: "Plugins",
    text: "Package routes, resources, and dashboard tabs to reuse across apps.",
    link: "plugins",
  },
  {
    title: "Dev dashboard",
    text: "brick dev serves a dashboard of requests, spans, and failures.",
    link: "brick-cli/dev-and-start",
  },
];

const kinds = [
  { id: "monolith", label: "Logical Monolith" },
  { id: "microservice", label: "HTTP Service" },
] as const;

type Kind = (typeof kinds)[number]["id"];

const codeSamples = {
  monolith: {
    serviceFile: "src/services/users.ts",
    serviceCode: usersSource.trim(),
    sideFile: "src/main.ts",
    sideDesc:
      "Invoke the same typed action directly in process. These files are the runnable examples/showcase source in this repository.",
    sideCode: mainSource.trim(),
  },
  microservice: {
    serviceFile: "src/server.ts",
    serviceCode: serverSource.trim(),
    sideFile: "src/server.ts",
    sideDesc:
      "Expose the users service over HTTP. Run bun run --cwd examples/showcase serve, then POST the id usr_42 to /api/users/get-user.",
    sideCode: serverSource.trim(),
  },
};

function Home() {
  const [kind, setKind] = React.useState<Kind>("monolith");
  const activeCode = codeSamples[kind];

  return (
    <main id="top" className="brick-landing">
      <section className="brick-hero">
        <a
          href={`${site.repo}/releases`}
          target="_blank"
          rel="noreferrer"
          data-umami-event="github-click"
          data-umami-event-location="hero-release"
          className="hero-release"
        >
          Brick v{site.version}, open source
        </a>
        <h1>
          Build your backend.
          <br />
          Keep your TypeScript.
        </h1>
        <p className="hero-description">
          A TypeScript backend framework on Bun, typed from the table to the
          browser.
        </p>
        <div className="hero-actions">
          <Link
            to="/docs/$"
            params={{ _splat: "quickstart" }}
            className="home-button home-button-primary"
          >
            Start building
          </Link>
          <a
            href={site.repo}
            target="_blank"
            rel="noreferrer"
            data-umami-event="github-click"
            data-umami-event-location="hero"
            className="home-button home-button-secondary"
          >
            Explore the source
          </a>
        </div>
        <InstallOptions />
        <HomeTour />
      </section>

      <section id="platform" aria-labelledby="platform-heading">
        <div className="home-section-heading">
          <h2 id="platform-heading">The rest of the backend.</h2>
          <p className="section-description">
            Each piece is opt-in and typed from the same definitions.
          </p>
        </div>
        <ul className="home-feature-index">
          {features.map((feature) => (
            <li key={feature.title}>
              <Link to="/docs/$" params={{ _splat: feature.link }}>
                <span>
                  {feature.title}
                  <ArrowRightIcon className="size-3.5" aria-hidden="true" />
                </span>
                <p>{feature.text}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <div id="definitions" className="home-section-heading">
        <div>
          <h2>
            One codebase.
            <br />
            Two ways to run.
          </h2>
        </div>
        <p className="section-description">
          Start with direct calls. Expose HTTP when you need it. The same typed
          definitions power both.
        </p>
      </div>

      <div className="brick-workbench">
        <div
          role="tablist"
          aria-label="Kind of deployment"
          className="workbench-tabs"
        >
          {kinds.map((k) => (
            <button
              key={k.id}
              type="button"
              role="tab"
              id={`tab-${k.id}`}
              aria-selected={kind === k.id}
              aria-controls="code-panel"
              onClick={() => setKind(k.id)}
              className={cn(
                "workbench-tab",
                kind === k.id && "workbench-tab-active",
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id="code-panel"
          aria-labelledby={`tab-${kind}`}
          className="grid lg:grid-cols-[1.3fr_1fr] lg:divide-x"
        >
          <figure className="min-w-0">
            <figcaption className="border-b px-4 py-3 font-mono text-xs text-muted-foreground sm:px-6">
              {activeCode.serviceFile}
            </figcaption>
            <div className="overflow-x-auto px-4 py-5 sm:px-6">
              <SourceCode
                key={activeCode.serviceCode}
                code={activeCode.serviceCode}
              />
            </div>
          </figure>
          {kind === "monolith" ? (
            <figure className="flex min-w-0 flex-col border-t lg:border-t-0">
              <figcaption className="border-b px-4 py-3 font-mono text-xs text-muted-foreground sm:px-6">
                {activeCode.sideFile}
              </figcaption>
              <div className="overflow-x-auto px-4 py-5 sm:px-6">
                <SourceCode
                  key={activeCode.sideCode}
                  code={activeCode.sideCode}
                />
              </div>
              <p className="mt-auto border-t px-4 py-4 text-sm leading-6 text-muted-foreground sm:px-6">
                {activeCode.sideDesc}
              </p>
            </figure>
          ) : (
            <div className="flex min-w-0 flex-col border-t lg:border-t-0">
              <p className="brick-caption border-b px-4 py-3 sm:px-6">
                Zero-refactor deployment
              </p>
              <div className="space-y-4 px-4 py-5 text-sm leading-6 text-muted-foreground sm:px-6">
                <p>
                  Use the same typed service definitions for direct calls and
                  HTTP routes. The runnable example exposes the users service on
                  port 3000.
                </p>
                <p>
                  Request /api/users/getUser?id=usr_42 to call the action over
                  HTTP.
                </p>
              </div>
              <figure className="mt-auto border-t">
                <figcaption className="brick-caption border-b px-4 py-3 sm:px-6">
                  Run the example
                </figcaption>
                <pre className="overflow-x-auto px-4 py-4 font-mono text-[13px] leading-[1.7] sm:px-6">
                  <span className="text-gopher-ink select-none">$ </span>
                  {"bun run --cwd examples/showcase serve\n"}
                  <span className="text-gopher-ink select-none">$ </span>
                  {"curl 'http://localhost:3000/api/users/getUser?id=usr_42'"}
                </pre>
              </figure>
            </div>
          )}
        </div>
      </div>

      <HomeCapabilities />
    </main>
  );
}
