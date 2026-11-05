import { expect, test } from "bun:test";

import { brick, generateOpenApiSpec, runInTransaction } from "@brickkit/core";
import { createBrickClient } from "@brickkit/core/client";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { crud } from "../src";
import { clientContract, sqliteService } from "./helpers";

const records = sqliteTable("records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  owner: text("owner"),
});
const audit = sqliteTable("audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  note: text("note").notNull(),
});

function fixture(options: Partial<Parameters<typeof crud>[0]> = {}) {
  const { db, sqlite, service } = sqliteService("tx", [records, audit]);
  const notes = service
    .resource({ name: "note", table: audit, id: audit.id })
    .use(
      crud({
        access: "public",
        fields: { id: { read: true }, note: { read: true, create: true } },
        // A hook makes the nested create open its own (joined) transaction.
        hooks: { beforeCreate: () => {} },
      }),
    );
  const resource: any = service
    .resource({ name: "record", table: records, id: records.id })
    .use(
      crud({
        access: "public",
        fields: {
          id: { read: true },
          name: { read: true, create: true, update: true },
        },
        operations: { bulkCreate: true, bulkUpdate: true, bulkDelete: true },
        ...options,
      } as Parameters<typeof crud>[0]),
    );
  const names = () =>
    db
      .select()
      .from(records)
      .all()
      .map((row: any) => row.name);
  const notesWritten = () =>
    db
      .select()
      .from(audit)
      .all()
      .map((row: any) => row.note);
  return { db, sqlite, service, resource, notes, names, notesWritten };
}

test("hooks write other tables in the operation's transaction", async () => {
  const committed: unknown[] = [];
  const f = fixture({
    hooks: {
      afterCreate: async ({ row, tx, ctx }) => {
        // A crud call that joins the open transaction instead of waiting on it.
        await f.notes.create.run(
          { note: `created ${row.name}` },
          {
            ...ctx,
            db: tx,
          },
        );
        if (row.name === "bad") throw new Error("hook failed");
      },
      afterUpdate: async ({ tx }) => {
        await tx.insert(audit).values({ note: "updated" });
      },
      beforeDelete: async ({ tx }) => {
        await tx.insert(audit).values({ note: "deleting" });
      },
      afterCommit: ({ operation, id, row }) => {
        // Runs once the write is visible outside the transaction.
        committed.push([operation, id, row?.name, f.names().length]);
      },
    },
  });
  try {
    expect(await f.resource.create.run({ name: "a" })).toEqual({
      id: 1,
      name: "a",
    });
    expect(f.notesWritten()).toEqual(["created a"]);
    // An unexpected hook error is a 500, and nothing it touched is kept.
    await expect(f.resource.create.run({ name: "bad" })).rejects.toMatchObject({
      status: 500,
    });
    expect(f.names()).toEqual(["a"]);
    expect(f.notesWritten()).toEqual(["created a"]);

    await f.resource.update.run({ id: 1, data: { name: "b" } });
    await f.resource.delete.run({ id: 1 });
    expect(f.notesWritten()).toEqual(["created a", "updated", "deleting"]);
    expect(committed).toEqual([
      ["create", 1, "a", 1],
      ["update", 1, "b", 1],
      ["delete", 1, undefined, 0],
    ]);
  } finally {
    f.sqlite.close();
  }
});

