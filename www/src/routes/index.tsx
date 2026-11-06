import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import * as React from "react";

import { LogoMark } from "@/components/logo";
import { InstallOptions } from "@/components/install-command";
import { site } from "@/lib/site";
import { cn } from "@/lib/utils";
import { SourceCode } from "@/components/source-code";
import { HomeCapabilities } from "@/components/home-capabilities";
import usersSource from "../../../examples/showcase/src/services/users.ts?raw";
import mainSource from "../../../examples/showcase/src/main.ts?raw";
import serverSource from "../../../examples/showcase/src/server.ts?raw";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      {
        name: "keywords",
        content: "Brick, TypeScript backend framework, Bun, API, MCP",
      },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "Brick",
          description: site.description,
          url: site.url,
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Bun",
          keywords: "TypeScript backend framework",
          sameAs: ["https://github.com/get-brickkit/brick"],
          publisher: {
            "@type": "Organization",
            name: "Brick",
            url: site.url,
            sameAs: ["https://github.com/get-brickkit"],
          },
        }),
      },
    ],
  }),
  component: Home,
});

const features = [
  {
    title: "Monomorphic Dispatch",
    text: "Call typed actions directly in process with the same validation and error handling used by HTTP routes.",
    link: "/docs/services-and-actions",
  },
  {
    title: "AOT Routing & Streaming",
    text: "Compile action handlers and resource plans ahead of request handling, and serve them through Elysia.",
    link: "/docs/brick-cli/build",
  },
  {
    title: "Logical Monolith",
    text: "Single repository with shared schemas, full TypeScript type safety, and instant jump-to-definition across services.",
    link: "/docs/type-inference",
  },
  {
    title: "Physical Microservices",
    text: "Expose services over HTTP using the same action definitions you invoke in process.",
    link: "/docs",
  },
  {
    title: "Better Auth & Drizzle",
    text: "First-class integration with Better Auth session security and Drizzle ORM pre-compiled query caching.",
    link: "/docs/access-control",
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
        <LogoMark className="hero-symbol" />
        <h1>
          Build your backend.
          <br />
          Keep your TypeScript.
        </h1>
        <p className="hero-caption">Small definitions. Production execution.</p>
        <p className="hero-description">
          Your actions, resources, and rules.
          <br className="hidden sm:block" /> Compiled into a backend ready to
          run on Bun.
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

      <div id="platform" className="home-section-heading home-platform-heading">
        <div>
          <h2>
            A foundation for
            <br />
            what comes next.
          </h2>
        </div>
        <p className="section-description">
          A focused set of primitives, built on the TypeScript tools you already
          know.
        </p>
      </div>
      <ul className="home-feature-grid">
        {features.map((feature, i) => (
          <li key={feature.title}>
            <Link
              to={feature.link}
              className="brick-feature group flex h-full flex-col rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <div
                className="feature-visual transition-colors group-hover:border-foreground/30"
                aria-hidden="true"
                data-variant={i}
              >
                <span className="visual-index">0{i + 1}</span>
                <div className="visual-flow">
                  <span>
                    {["ACTION", "ROUTE", "SERVICE", "HTTP", "SESSION"][i]}
                  </span>
                  <b>↓</b>
                  <span>
                    {["EXECUTE", "HANDLER", "ACTION", "SERVICE", "POLICY"][i]}
                  </span>
                </div>
                <span className="visual-caption">
                  {
                    [
                      "Type-safe execution",
                      "Compiled ahead of time",
                      "Direct in-process calls",
                      "Same action, new interface",
                      "Your identity, your rules",
                    ][i]
                  }
                </span>
              </div>
              <div className="feature-copy">
                <h3 className="flex items-center justify-between font-semibold tracking-tight">
                  {feature.title}
                  <ArrowRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
                </h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                  {feature.text}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <HomeCapabilities />
    </main>
  );
}
