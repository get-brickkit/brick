import { beforeEach, expect, it } from "bun:test";
import {
  brick,
  defineDatabase,
  definePlugin,
  defineService,
  resetGlobalRegistry,
  sqliteTable,
  syncSchema,
  text,
} from "@brickkit/core";
import { crud } from "../src";

beforeEach(resetGlobalRegistry);

const items = sqliteTable("dp_items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

// An audit plugin: owns its table and subscribes to the host's writes itself.
const audit = definePlugin({
  name: "@acme/brick-audit",
  requires: ["@brickkit/crud"],
  tables: ({ table, text }) => ({
    log: table("log", {
      id: text("id").primaryKey(),
      recordId: text("record_id").notNull(),
      operation: text("operation").notNull(),
    }),
  }),
  resource: ({ tables, hooks }) => {
    const write =
      (operation: string) =>
      ({ tx, id, row }: { tx: any; id?: unknown; row?: any }) =>
        tx.insert(tables.log).values({
          id: crypto.randomUUID(),
          recordId: String(row?.id ?? id),
          operation,
        });
    hooks.afterCreate(write("create"));
    hooks.afterUpdate(write("update"));
    hooks.afterDelete(write("delete"));
    hooks.beforeUpdate(({ data }) => {
      if (data.name === "forbidden") throw new Error("audit refused");
    });
    return { auditLog: tables.log };
  },
});

function setup() {
  const database = defineDatabase({ tables: { items } });
  const service = defineService("shop", { database });
  const item = service
    .resource({ name: "item", table: items, id: items.id })
    .use(
      crud({
        access: "public",
        fields: {
          id: { read: true, create: true },
          name: { read: true, create: true, update: true },
        },
      }),
    )
    .use(audit());
  const db = database.getDb();
  syncSchema(service);
  return { item, db, service };
}

it("host hooks run inside the write's transaction", async () => {
  const { item, db } = setup();
  await item.create.run({ id: "a", name: "Apple" });
  await item.update.run({ id: "a", data: { name: "Apricot" } });
  await expect(
    item.update.run({ id: "a", data: { name: "forbidden" } }),
  ).rejects.toThrow();
  await item.delete.run({ id: "a" });
  const log = await db.select().from(item.auditLog);
  expect(log.map((row) => [row.recordId, row.operation])).toEqual([
    ["a", "create"],
    ["a", "update"],
    ["a", "delete"],
  ]);
});

it("a plugin hook that throws rolls the write and other hooks' writes back", async () => {
  const veto = definePlugin({
    name: "@acme/veto",
    resource: ({ hooks }) => {
      hooks.afterUpdate(({ row }) => {
        if (row.name === "vetoed") throw new Error("vetoed");
      });
      return {};
    },
  });
  const { item, db } = setup();
  item.use(veto());
  await item.create.run({ id: "b", name: "Banana" });
  await expect(
    item.update.run({ id: "b", data: { name: "vetoed" } }),
  ).rejects.toThrow();
  const [row] = await db.select().from(items);
  expect(row!.name).toBe("Banana");
  // The audit row the update wrote before the veto is gone too.
  const log = await db.select().from(item.auditLog);
  expect(log.map((entry) => entry.operation)).toEqual(["create"]);
});

it("requires crud on the same resource first", () => {
  const database = defineDatabase({ tables: { items } });
  const service = defineService("shop2", { database });
  const bare = service.resource({ name: "item", table: items, id: items.id });
  expect(() => bare.use(audit())).toThrow(
    '@acme/brick-audit requires @brickkit/crud, installed on resource "item" before it',
  );
});

it("service-level hooks see every resource's writes, after commit too", async () => {
  const seen: string[] = [];
  const watcher = definePlugin({
    name: "@acme/watcher",
    service: ({ hooks }) => {
      hooks.afterCreate(({ row }) => void seen.push(`in tx ${row.id}`));
      hooks.afterCommit(
        ({ operation, id }) => void seen.push(`committed ${operation} ${id}`),
      );
      return {};
    },
  });
  const { item, service } = setup();
  service.use(watcher());
  await item.create.run({ id: "c", name: "Cherry" });
  expect(seen).toEqual(["in tx c", "committed create c"]);
});

it("plugin hooks and crud() inside a plugin read the plugin's deps as ctx.deps", async () => {
  const seen: unknown[] = [];
  const tags = sqliteTable("dp_tags", { id: text("id").primaryKey() });
  const tagger = definePlugin({
    name: "@acme/tagger",
    deps: { label: "" },
    service: ({ service, hooks }) => {
      hooks.afterCreate(({ ctx }) => void seen.push(`hook ${ctx.deps.label}`));
      service.resource({ name: "tag", table: tags, id: tags.id }).use(
        crud({
          access: "public",
          fields: { id: { read: true, create: true } },
          hooks: {
            beforeCreate: ({ ctx }) =>
              void seen.push(`crud ${Object.keys(ctx.deps)} ${ctx.deps.label}`),
          },
        }),
      );
    },
  });
  const database = defineDatabase({ tables: { items, tags } });
  const service = defineService("tagshop", {
    database,
    deps: { carrier: "host" },
  });
  const item = service
    .resource({ name: "item", table: items, id: items.id })
    .use(
      crud({
        access: "public",
        fields: {
          id: { read: true, create: true },
          name: { read: true, create: true },
        },
      }),
    );
  service.use(tagger({}, { deps: { label: "plugin" } }));
  syncSchema(service);
  brick({
    services: [service],
    requestLogging: false,
    docs: false,
  });
  await item.create.run({ id: "a", name: "Apple" });
  await (service.getAction("tag.create") as any).run({ id: "t" });
  expect(seen).toEqual(["hook plugin", "crud label plugin", "hook plugin"]);
});
