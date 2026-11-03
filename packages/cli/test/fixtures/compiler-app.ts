import { crud } from "@brickkit/crud";
import {
  brick,
  defineService,
  t,
  defineDatabase,
  syncSchema,
  sqliteTable,
  text,
} from "@brickkit/core";
const service = defineService("built", {
  context: (ctx) => ({
    user: ctx.request.headers.get("x-user") ? { id: "alice" } : null,
  }),
});
service.action({
  name: "getPage",
  method: "GET",
  path: "/public/pages/:slug",
  input: t.Object({ slug: t.String({ minLength: 2 }) }),
  output: t.Object({ slug: t.String() }),
  authorize: ({ user }) => Boolean(user),
  execute: async ({ input }) => input,
});
const plain = defineService("plain");
plain.action({
  name: "getReady",
  method: "GET",
  execute: () => ({ ok: true }),
});

const pages = sqliteTable("built_read_pages", {
  id: text("page_id").primaryKey(),
  title: text("headline").notNull(),
});
const database = defineDatabase({ tables: [pages] });
syncSchema(database.tables, database.getDb());
database.getDb().insert(pages).values({ id: "one", title: "Built page" }).run();
const store = defineService("store", { database });
store.resource({ name: "page", table: pages }).use(
  crud({
    access: "public",
    fields: {
      id: { read: true, create: true },
      title: { read: true, create: true, update: true },
    },
  }),
);

const excluded = defineService("excluded");
excluded.action({ name: "hello", method: "GET", execute: () => "excluded" });

const app = brick({
  services: [service, plain, store],
  prefix: "/v1",
  title: "Compiled app",
  version: "3.2.1",
  openApiPath: "/spec.json",
  docsPath: "/api-docs",
  reference: { path: "/reference", title: "App reference" },
  requestLogging: false,
});
app.onAfterHandle("global", ({ set }) => {
  set.headers["x-app-hook"] = "preserved";
});
app.endpoint({ method: "GET", path: "/raw", handler: () => ({ raw: true }) });
app.get("/custom", () => ({ custom: true }));
export default app;
