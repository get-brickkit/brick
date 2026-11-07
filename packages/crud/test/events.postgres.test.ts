import { afterAll, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  brick,
  defineDatabase,
  defineListener,
  defineService,
  outboxTable,
  type EventDelivery,
} from "@brickkit/core";
import { asc } from "drizzle-orm";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { crud } from "../src";
import { suite, url } from "./postgres";

const databases: { close?(): void | Promise<void> }[] = [];
afterAll(async () => {
  await Promise.all(databases.map((database) => database.close?.()));
});

let serial_ = 0;

async function fixture() {
  const suffix = `${Date.now().toString(36)}_${++serial_}_${randomUUID().slice(0, 6)}`;
  const tableName = `people_${suffix}`;
  const outboxName = `outbox_${suffix}`;
  const people = pgTable(tableName, {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email"),
    secret: text("secret"),
  });
  const outbox = outboxTable("postgres", { name: outboxName });
  const database = defineDatabase({
    engine: "postgres",
    url,
    max: 10,
    tables: { [tableName]: people, [outboxName]: outbox },
  });
  databases.push(database);
  const db: any = database.getDb();
  await db.$client.unsafe(`
    CREATE TABLE ${tableName} (id serial PRIMARY KEY, name text NOT NULL, email text, secret text);
    CREATE TABLE ${outboxName} (
      seq bigserial PRIMARY KEY, id text NOT NULL UNIQUE, event_id text NOT NULL,
      listener text NOT NULL, name text NOT NULL, payload jsonb NOT NULL,
      trace_id text, source text, occurred_at timestamptz NOT NULL, status text NOT NULL,
      attempts integer NOT NULL DEFAULT 0, last_error text,
      available_at timestamptz NOT NULL, claimed_at timestamptz, delivered_at timestamptz
    );`);
  const service = defineService(`crud_events_pg_${suffix}`, { database });
  const resource: any = service
    .resource({ name: "person", table: people, id: people.id })
    .use(
      crud({
        access: "public",
        fields: {
          id: { read: true },
          name: { read: true, create: true, update: true },
          email: { read: true, create: true, update: true },
          secret: { create: true },
        },
      }),
    );
  const seen: EventDelivery[] = [];
  const app = brick({
    services: [service],
    events: {
      listeners: [
        defineListener({
          name: "recorder",
          on: "person.*",
          run: (d) => void seen.push(d),
        }),
      ],
      dispatch: { timer: false },
    },
    requestLogging: false,
    docs: false,
  });
  return { resource, app, db, people, outbox, seen };
}

suite("generated writes emit events on Postgres", () => {
  it("emits create, update and delete in the write's transaction", async () => {
    const { resource, app, seen, db, outbox } = await fixture();
    const created = await resource.create.run({
      name: "Ada",
      email: "a@x",
      secret: "s",
    });
    await resource.update.run({ id: created.id, data: { email: "b@x" } });
    await resource.delete.run({ id: created.id });

    expect(await db.select().from(outbox)).toHaveLength(3);
    await app.events!.drain();
    const byName = Object.fromEntries(
      seen.map((event) => [event.name, event.payload]),
    );
    expect(byName["person.create"]).toEqual({
      id: created.id,
      row: { id: created.id, name: "Ada", email: "a@x" },
    });
    expect(byName["person.update"]).toEqual({
      id: created.id,
      before: { id: created.id, name: "Ada", email: "a@x" },
      after: { id: created.id, name: "Ada", email: "b@x" },
    });
    expect(byName["person.delete"]).toEqual({
      id: created.id,
      row: { id: created.id, name: "Ada", email: "b@x" },
    });
    expect(JSON.stringify(seen)).not.toContain('"secret"');
  });

  it("records no event for a write that fails", async () => {
    const { resource, db, outbox, people } = await fixture();
    await expect(
      resource.update.run({ id: 999, data: { name: "Nobody" } }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(resource.delete.run({ id: 999 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await db.select().from(outbox)).toHaveLength(0);
    expect(await db.select().from(people)).toHaveLength(0);
  });

  it("chains before and after across concurrent updates of one row", async () => {
    const { resource, db, outbox } = await fixture();
    const created = await resource.create.run({ name: "Ada", email: "v0" });
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        resource.update.run({
          id: created.id,
          data: { email: `v${index + 1}` },
        }),
      ),
    );

    const events = (
      await db.select().from(outbox).orderBy(asc(outbox.seq))
    ).filter((row: any) => row.name === "person.update");
    expect(events).toHaveLength(10);
    expect(events[0].payload.before.email).toBe("v0");
    for (let index = 1; index < events.length; index++)
      expect(events[index].payload.before.email).toBe(
        events[index - 1].payload.after.email,
      );
  });

  it("records every event of many concurrent creates", async () => {
    const { resource, db, outbox, people } = await fixture();
    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        resource.create.run({ name: `person ${index}` }),
      ),
    );
    expect(await db.select().from(people)).toHaveLength(30);
    expect(await db.select().from(outbox)).toHaveLength(30);
  });
});
