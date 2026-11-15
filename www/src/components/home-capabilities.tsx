import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  DatabaseIcon,
  FileJsonIcon,
  ShieldCheckIcon,
  TerminalIcon,
  CodeIcon,
  WebhookIcon,
  RadioIcon,
} from "lucide-react";
import { SourceCode } from "@/components/source-code";
import { LogoMark } from "@/components/logo";
import { InstallCommand } from "@/components/install-command";
import { cn } from "@/lib/utils";
import extensionSource from "../../../examples/extensions/src/extensions/comments/index.ts?raw";
import appSource from "../../../examples/extensions/src/app.ts?raw";

// Cut a snippet out of the real source, and fail loudly once a marker stops matching.
function between(start: string, end: string) {
  const from = extensionSource.indexOf(start);
  const to = extensionSource.indexOf(end, from);
  if (from < 0 || to < 0)
    throw new Error(`comments extension snippet not found: ${start}`);
  const lines = extensionSource.slice(from, to).trimEnd().split("\n");
  const indent = Math.min(
    ...lines.filter(Boolean).map((line) => line.search(/\S/)),
  );
  return lines.map((line) => line.slice(indent)).join("\n");
}
const pluginCode = between("export const comments =", "  resource: (");
const resourceCode = between(
  "    const comment = service",
  "    return { comments: comment };",
);
const routes = [
  ["POST", "/api/comment/query", "List"],
  ["GET", "/api/comment/:id", "Read"],
  ["POST", "/api/comment", "Create"],
  ["PATCH", "/api/comment/:id", "Update"],
  ["DELETE", "/api/comment/:id", "Delete"],
];

function DocsLink({
  slug,
  children,
}: {
  slug: string;
  children: React.ReactNode;
}) {
  return (
    <Link to="/docs/$" params={{ _splat: slug }} className="capability-link">
      {children}
    </Link>
  );
}

function CodePanel({ title, code }: { title: string; code: string }) {
  return (
    <figure className="brick-workbench capability-code">
      <figcaption>
        <span>{title}</span>
      </figcaption>
      <div className="capability-code-body">
        <SourceCode key={code} code={code} />
      </div>
    </figure>
  );
}

