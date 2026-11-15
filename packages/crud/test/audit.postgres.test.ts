import { afterAll, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { auditTable, defineDatabase, defineService } from "@brickkit/core";
import { asc } from "drizzle-orm";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { crud } from "../src";
import { suite, url } from "./postgres";

const databases: { getDb(): any; close?(): void | Promise<void> }[] = [];
const dropped: string[] = [];
afterAll(async () => {
  if (dropped.length)
    await databases[0]!
      .getDb()
      .$client.unsafe(`DROP TABLE IF EXISTS ${dropped.join(", ")} CASCADE`);
  await Promise.all(databases.map((database) => database.close?.()));
});

let serial_ = 0;

async function fixture() {
  const suffix = `${Date.now().toString(36)}_${++serial_}_${randomUUID().slice(0, 6)}`;
  const tableName = `people_${suffix}`;
  const auditName = `audit_${suffix}`;
  const people = pgTable(tableName, {
    id: serial("id").primaryKey(),
    name: text("name").notNull().unique(),
  });
  const auditLog = auditTable("postgres", { name: auditName });
  const database = defineDatabase({
    engine: "postgres",
    url,
    max: 10,
    tables: { [tableName]: people, [auditName]: auditLog },
  });
  databases.push(database);
  const db: any = database.getDb();
  await db.$client.unsafe(`
    CREATE TABLE ${tableName} (id serial PRIMARY KEY, name text NOT NULL UNIQUE);
    CREATE TABLE ${auditName} (
      seq bigserial PRIMARY KEY, id text NOT NULL UNIQUE, at timestamptz NOT NULL,
      service text NOT NULL, action text NOT NULL, resource text, record_id text,
      actor_id text, actor_label text, tenant text, trace_id text, request_id text,
      meta jsonb
    );`);
  dropped.push(tableName, auditName);
  const service = defineService(`crud_audit_pg_${suffix}`, {
    database,
    context: ({ request }) => ({ session: request.headers.get("x-session") }),
    identity: (ctx) =>
      ctx.session ? { id: ctx.session, tenant: "acme" } : null,
  });
  const resource: any = service
    .resource({ name: "person", table: people, id: people.id })
    .use(
      crud({
        access: "public",
        fields: {
          id: { read: true },
          name: { read: true, create: true, update: true },
        },
        operations: { bulkCreate: true, bulkUpdate: true, bulkDelete: true },
      }),
    );
  return {
    resource,
    auditName,
    db,
    rows: (): Promise<any[]> =>
      db.select().from(auditLog).orderBy(asc(auditLog.seq)),
    names: async (): Promise<string[]> =>
      (await db.select().from(people)).map((row: any) => row.name),
  };
}

const as = (session: string) => ({
  request: new Request("http://localhost", {
    headers: { "x-session": session },
  }),
});

suite("CRUD writes are recorded on Postgres", () => {
  it("records create, update and delete, and one row per record of a bulk write", async () => {
    const { resource, rows } = await fixture();
    const created = await resource.create.run({ name: "Ada" }, as("u1"));
    await resource.update.run(
      { id: created.id, data: { name: "Ada L." } },
      as("u1"),
    );
    await resource.delete.run({ id: created.id }, as("u1"));
    await resource.bulkCreate.run(
      { items: [{ name: "a" }, { name: "b" }] },
      as("u1"),
    );
    expect(
      (await rows()).map((row) => [row.action, row.resource, row.actorId]),
    ).toEqual([
      ["person.create", "person", "u1"],
      ["person.update", "person", "u1"],
      ["person.delete", "person", "u1"],
      ["person.create", "person", "u1"],
      ["person.create", "person", "u1"],
    ]);
    expect((await rows())[0]).toMatchObject({
      recordId: String(created.id),
      tenant: "acme",
      meta: null,
    });
  });

  it("keeps neither the write nor its row when the commit fails after the audit insert", async () => {
    const { resource, rows, names, db, auditName } = await fixture();
    const guard = auditName.replace("audit_", "guard_");
    await db.$client.unsafe(`
      CREATE TABLE ${guard}_parent (id int PRIMARY KEY);
      CREATE TABLE ${guard} (v int REFERENCES ${guard}_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION ${guard}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${guard} VALUES (999); RETURN NEW; END $$;
      CREATE TRIGGER ${guard}_trg AFTER INSERT ON ${auditName} FOR EACH ROW EXECUTE FUNCTION ${guard}_fn();`);
    dropped.push(`${guard}, ${guard}_parent`);
    await expect(
      resource.create.run({ name: "a" }, as("u1")),
    ).rejects.toThrow();
    await expect(
      resource.bulkCreate.run(
        { items: [{ name: "b" }, { name: "c" }] },
        as("u1"),
      ),
    ).rejects.toThrow();
    expect(await names()).toEqual([]);
    expect(await rows()).toEqual([]);
    await db.$client.unsafe(`DROP FUNCTION ${guard}_fn() CASCADE`);
  });

  it("keeps no row of a bulk write that fails on a later item, nor the earlier items", async () => {
    const { resource, rows, names } = await fixture();
    await resource.create.run({ name: "taken" }, as("u1"));
    await expect(
      resource.bulkCreate.run(
        { items: [{ name: "fresh" }, { name: "taken" }] },
        as("u1"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await names()).toEqual(["taken"]);
    expect(await rows()).toHaveLength(1);
  });
});
