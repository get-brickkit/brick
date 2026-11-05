import { afterAll, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { defineDatabase, defineService } from "@brickkit/core";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { crud } from "../src";
import { suite, url } from "./postgres";

const databases: { close?(): void | Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close?.()));
});

async function fixture() {
  const suffix = `${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  const people = pgTable(`tx_people_${suffix}`, {
    id: serial("id").primaryKey(),
    name: text("name").notNull().unique(),
  });
  const notes = pgTable(`tx_notes_${suffix}`, {
    id: serial("id").primaryKey(),
    note: text("note").notNull(),
  });
  const database = defineDatabase({
    engine: "postgres",
    url,
    tables: { people, notes },
  });
  databases.push(database);
  const db: any = database.getDb();
  await db.$client.unsafe(`
    CREATE TABLE tx_people_${suffix} (id serial PRIMARY KEY, name text NOT NULL UNIQUE);
    CREATE TABLE tx_notes_${suffix} (id serial PRIMARY KEY, note text NOT NULL);`);
  const service = defineService(`crud_tx_pg_${suffix}`, { database });
  const note: any = service
    .resource({ name: "note", table: notes, id: notes.id })
    .use(
      crud({
        access: "public",
        fields: { id: { read: true }, note: { read: true, create: true } },
        hooks: { beforeCreate: () => {} },
      }),
    );
  const committed: unknown[] = [];
  const person: any = service
    .resource({ name: "person", table: people, id: people.id })
    .use(
      crud({
        access: "public",
        fields: { id: { read: true }, name: { read: true, create: true } },
        operations: { bulkCreate: true },
        hooks: {
          afterCreate: async ({ row, tx, ctx }) => {
            await note.create.run(
              { note: `made ${row.name}` },
              { ...ctx, db: tx },
            );
            if (row.name === "bad") throw new Error("hook failed");
          },
          afterCommit: ({ id }) => void committed.push(id),
        },
      }),
    );
  const names = async () =>
    (await db.select().from(people)).map((row: any) => row.name).sort();
  const written = async () =>
    (await db.select().from(notes)).map((row: any) => row.note).sort();
  return { person, names, written, committed };
}

suite("crud transactions on postgres", () => {
  it("commits a hook's nested write with the row, or rolls both back", async () => {
    const f = await fixture();
    await f.person.create.run({ name: "a" });
    await expect(f.person.create.run({ name: "bad" })).rejects.toMatchObject({
      status: 500,
    });
    expect(await f.names()).toEqual(["a"]);
    expect(await f.written()).toEqual(["made a"]);
    expect(f.committed).toEqual([1]);
  });

  it("rolls a whole bulk create back when one item fails", async () => {
    const f = await fixture();
    await expect(
      f.person.bulkCreate.run({ items: [{ name: "x" }, { name: "bad" }] }),
    ).rejects.toMatchObject({ status: 500 });
    await expect(
      f.person.bulkCreate.run({ items: [{ name: "y" }, { name: "y" }] }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { index: 1 } });
    expect(await f.names()).toEqual([]);
    expect(await f.written()).toEqual([]);
    expect(f.committed).toEqual([]);
    expect(
      await f.person.bulkCreate.run({ items: [{ name: "p" }, { name: "q" }] }),
    ).toMatchObject({ items: [{ name: "p" }, { name: "q" }] });
    expect(await f.written()).toEqual(["made p", "made q"]);
    expect(f.committed).toHaveLength(2);
  });
});