export function HomeCapabilities() {
  const [example, setExample] = React.useState<"resource" | "plugin">(
    "resource",
  );
  return (
    <div className="home-capabilities">
      <section id="resources" className="capability-section capability-split">
        <div className="capability-copy">
          <h2>
            A table becomes an API.
            <br />
            Your rules come with it.
          </h2>
          <p>
            Define a Drizzle table and install the CRUD resource plugin. It
            supplies CRUD routes, list filters, pagination, and typed hooks. Add
            custom actions for everything beyond CRUD.
          </p>
          <div
            className="resource-route-list"
            aria-label="Generated resource routes"
          >
            {routes.map(([method, path, operation]) => (
              <div key={method + path}>
                <span>{method}</span>
                <code>{path}</code>
                <span>{operation}</span>
              </div>
            ))}
          </div>
          <DocsLink slug="resources">Explore resources</DocsLink>
        </div>
        <div className="capability-demo">
          <div
            className="capability-tabs"
            role="tablist"
            aria-label="Resource or plugin definition example"
          >
            {(["resource", "plugin"] as const).map((value) => (
              <button
                type="button"
                role="tab"
                id={`feature-tab-${value}`}
                aria-selected={example === value}
                aria-controls="feature-code"
                key={value}
                onClick={() => setExample(value)}
                className={cn(
                  "capability-tab",
                  example === value && "capability-tab-active",
                )}
              >
                {value === "resource"
                  ? "Resource + hooks"
                  : "Plugin definition"}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="feature-code"
            aria-labelledby={`feature-tab-${example}`}
          >
            <CodePanel
              title="comments/index.ts"
              code={example === "resource" ? resourceCode : pluginCode}
            />
          </div>
          <p className="demo-caption">
            Actual source from the comments extension. No illustrative APIs.
          </p>
        </div>
      </section>

      <section
        id="validation"
        className="capability-section capability-surface"
      >
        <div className="capability-section-heading">
          <div>
            <h2>
              One definition.
              <br />
              Fewer places to drift.
            </h2>
          </div>
          <div className="capability-heading-copy">
            <p>
              TypeBox schemas supply action types and runtime validation.
              Drizzle tables supply row types and resource shapes. OpenAPI
              describes the same registered API.
            </p>
            <DocsLink slug="codegen">Follow the types</DocsLink>
          </div>
        </div>
        <div
          className="contract-pipeline"
          aria-label="One definition supplies input validation, handler types, resource shapes, and API contracts"
        >
          {[
            [
              "01",
              "Inputs",
              "Request validation",
              "t.Object({ id: t.String() })",
              "validation-and-errors",
            ],
            [
              "02",
              "Handlers",
              "Inferred action types",
              "execute: ({ input, ctx })",
              "services-and-actions",
            ],
            [
              "03",
              "Resources",
              "Table-derived shapes",
              "table.$inferSelect",
              "resources",
            ],
            [
              "04",
              "API contracts",
              "Registered API schemas",
              "OpenAPI 3.1",
              "openapi",
            ],
          ].map(([number, title, text, code, slug]) => (
            <Link
              key={title}
              to="/docs/$"
              params={{ _splat: slug }}
              className="group block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <div className="pipeline-top">
                <span>{number}</span>
                <ArrowRightIcon
                  className="size-3 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                  aria-hidden="true"
                />
              </div>
              <h3 className="transition-colors group-hover:text-foreground">
                {title}
              </h3>
              <p>{text}</p>
              <code>{code}</code>
            </Link>
          ))}
        </div>
      </section>

      <section
        id="access-control"
        className="capability-section capability-split"
      >
        <div className="capability-copy">
          <h2>
            Put access rules
            <br />
            next to the work.
          </h2>
          <p>
            Resolve a session into service context, authorize custom actions,
            and scope resource rows to their owner. Connect Better Auth through
            its session API or bring your own provider.
          </p>
          <p className="capability-note">
            Configure sign-in checks for protected CRUD routes. Owner scoping
            complements those checks.
          </p>
          <DocsLink slug="access-control">Configure access control</DocsLink>
        </div>
        <div className="policy-panel">
          <div className="panel-label">
            <ShieldCheckIcon className="size-4" />
            <span>The policy pipeline</span>
          </div>
          <ol>
            {[
              ["Context", "Resolve the user and session."],
              ["Authorization", "Check access before execution."],
              ["Ownership", "Scope records to their owner."],
            ].map(([title, text], i) => (
              <li key={title}>
                <span className="policy-number">0{i + 1}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
                <CheckIcon className="size-4" aria-hidden="true" />
              </li>
            ))}
          </ol>
          <div className="policy-result">
            <span className="status-dot" />
            Your identity. Your policies.
          </div>
        </div>
      </section>

      <section id="databases" className="capability-section">
        <div className="capability-section-heading">
          <div>
            <h2>Drizzle at the foundation.</h2>
          </div>
          <p className="capability-heading-copy">
            Keep your SQL, table definitions, and migrations. Brick adds
            services and resources around them.
          </p>
        </div>
        <div className="database-grid">
          {[
            [
              "SQLite",
              "LOCAL / EMBEDDED",
              "Start locally with Bun’s native SQLite driver. Use an in-memory database for examples or a file-backed database for persistence.",
              "Bun-native driver",
              "In-memory or file-backed",
            ],
            [
              "PostgreSQL",
              "CONNECTED / PRODUCTION",
              "Connect PostgreSQL with a URL and Drizzle tables. Keep production schema changes in your migration workflow.",
              "Postgres.js driver",
              "Drizzle table definitions",
            ],
          ].map(([title, label, text, first, second]) => (
            <article className="database-card" key={title}>
              <div className="database-visual" aria-hidden="true">
                <span className="panel-label">{label}</span>
                <div className="database-node">
                  <DatabaseIcon />
                  <span>{title}</span>
                </div>
                <div className="database-connector" />
                <div className="database-tables">
                  <span>TABLES</span>
                  <span>RESOURCES</span>
                  <span>ACTIONS</span>
                </div>
              </div>
              <div className="database-copy">
                <h3>{title}</h3>
                <p>{text}</p>
                <ul>
                  {[first, second].map((item) => (
                    <li key={item}>
                      <CheckIcon className="size-3" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </div>
        <DocsLink slug="migrations">Read the database guide</DocsLink>
      </section>

      <section
        id="extensions"
        className="capability-section capability-split capability-surface"
      >
        <div className="capability-copy">
          <h2>
            Build once.
            <br />
            Bring it along.
          </h2>
          <p>
            Package a table, resource, hooks, and custom actions as a reusable
            TypeScript module. Import it into a service and register it before
            building the server.
          </p>
          <div className="extension-modules">
            <span>Comments</span>
            <span>Audit trails</span>
            <span>Resource hooks</span>
            <span>Custom actions</span>
          </div>
          <p className="capability-note">
            The comments example is runnable today. Use the same pattern for
            your own workflows.
          </p>
          <DocsLink slug="plugins/build-plugin">
            Build your first extension
          </DocsLink>
        </div>
        <div className="capability-demo">
          <CodePanel title="extensions/src/app.ts" code={appSource.trim()} />
          <p className="demo-caption">
            Standard imports. Standard TypeScript. Your reusable module.
          </p>
        </div>
      </section>

      <section id="endpoints" className="capability-section">
        <div className="capability-section-heading">
          <div>
            <h2>More than a JSON API.</h2>
          </div>
          <p className="capability-heading-copy">
            Use raw endpoints when you need direct control over the request,
            headers, status, or response body.
          </p>
        </div>
        <div className="capability-product-grid">
          {[
            {
              title: "HTML surfaces",
              text: "Render a public page and set its content type in your handler.",
              icon: CodeIcon,
              visual: "<html>",
              detail: "CONTENT-TYPE / TEXT/HTML",
            },
            {
              title: "Webhook handlers",
              text: "Read the original request and apply your provider’s signature checks.",
              icon: WebhookIcon,
              visual: "POST → VERIFY",
              detail: "REQUEST / RAW BODY",
            },
            {
              title: "Custom responses",
              text: "Return a Response with your own headers, status, or streaming body.",
              icon: RadioIcon,
              visual: "Response",
              detail: "STATUS / HEADERS / BODY",
            },
          ].map(({ title, text, icon: Icon, visual, detail }) => (
            <article key={title}>
              <div className="product-visual" aria-hidden="true">
                <Icon className="product-icon" />
                <code>{visual}</code>
                <span>{detail}</span>
              </div>
              <h3>{title}</h3>
              <p>{text}</p>
            </article>
          ))}
        </div>
        <DocsLink slug="plugins">Explore the endpoint API</DocsLink>
      </section>

      <section id="tooling" className="capability-section">
        <div className="capability-section-heading">
          <div>
            <h2>
              Inspect it.
              <br />
              Document it. Compile it.
            </h2>
          </div>
          <p className="capability-heading-copy">
            See what your definitions become. Work with real output, live
            contracts, and runnable examples.
          </p>
        </div>
        <div className="capability-product-grid">
          {[
            {
              title: "An inspectable compiler",
              text: "Build emits route handlers, Brick IR, and a bundled Bun server. Your callbacks remain TypeScript-authored application logic.",
              icon: TerminalIcon,
              visual: "$ brick build",
              detail: "ROUTES → IR → SERVER",
              slug: "brick-cli/build",
              link: "See compiler output",
            },
            {
              title: "A documented API",
              text: "Serve generated OpenAPI with Scalar and Swagger views. Export a spec or inspect the registered service architecture.",
              icon: FileJsonIcon,
              visual: "OpenAPI 3.1",
              detail: "SCHEMA → CONTRACT",
              slug: "openapi",
              link: "Explore API documentation",
            },
            {
              title: "Verified examples",
              text: "The extension demo exercises compiled routes, CRUD, validation errors, and direct action calls.",
              icon: CheckIcon,
              visual: "CRUD / VALIDATION",
              detail: "RUN THE ACTUAL ROUTES",
              slug: "plugins/build-plugin",
              link: "Run the example",
            },
          ].map(({ title, text, icon: Icon, visual, detail, slug, link }) => (
            <Link
              key={title}
              to="/docs/$"
              params={{ _splat: slug }}
              className="group flex flex-col rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <div
                className="product-visual transition-colors group-hover:border-foreground/30"
                aria-hidden="true"
              >
                <Icon className="product-icon" />
                <code>{visual}</code>
                <span>{detail}</span>
              </div>
              <h3 className="flex items-center justify-between font-semibold tracking-tight">
                {title}
              </h3>
              <p>{text}</p>
              <span className="capability-link mt-auto pt-1">
                {link}
                <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0" />
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section id="ecosystem" className="capability-section ecosystem-section">
        <h2>
          Tools you know.
          <br />A backend you own.
        </h2>
        <div className="ecosystem-tools">
          {["TypeScript", "Bun", "Elysia", "TypeBox", "Drizzle"].map((tool) => (
            <span key={tool}>{tool}</span>
          ))}
        </div>
        <p>
          A backend authoring layer over a familiar runtime and database
          toolkit.
        </p>
      </section>

      <section className="home-final-cta capability-section">
        <LogoMark className="cta-symbol" />
        <h2>
          Write the definitions.
          <br />
          Make something real.
        </h2>
        <div className="hero-actions">
          <Link
            to="/docs/$"
            params={{ _splat: "quickstart" }}
            className="home-button home-button-primary"
          >
            Start with the guide
          </Link>
          <Link
            to="/docs/$"
            params={{ _splat: "plugins/build-plugin" }}
            className="home-button home-button-secondary"
          >
            Run an example
          </Link>
        </div>
        <InstallCommand className="home-install" />
      </section>
    </div>
  );
}
