import {
  brick,
  defineDatabase,
  definePlugin,
  defineService,
  outboxTable,
  sqliteTable,
  text as sqliteText,
} from "@brickkit/core";
import { pgTable, text as pgText } from "@brickkit/core/pg";

// `brick db` fixture: Postgres when BRICK_DB_URL is set, else a SQLite file.
// BRICK_DB_V2 adds a column, for a second migration. BRICK_DB_BILLING adds a
// second SQLite database at that path.
const url = process.env.BRICK_DB_URL;
const table = (url ? pgTable : sqliteTable) as typeof sqliteTable;
const text = (url ? pgText : sqliteText) as typeof sqliteText;

const notes = table("notes", {
  id: text("id").primaryKey(),
  body: text("body").notNull(),
  ...(process.env.BRICK_DB_V2 ? { title: text("title") } : {}),
});
// A resource table not passed to defineDatabase.
const tags = table("tags", { id: text("id").primaryKey() });
const outbox = url ? outboxTable("postgres") : outboxTable("sqlite");

const audit = definePlugin({
  name: "@acme/brick-audit",
  tables: ({ table, text }) => ({
    log: table("log", { id: text("id").primaryKey() }),
  }),
  resource: () => ({}),
});

const database = url
  ? defineDatabase({ engine: "postgres", url, tables: { notes, outbox } })
  : defineDatabase({
      path: process.env.BRICK_DB_FILE ?? ":memory:",
      tables: { notes, outbox },
    });

const service = defineService("notes", { database });
service.resource({ name: "tag", table: tags, id: tags.id }).use(audit());

const billingFile = process.env.BRICK_DB_BILLING;
const billing = billingFile
  ? [
      defineService("billing", {
        database: defineDatabase({
          name: "billing",
          path: billingFile,
          tables: {
            invoices: sqliteTable("invoices", {
              id: sqliteText("id").primaryKey(),
            }),
          },
        }),
      }),
    ]
  : [];

export default brick({
  services: [service, ...billing],
  requestLogging: false,
});
