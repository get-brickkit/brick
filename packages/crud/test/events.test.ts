import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
  brick,
  defineDatabase,
  defineListener,
  defineService,
  outboxTable,
  syncSchema,
  type EventDelivery,
} from "@brickkit/core";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { crud } from "../src";

const people = sqliteTable("people", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  email: text("email"),
  owner: text("owner"),
  secret: text("secret"),
});
const outbox = outboxTable("sqlite");

let serial = 0;
const stoppers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
});

interface FixtureOptions {
  crud?: Partial<Parameters<typeof crud>[0]>;
  on?: string[];
  events?: boolean;
  withOutbox?: boolean;
}

function fixture(options: FixtureOptions = {}) {
  const database = defineDatabase({
    tables: options.withOutbox === false ? { people } : { people, outbox },
  });
  const db: any = database.getDb();
  const sqlite: Database = db.$client;
  syncSchema([people, outbox], db);
  const service = defineService(`crud_events_${++serial}`, { database });
  const resource: any = service
    .resource({ name: "person", table: people, id: people.id })
    .use(
      crud({
        access: "public",
        fields: {
          id: { read: true, filter: ["eq"] },
          name: { read: true, create: true, update: true },
          email: { read: true, create: true, update: true },
          owner: { read: true, create: true, update: true },
          secret: { create: true, update: true },
        },
        ...options.crud,
      } as Parameters<typeof crud>[0]),
    );
  const seen: EventDelivery[] = [];
  const app =
    options.events === false
      ? undefined
      : brick({
          services: [service],
          events: {
            listeners: [
              defineListener({
                name: "recorder",
                on: options.on ?? ["person.*"],
                run: (delivery) => void seen.push(delivery),
              }),
            ],
            dispatch: { timer: false },
          },
          requestLogging: false,
          docs: false,
        });
  if (app?.events) stoppers.push(() => app.events!.stop());
  const outboxRows = () => db.select().from(outbox).all();
  return { resource, service, db, sqlite, app, seen, outboxRows };
}

describe("generated writes emit events", () => {
  it("emits person.create with the readable fields only", async () => {
    const { resource, app, seen, outboxRows } = fixture();
    const created = await resource.create.run(
      { name: "Ada", email: "ada@example.com", owner: "u1", secret: "hunter2" },
      { traceId: "tr_create" },
    );
    expect(created).toEqual({
      id: 1,
      name: "Ada",
      email: "ada@example.com",
      owner: "u1",
    });

    expect(outboxRows()).toHaveLength(1);
    expect(outboxRows()[0]).toMatchObject({
      name: "person.create",
      traceId: "tr_create",
      status: "pending",
    });
    expect(JSON.stringify(outboxRows()[0].payload)).not.toContain("hunter2");

    await app!.events!.drain();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      name: "person.create",
      payload: {
        id: 1,
        row: { id: 1, name: "Ada", email: "ada@example.com", owner: "u1" },
      },
      source: expect.stringMatching(/^crud_events_\d+\.person$/),
      traceId: "tr_create",
      listener: "recorder",
    });
  });

  it("emits person.update with the row before and after", async () => {
    const { resource, app, seen } = fixture();
    await resource.create.run({ name: "Ada", email: "old@example.com" });
    await app!.events!.drain();
    seen.length = 0;

    const updated = await resource.update.run({
      id: 1,
      data: { email: "new@example.com" },
    });
    expect(updated).toMatchObject({ id: 1, email: "new@example.com" });
    await app!.events!.drain();

    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe("person.update");
    expect(seen[0].payload).toEqual({
      id: 1,
      before: { id: 1, name: "Ada", email: "old@example.com", owner: null },
      after: { id: 1, name: "Ada", email: "new@example.com", owner: null },
    });
  });

  it("keeps before and after right across repeated updates", async () => {
    const { resource, app, seen } = fixture();
    await resource.create.run({ name: "Ada", email: "v0" });
    for (const version of ["v1", "v2", "v3"])
      await resource.update.run({ id: 1, data: { email: version } });
    await app!.events!.drain();
    const updates = seen.filter((event) => event.name === "person.update");
    expect(
      updates.map((event) => [
        (event.payload as any).before.email,
        (event.payload as any).after.email,
      ]),
    ).toEqual([
      ["v0", "v1"],
      ["v1", "v2"],
      ["v2", "v3"],
    ]);
  });

  it("emits person.delete with the row that was removed", async () => {
    const { resource, app, seen } = fixture();
    await resource.create.run({ name: "Ada", email: "ada@example.com" });
    await app!.events!.drain();
    seen.length = 0;

    expect(await resource.delete.run({ id: 1 })).toEqual({ success: true });
    await app!.events!.drain();

    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe("person.delete");
    expect(seen[0].payload).toEqual({
      id: 1,
      row: { id: 1, name: "Ada", email: "ada@example.com", owner: null },
    });
  });
});

