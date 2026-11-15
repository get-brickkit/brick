import { SourceCode } from "@/components/source-code";

// Steps follow docs/(brick)/quickstart.mdx; keep them in step with that page.
const steps = [
  {
    title: "Install Brick",
    text: "Start a Bun project and add the core, CRUD and CLI packages.",
    file: "terminal",
    lang: "bash",
    code: `bun init -y
bun add @brickkit/core @brickkit/crud @brickkit/cli`,
  },
  {
    title: "Define a table",
    text: "Plain Drizzle. The columns are the types every later step uses.",
    file: "src/app.ts",
    lang: "ts",
    code: `export const pages = sqliteTable("pages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  content: text("content"),
});

const database = defineDatabase({ tables: { pages } });
export const pagesService = defineService("pages", { database });`,
  },
  {
    title: "Turn it into a resource",
    text: "Say who can read, write, filter and sort each field. Brick writes the routes.",
    file: "src/app.ts",
    lang: "ts",
    code: `pagesService.resource({ name: "page", table: pages, id: pages.id }).use(
  crud({
    access: "public",
    fields: {
      id: { read: true, filter: ["eq"] },
      title: { read: true, create: true, update: true, filter: ["eq", "contains"], sort: true },
      content: { read: true, create: true, update: true },
    },
  }),
);`,
  },
  {
    title: "Compose the app",
    text: "List your services. That is the whole entry point.",
    file: "src/app.ts",
    lang: "ts",
    code: `syncSchema(pagesService);

export default brick({
  services: [pagesService],
  title: "Pages API",
  version: "1.0.0",
});`,
  },
  {
    title: "Run it",
    text: "brick dev reloads on save and prints every route it mounted.",
    file: "terminal",
    lang: "bash",
    code: `bunx brick dev src/app.ts --port 4000

#  • pages (8 actions)
#    -> POST   /api/pages/page/query
#    -> GET    /api/pages/page/:id
#    -> POST   /api/pages/page
#    -> PATCH  /api/pages/page/:id
#    -> DELETE /api/pages/page/:id`,
  },
  {
    title: "Call it",
    text: "Validated JSON in and out, with OpenAPI docs served at /docs.",
    file: "terminal",
    lang: "bash",
    code: `curl -X POST localhost:4000/api/pages/page \\
  -H "Content-Type: application/json" \\
  -d '{"title": "First Page", "content": "Hello"}'

# {"id":"e379b38c-…","title":"First Page","content":"Hello"}`,
  },
];

/** Quickstart as a stack of steps: what you do on the left, the code on the right. */
export function HomeWalkthrough() {
  return (
    <ol className="home-walkthrough">
      {steps.map((step, i) => (
        <li key={step.title}>
          <div className="walkthrough-copy">
            <span className="walkthrough-number">
              {String(i + 1).padStart(2, "0")}
            </span>
            <h3>{step.title}</h3>
            <p>{step.text}</p>
          </div>
          <div className="walkthrough-code">
            <p className="walkthrough-file">{step.file}</p>
            <div className="tour-code">
              <SourceCode code={step.code} lang={step.lang} />
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
