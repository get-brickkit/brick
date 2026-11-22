import { defineService } from "@brickkit/core";
import { Type } from "@sinclair/typebox";
import { Effect } from "effect";
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

import type { CrudAuthorizeArgs, CrudInputs } from "../src";
import { crud } from "../src";
const table = sqliteTable("typed", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email"),
  secret: text("secret"),
});
const service = defineService("typed_crud");
const resource = service.resource({ name: "typed", table, id: table.id }).use(
  crud({
    access: "public",
    fields: {
      id: { read: true, filter: ["eq", "in"] },
      name: {
        read: true,
        create: true,
        update: true,
        filter: ["contains"],
        sort: true,
        scrub: ({ value }) => Effect.succeed(String(value).trim()),
      },
      email: {
        read: true,
        scrub: ({ value }): string | null => (value === null ? null : "masked"),
      },
    },
    operations: { delete: false },
  }),
);
const result = resource.list.run({
  select: ["id", "email"],
  where: { field: "id", op: "in", value: [1, 2] },
});
result.then((rows) => {
  const id: number = rows.items[0].id;
  const email: string | null = rows.items[0].email;
  void id;
  void email;
  // @ts-expect-error name was not selected
  void rows.items[0].name;
});
resource.list.run({ select: ["name"] }).then((rows) => {
  // An Effect-returning scrub reads as the value it succeeds with.
  const name: string = rows.items[0].name;
  void name;
});
declare const needsClock: Effect.Effect<number, never, "Clock">;
crud({
  access: "public",
  fields: {
    id: {
      read: true,
      // @ts-expect-error an Effect that still needs a service is not runnable
      scrub: () => needsClock,
    },
    name: { read: true, scrub: () => ({ masked: true }) },
    email: { read: true, scrub: () => ["a", "b"] },
  },
});
resource.create.run({ name: "A" });
resource.update.run({ id: 1, data: { name: "B" } });
// @ts-expect-error hidden field cannot be selected
resource.list.run({ select: ["secret"] });
// @ts-expect-error operation disabled
void resource.delete;
// @ts-expect-error field not writable
resource.create.run({ name: "A", secret: "hidden" });
// @ts-expect-error field not updateable
resource.update.run({ id: 1, data: { email: "x" } });
// @ts-expect-error numeric ID does not accept string
resource.get.run({ id: "wrong" });
// @ts-expect-error contains is not allowed for id
resource.list.run({ where: { field: "id", op: "contains", value: "1" } });
// @ts-expect-error typed filter value
resource.list.run({ where: { field: "id", op: "eq", value: "1" } });
// @ts-expect-error email not sortable
resource.list.run({ orderBy: [{ field: "email", direction: "asc" }] });
const empty = service
  .resource({ name: "empty", table })
  .use(crud({ access: "public", fields: {}, operations: false }));
// @ts-expect-error disabled plugin contributes no operations
void empty.list;

resource.get.run({ id: 1, select: ["id"] }).then((row) => {
  const id: number = row.id;
  void id;
  // @ts-expect-error non-selected field
  void row.name;
});

crud({
  fields: {
    id: { read: true, filter: ["eq", "in"] },
    name: {
      read: true,
      create: true,
      update: true,
      filter: ["eq", "contains"],
      sort: true,
      schema: Type.String(),
    },
  },
  access: {
    authorize: ({ operation, input }) => {
      switch (operation) {
        case "list":
        case "findOne": {
          const limit: number | undefined = input.limit;
          const select: readonly ("id" | "name")[] | undefined = input.select;
          const sort: "name" | undefined = input.orderBy?.[0]?.field;
          void [limit, select, sort];
          // @ts-expect-error query input has no id
          void input.id;
          break;
        }
        case "get":
          void input.id;
          void input.select;
          // @ts-expect-error get input has no data
          void input.data;
          break;
        case "create": {
          const name: string | undefined = input.name;
          void name;
          // @ts-expect-error id is not createable
          void input.id;
          break;
        }
        case "update": {
          const name: string | undefined = input.data.name;
          void [input.id, name];
          // @ts-expect-error id is not updateable
          void input.data.id;
          break;
        }
        case "delete":
          void input.id;
          // @ts-expect-error delete input has no select
          void input.select;
          break;
        case "count":
        case "exists":
          // @ts-expect-error count and exists have no pagination
          void input.limit;
          break;
        default: {
          const exhaustive: never = operation;
          void exhaustive;
        }
      }
      if (
        (operation === "list" ||
          operation === "count" ||
          operation === "exists") &&
        input.where &&
        "field" in input.where
      ) {
        if (input.where.field === "name") {
          const value: string = input.where.value;
          void value;
          // @ts-expect-error schema gives string, not number
          const number: number = input.where.value;
          void number;
        } else if (input.where.op === "in") {
          const values: readonly unknown[] = input.where.value;
          void values;
        }
        // @ts-expect-error only configured operators are possible
        const invalid: "between" = input.where.op;
        void invalid;
      }
      return true;
    },
  },
});