describe("what does not emit", () => {
  it("reads emit nothing", async () => {
    const { resource, outboxRows } = fixture();
    await resource.create.run({ name: "Ada" });
    const before = outboxRows().length;
    await resource.get.run({ id: 1 });
    await resource.list.run({});
    await resource.findOne.run({});
    await resource.count.run({});
    await resource.exists.run({ where: { field: "id", op: "eq", value: 1 } });
    expect(outboxRows()).toHaveLength(before);
  });

  it("a write that fails records no event and leaves no row", async () => {
    const { resource, db, outboxRows } = fixture();
    await resource.create.run({ name: "Ada" });
    expect(outboxRows()).toHaveLength(1);

    await expect(resource.create.run({ name: "Ada" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(outboxRows()).toHaveLength(1);
    expect(db.select().from(people).all()).toHaveLength(1);
  });

  it("a hook that refuses the write records no event", async () => {
    const { resource, db, outboxRows } = fixture({
      crud: {
        hooks: {
          beforeCreate: () => {
            throw new Error("not today");
          },
        },
      },
    });
    await expect(resource.create.run({ name: "Ada" })).rejects.toThrow();
    expect(db.select().from(people).all()).toHaveLength(0);
    expect(outboxRows()).toHaveLength(0);
  });

  it("updating or deleting a row that is not there records no event", async () => {
    const { resource, outboxRows } = fixture();
    await expect(
      resource.update.run({ id: 99, data: { name: "Nobody" } }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(resource.delete.run({ id: 99 })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(outboxRows()).toHaveLength(0);
  });

  it("nothing is recorded for an event no listener wants", async () => {
    const { resource, db, outboxRows } = fixture({ on: ["person.delete"] });
    await resource.create.run({ name: "Ada" });
    await resource.update.run({ id: 1, data: { name: "Ada L" } });
    expect(db.select().from(people).all()).toHaveLength(1);
    expect(outboxRows()).toHaveLength(0);
    await resource.delete.run({ id: 1 });
    expect(outboxRows()).toHaveLength(1);
  });

  it("a resource can opt out with events: false", async () => {
    const { resource, outboxRows } = fixture({ crud: { events: false } });
    await resource.create.run({ name: "Ada" });
    await resource.update.run({ id: 1, data: { name: "Ada L" } });
    await resource.delete.run({ id: 1 });
    expect(outboxRows()).toHaveLength(0);
  });
});

describe("an app without events", () => {
  it("behaves exactly as before, even with an outbox table in the database", async () => {
    const { resource, db, outboxRows } = fixture({ events: false });
    const created = await resource.create.run({ name: "Ada", email: "a@x" });
    await resource.update.run({ id: created.id, data: { email: "b@x" } });
    await resource.delete.run({ id: created.id });
    expect(db.select().from(people).all()).toHaveLength(0);
    expect(outboxRows()).toHaveLength(0);
  });

  it("still writes when events are set but the database has no outbox table", async () => {
    const { resource, db } = fixture({ withOutbox: false });
    await resource.create.run({ name: "Ada" });
    await resource.update.run({ id: 1, data: { name: "Ada L" } });
    expect(db.select().from(people).all()).toHaveLength(1);
  });
});

describe("with row scopes", () => {
  const scoped = () =>
    fixture({
      crud: {
        access: {
          authorize: () => true,
          scope: ({ operation, ctx }: any) =>
            operation === "create" ? undefined : eq(people.owner, ctx.user.id),
        },
      },
    });
  const as = (id: string) => ({ user: { id } });

  it("emits for a row the caller owns, with the before row from inside the scope", async () => {
    const { resource, db, app, seen } = scoped();
    db.insert(people).values({ name: "Ada", owner: "u1", email: "old" }).run();
    await resource.update.run({ id: 1, data: { email: "new" } }, as("u1"));
    await app!.events!.drain();
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toMatchObject({
      before: { email: "old", owner: "u1" },
      after: { email: "new", owner: "u1" },
    });
  });

  it("emits nothing when the row is outside the caller's scope", async () => {
    const { resource, db, outboxRows } = scoped();
    db.insert(people).values({ name: "Ada", owner: "u1", email: "old" }).run();
    await expect(
      resource.update.run({ id: 1, data: { email: "hijacked" } }, as("u2")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      resource.delete.run({ id: 1 }, as("u2")),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(db.select().from(people).all()[0].email).toBe("old");
    expect(outboxRows()).toHaveLength(0);
  });
});

describe("sequences", () => {
  it("delivers a create, an update and a delete in the order they happened", async () => {
    const { resource, app, seen } = fixture();
    await resource.create.run({ name: "Ada" });
    await resource.update.run({ id: 1, data: { name: "Ada L" } });
    await resource.delete.run({ id: 1 });
    await app!.events!.drain();
    expect(seen.map((event) => event.name)).toEqual([
      "person.create",
      "person.update",
      "person.delete",
    ]);
    expect(await app!.events!.counts()).toEqual({
      pending: 0,
      claimed: 0,
      delivered: 3,
      dead: 0,
    });
  });

  it("records every event of many concurrent writes", async () => {
    const { resource, outboxRows, db } = fixture();
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        resource.create.run({ name: `person ${index}` }),
      ),
    );
    expect(db.select().from(people).all()).toHaveLength(25);
    expect(outboxRows()).toHaveLength(25);
    expect(new Set(outboxRows().map((row: any) => row.eventId)).size).toBe(25);
  });
});
