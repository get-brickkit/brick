import {
  defineService,
  defineResourcePlugin,
  sqliteTable,
  text,
  type ResourcePluginContext,
} from "../src";
const table = sqliteTable("typed_host", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});
const service = defineService("typed_host");
const resource = service.resource({ name: "entry", table, id: table.id });
const plugin = defineResourcePlugin({
  name: "typed/example",
  setup({
    resource: host,
  }: ResourcePluginContext<typeof service, typeof resource>) {
    const exact: typeof table = host.table;
    return { extra: { title: exact.title } };
  },
});
const extended = resource.use(plugin);
const column: typeof table.title = extended.extra.title;
void column;
// @ts-expect-error A declaration has no CRUD capability until a plugin supplies it.
void resource.create;
// @ts-expect-error CRUD policies belong to a plugin, not the generic resource host.
service.resource({ name: "invalid", table, fields: { title: { read: true } } });