const policyFields = {
  name: { read: true, create: true, schema: Type.String(), filter: ["eq"] },
} as const;
const query: CrudInputs<typeof policyFields>["list"] = {
  where: { field: "name", op: "eq", value: "A" },
};
void query;
const authorize = (args: CrudAuthorizeArgs<typeof policyFields>) => {
  if (args.operation === "create") {
    const name: string | undefined = args.input.name;
    void name;
  }
  return true;
};
crud({ fields: policyFields, access: { authorize } });
const broadAuthorize = ({ operation, input }: CrudAuthorizeArgs) => {
  if (operation === "list") void input.where;
  return true;
};
crud({ fields: policyFields, access: { authorize: broadAuthorize } });

const derived = service.resource({ name: "derived", table, id: table.id }).use(
  crud({
    access: "public",
    fields: {
      id: { read: true },
      children: {
        read: true,
        schema: Type.Array(Type.Object({ label: Type.String() })),
        resolve: ({ rows }) => rows.map(() => [{ label: "child" }]),
      },
    },
  }),
);
async function derivedTypes() {
  const row = await derived.get.run({ id: 1, include: ["children"] });
  const label: string = row.children[0].label;
  const defaultRow = await derived.get.run({ id: 1 });
  // @ts-expect-error default output has no children
  void defaultRow.children;
  // @ts-expect-error children require include, not select
  await derived.get.run({ id: 1, select: ["children"] });
  const list = await derived.list.run({ include: ["children"] });
  const childLabel: string = list.items[0].children[0].label;
  const found = await derived.findOne.run({ include: ["children"] });
  if (found) {
    const foundLabel: string = found.children[0].label;
    void foundLabel;
  }
  void childLabel;
  // @ts-expect-error derived fields cannot be filtered
  await derived.list.run({ where: { field: "children", op: "eq", value: [] } });
  await derived.list.run({
    // @ts-expect-error derived fields cannot be sorted
    orderBy: [{ field: "children", direction: "asc" }],
  });
  return label;
}
void derivedTypes;

// @ts-expect-error bulk operations are off unless enabled
void resource.bulkCreate;
const bulk = service.resource({ name: "bulk", table, id: table.id }).use(
  crud({
    access: "public",
    fields: {
      id: { read: true },
      name: { read: true, create: true, update: true },
    },
    operations: { bulkCreate: true, bulkUpdate: true, bulkDelete: true },
    hooks: {
      afterCreate: async ({ tx, row }) =>
        void (await tx.insert(table).values({ name: String(row.name) })),
      afterCommit: (args) => {
        if (args.operation === "delete") {
          // @ts-expect-error a deleted row is gone
          void args.row.name;
        } else void args.row.name;
      },
    },
  }),
);
bulk.bulkCreate.run({ items: [{ name: "A" }] }).then((out) => {
  const name: string = out.items[0].name;
  void name;
});
bulk.bulkUpdate.run({ items: [{ id: 1, data: { name: "B" } }] });
bulk.bulkDelete.run({ ids: [1] }).then((out) => {
  const count: number = out.count;
  void count;
});
// @ts-expect-error bulk items use the create allow-list
bulk.bulkCreate.run({ items: [{ name: "A", secret: "hidden" }] });
// @ts-expect-error numeric IDs
bulk.bulkDelete.run({ ids: ["1"] });