test("a failing before hook or write fires no afterCommit and keeps nothing", async () => {
  const committed: string[] = [];
  const f = fixture({
    hooks: {
      beforeUpdate: async ({ tx, data, error }) => {
        await tx.insert(audit).values({ note: "before" });
        if (data.name === "refused") error.BAD_REQUEST("refused");
      },
      afterCommit: ({ operation }) => void committed.push(operation),
    },
  });
  try {
    await f.db.insert(records).values({ name: "a" });
    await f.db.insert(records).values({ name: "taken" });
    await expect(
      f.resource.update.run({ id: 1, data: { name: "refused" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      f.resource.update.run({ id: 1, data: { name: "taken" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.names()).toEqual(["a", "taken"]);
    expect(f.notesWritten()).toEqual([]);
    expect(committed).toEqual([]);
  } finally {
    f.sqlite.close();
  }
});

test("an afterCommit error is logged and does not fail the committed write", async () => {
  const logged: unknown[] = [];
  const f = fixture({
    hooks: {
      afterCommit: () => {
        throw new Error("cache down");
      },
    },
  });
  try {
    const logger = { error: (...args: unknown[]) => logged.push(args) };
    expect(
      await f.resource.create.run({ name: "a" }, { logger } as any),
    ).toEqual({ id: 1, name: "a" });
    expect(f.names()).toEqual(["a"]);
    expect(logged).toHaveLength(1);
  } finally {
    f.sqlite.close();
  }
});

test("bulk create writes every item in one transaction, hooks per row", async () => {
  const calls: string[] = [];
  const f = fixture({
    hooks: {
      beforeCreate: ({ data }) => {
        data.name = String(data.name).trim();
        calls.push(`before ${data.name}`);
      },
      afterCreate: ({ row }) => void calls.push(`after ${row.name}`),
      afterCommit: ({ row }) =>
        void calls.push(`commit ${row?.name} seen=${f.names().length}`),
    },
  });
  try {
    expect(
      await f.resource.bulkCreate.run({
        items: [{ name: " a " }, { name: "b" }],
      }),
    ).toEqual({
      items: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    });
    expect(calls).toEqual([
      "before a",
      "after a",
      "before b",
      "after b",
      "commit a seen=2",
      "commit b seen=2",
    ]);
  } finally {
    f.sqlite.close();
  }
});

test("a bulk failure rolls the whole batch back and names the item", async () => {
  const committed: unknown[] = [];
  const f = fixture({
    hooks: {
      afterCreate: async ({ tx, row }) => {
        await tx.insert(audit).values({ note: `child of ${row.name}` });
      },
      afterCommit: ({ id }) => void committed.push(id),
    },
  });
  try {
    await f.db.insert(records).values({ name: "taken" });
    const failure = await f.resource.bulkCreate
      .run({ items: [{ name: "a" }, { name: "taken" }, { name: "c" }] })
      .catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      code: "CONFLICT",
      status: 409,
      message: "Item 1: Resource already exists",
      details: { index: 1, code: "CONFLICT" },
    });
    expect(f.names()).toEqual(["taken"]);
    expect(f.notesWritten()).toEqual([]);
    expect(committed).toEqual([]);

    await f.db.insert(records).values({ name: "b" });
    await expect(
      f.resource.bulkUpdate.run({
        items: [
          { id: 2, data: { name: "b2" } },
          { id: 99, data: { name: "gone" } },
        ],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", details: { index: 1 } });
    await expect(
      f.resource.bulkDelete.run({ ids: [1, 99] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", details: { index: 1 } });
    expect(f.names()).toEqual(["taken", "b"]);
  } finally {
    f.sqlite.close();
  }
});

test("bulk update and delete apply scope and authorize to every row", async () => {
  const authorized: unknown[] = [];
  const f = fixture({
    fields: {
      id: { read: true },
      name: { read: true, create: true, update: true },
    },
    access: {
      authorize: ({ operation, input }) => {
        authorized.push([operation, input]);
        return true;
      },
      scope: ({ ctx }) => eq(records.owner, ctx.user?.id),
    },
  });
  try {
    await f.db.insert(records).values([
      { name: "mine", owner: "me" },
      { name: "theirs", owner: "them" },
      { name: "mine too", owner: "me" },
    ]);
    const ctx = { user: { id: "me" } };
    // A row outside the scope fails like a missing one; nothing is changed.
    await expect(
      f.resource.bulkUpdate.run(
        {
          items: [
            { id: 1, data: { name: "edited" } },
            { id: 2, data: { name: "stolen" } },
          ],
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Item 1: Resource not found",
    });
    await expect(
      f.resource.bulkDelete.run({ ids: [3, 2] }, ctx),
    ).rejects.toMatchObject({ code: "NOT_FOUND", details: { index: 1 } });
    expect(f.names()).toEqual(["mine", "theirs", "mine too"]);

    expect(await f.resource.bulkDelete.run({ ids: [1, 3] }, ctx)).toEqual({
      count: 2,
    });
    expect(f.names()).toEqual(["theirs"]);
    // authorize sees the single-row operation and input for each item.
    expect(authorized.slice(-2)).toEqual([
      ["delete", { id: 1 }],
      ["delete", { id: 3 }],
    ]);
    expect(authorized[0]).toEqual([
      "update",
      { id: 1, data: { name: "edited" } },
    ]);
    // Bulk create is refused under a row scope, as create is.
    await expect(
      f.resource.bulkCreate.run({ items: [{ name: "x" }] }, ctx),
    ).rejects.toMatchObject({ code: "FORBIDDEN", details: { index: 0 } });
  } finally {
    f.sqlite.close();
  }
});

test("bulk input reuses the single-row schemas and the batch limit", async () => {
  const f = fixture({ maxBatchSize: 2 });
  try {
    for (const input of [
      { items: [] },
      { items: [{ name: "a" }, { name: "b" }, { name: "c" }] },
      { items: [{ name: "a", owner: "hidden" }] },
    ])
      await expect(
        f.resource.bulkCreate.run(input as never),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.resource.bulkUpdate.run({ items: [{ id: 1, data: { id: 5 } }] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.resource.bulkDelete.run({ ids: [1, 1] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.names()).toEqual([]);
    expect(() => fixture({ maxBatchSize: 0 })).toThrow(
      "Invalid CRUD maxBatchSize",
    );
  } finally {
    f.sqlite.close();
  }
});

test("bulk operations are off unless enabled, and follow routes", () => {
  const f = fixture({ operations: {} });
  try {
    expect("bulkCreate" in f.resource).toBe(false);
    expect(typeof f.resource.create).toBe("function");
  } finally {
    f.sqlite.close();
  }
  const hidden = fixture({ routes: { bulkDelete: false } });
  try {
    const spec = generateOpenApiSpec({
      services: [hidden.service],
      prefix: "/api",
    });
    expect(Object.keys(spec.paths)).toContain(
      `/api/${hidden.service.name}/record/bulk-create`,
    );
    expect(Object.keys(spec.paths)).toContain(
      `/api/${hidden.service.name}/record/bulk-update`,
    );
    expect(Object.keys(spec.paths)).not.toContain(
      `/api/${hidden.service.name}/record/bulk-delete`,
    );
    expect(typeof hidden.resource.bulkDelete).toBe("function");
  } finally {
    hidden.sqlite.close();
  }
});

test("the typed client calls bulk operations over HTTP", async () => {
  const f = fixture();
  const app = brick({
    services: [f.service],
    docs: false,
    requestLogging: false,
  });
  const client = createBrickClient<{ record: typeof f.resource }>({
    baseUrl: "http://localhost",
    contract: clientContract(app).contract[f.service.name],
    fetch: async (url, init) => app.handle(new Request(String(url), init)),
  });
  try {
    expect(
      await client.record.bulkCreate({ items: [{ name: "a" }, { name: "b" }] }),
    ).toEqual({
      items: [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    });
    expect(
      await client.record.bulkUpdate({
        items: [{ id: 2, data: { name: "c" } }],
      }),
    ).toEqual({ items: [{ id: 2, name: "c" }] });
    expect(await client.record.bulkDelete({ ids: [1, 2] })).toEqual({
      count: 2,
    });
    expect(f.names()).toEqual([]);
  } finally {
    f.sqlite.close();
  }
});

test("a parent and its child rows commit or roll back together", async () => {
  const committed: unknown[] = [];
  const f = fixture({
    hooks: { afterCommit: ({ id }) => void committed.push(id) },
  });
  const notes: any = f.service
    .resource({ name: "child", table: audit, id: audit.id })
    .use(
      crud({
        access: "public",
        fields: { id: { read: true }, note: { read: true, create: true } },
        operations: { bulkCreate: true },
      }),
    );
  const save = (name: string, children: string[]) =>
    runInTransaction(f.db, async (tx) => {
      const joined = { db: tx };
      const parent = await f.resource.create.run({ name }, joined);
      await notes.bulkCreate.run(
        { items: children.map((note) => ({ note: `${parent.id}:${note}` })) },
        joined,
      );
      expect(committed).toEqual([]);
      return parent;
    });
  try {
    await save("a", ["x", "y"]);
    expect(committed).toEqual([1]);
    // A failing parent keeps no children; failing children keep no parent.
    await expect(save("a", ["z"])).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(save("c", [])).rejects.toMatchObject({ status: 400 });
    expect(f.names()).toEqual(["a"]);
    expect(f.notesWritten()).toEqual(["1:x", "1:y"]);
    expect(committed).toEqual([1]);
  } finally {
    f.sqlite.close();
  }
});
