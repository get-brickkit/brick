import { Link, createFileRoute } from "@tanstack/react-router";
import { ArrowRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  BrickFront,
  BrickGround,
  BrickPyramid,
  BrickSingle,
} from "@/components/brick-art";
import { HomeTour } from "@/components/home-tour";
import { InstallCommand } from "@/components/install-command";
import { site } from "@/lib/site";

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

const flow = [
  { label: "TABLE", title: "Drizzle table", code: 'status: text("status")' },
  {
    label: "RESOURCE",
    title: "Resource + CRUD",
    code: ".use(crud({ fields }))",
  },
  { label: "ROUTE", title: "HTTP route", code: "PATCH /api/orders/order/:id" },
  { label: "CONTRACT", title: "Client contract", code: "_brick/contract.ts" },
  { label: "UI", title: "Your UI", code: "api.orders.order.update()" },
];

const packages = [
  ["@brickkit/core", "services, actions, client"],
  ["@brickkit/crud", "resources, policies, hooks"],
  ["@brickkit/cli", "dev, build, gen, dashboard"],
  ["@brickkit/redis-world", "durable workflows on Redis"],
  ["@brickkit/bullmq-world", "durable workflows on BullMQ"],
];

function SectionHeading({
  index,
  label,
  title,
  children,
}: {
  index: string;
  label: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="home-section-heading">
      <div>
        <p className="course-mark label">
          <span aria-hidden="true" className="flex">
            <i />
            <i />
            <i />
          </span>
          {index} · {label}
        </p>
        <h2>{title}</h2>
      </div>
      {children && <p className="section-description">{children}</p>}
    </div>
  );
}

function StartButtons({ second }: { second: "github" | "tutorial" }) {
  return (
    <div className="hero-actions">
      <Link
        to="/docs/$"
        params={{ _splat: "quickstart" }}
        className="home-button home-button-primary"
      >
        Start building
      </Link>
      {second === "github" ? (
        <a
          href={site.repo}
          target="_blank"
          rel="noreferrer"
          data-umami-event="github-click"
          data-umami-event-location="hero"
          className="home-button home-button-secondary"
        >
          GitHub
        </a>
      ) : (
        <Link
          to="/docs/$"
          params={{ _splat: "tutorial" }}
          className="home-button home-button-secondary"
        >
          Read the tutorial
        </Link>
      )}
    </div>
  );
}

function Home() {
  return (
    <main id="top" className="brick-landing">
      <section className="brick-hero">
        <div className="hero-copy">
          <a
            href={`${site.repo}/releases`}
            target="_blank"
            rel="noreferrer"
            data-umami-event="github-click"
            data-umami-event-location="hero-release"
            className="hero-release label"
          >
            v{site.version} · MIT · Bun
          </a>
          <h1>
            Build your backend.
            <br />
            Keep your TypeScript.
          </h1>
          <p className="hero-description">
            A TypeScript backend framework on Bun. Actions, resources, events,
            sockets and MCP tools that fit together, typed from the table to the
            browser.
          </p>
          <StartButtons second="github" />
          <InstallCommand className="home-install" />
        </div>
        <BrickPyramid className="hero-bricks" />
        <BrickGround className="hero-ground" />
      </section>

      <section id="blocks" className="home-section">
        <SectionHeading
          index="01"
          label="One service file"
          title={
            <>
              Write the block once.
              <br />
              Brick serves it everywhere.
            </>
          }
        >
          Each building block is a few lines of TypeScript. Pick one to see the
          code and what it serves.
        </SectionHeading>
        <HomeTour />
      </section>

      <section id="flow" className="home-section">
        <SectionHeading
          index="02"
          label="From table to browser"
          title="One type, five places."
        >
          Change a column and the types follow it through the resource, the
          route and the generated client contract to your UI.
        </SectionHeading>
        <ol className="home-flow">
          {flow.map((step) => (
            <li key={step.label}>
              <BrickFront label={step.label} />
              <p>{step.title}</p>
              <code>{step.code}</code>
            </li>
          ))}
        </ol>
      </section>

      <section id="platform" className="home-section">
        <SectionHeading
          index="03"
          label="The rest of the backend"
          title="Every piece is opt-in."
        >
          Each one is typed from the same definitions and documented on its own
          page.
        </SectionHeading>
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

      <section id="stack" className="home-section home-split">
        <div>
          <SectionHeading
            index="04"
            label="Built on tools you know"
            title="No new runtime to learn."
          />
          <p className="section-description">
            Brick is a layer of structure over Bun, Elysia, TypeBox and Drizzle.
            Drop down to any of them when you need to.
          </p>
          <ul className="home-tools">
            {[
              "Bun 1.2+",
              "Elysia",
              "TypeBox",
              "Drizzle ORM",
              "Workflow SDK",
            ].map((tool) => (
              <li key={tool}>{tool}</li>
            ))}
          </ul>
        </div>
        <dl className="home-packages">
          {packages.map(([name, text]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{text}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="agents" className="home-section home-split">
        <div>
          <SectionHeading
            index="05"
            label="For your agent"
            title={
              <>
                Your agent builds
                <br />
                with Brick too.
              </>
            }
          />
          <p className="section-description">
            Give your coding agent the Brick skill and docs. Your own tools
            reach other agents over MCP.
          </p>
        </div>
        <div className="home-agent">
          <InstallCommand
            className="home-install"
            command="npx skills add get-brickkit/brick --skill brick"
          />
          <Link
            to="/docs/$"
            params={{ _splat: "for-ai-agents" }}
            className="capability-link"
          >
            Set up your agent with Brick docs and MCP
            <ArrowRightIcon className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      </section>

      <section className="home-final">
        <BrickSingle className="final-brick" />
        <h2>Lay the first brick.</h2>
        <p className="section-description">
          Install, define a service, and run it on Bun.
        </p>
        <StartButtons second="tutorial" />
        <InstallCommand className="home-install" />
      </section>
    </main>
  );
}
