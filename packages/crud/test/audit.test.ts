import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import {
  auditTable,
  brick,
  defineDatabase,
  defineService,
  resetGlobalRegistry,
  syncSchema,
} from "@brickkit/core";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { crud } from "../src";

const people = sqliteTable("people", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  secret: text("secret"),
});
const auditLog = auditTable("sqlite");

beforeEach(resetGlobalRegistry);

let serial = 0;
function fixture(options: { table?: boolean; hooks?: object } = {}) {
  const { table = true } = options;
  const database = defineDatabase({
    tables: table ? { people, auditLog } : { people },
  });
  const db: any = database.getDb();
  syncSchema(table ? [people, auditLog] : [people], db);
  const service = defineService(`crud_audit_${++serial}`, {
    database,
    context: ({ request }) => ({ session: request.headers.get("x-session") }),
    identity: (ctx) =>
      ctx.session
        ? { id: ctx.session, label: `${ctx.session}@x`, tenant: "acme" }
        : null,
  });
  const resource: any = service
    .resource({ name: "person", table: people, id: people.id })
    .use(
      crud({
        access: "public",
        fields: {
          id: { read: true },
          name: { read: true, create: true, update: true },
          secret: { create: true, update: true },
        },
        operations: { bulkCreate: true, bulkUpdate: true, bulkDelete: true },
        ...options.hooks,
      } as Parameters<typeof crud>[0]),
    );
  const sqlite: Database = db.$client;
  return {
    database,
    db,
    sqlite,
    service,
    resource,
    rows: (): any[] => db.select().from(auditLog).orderBy(auditLog.seq).all(),
    names: (): string[] =>
      db
        .select()
        .from(people)
        .all()
        .map((row: any) => row.name),
  };
}

const as = (session?: string, extra: object = {}) => ({
  request: new Request("http://localhost", {
    headers: session ? { "x-session": session } : {},
  }),
  ...extra,
});

/** Makes every insert into the audit table fail at COMMIT, after the insert itself succeeded. */
function failAtCommit(sqlite: Database) {
  sqlite.run("PRAGMA foreign_keys = ON");
  sqlite.run("CREATE TABLE guard_parent (id INTEGER PRIMARY KEY)");
  sqlite.run(
    "CREATE TABLE guard (v INTEGER REFERENCES guard_parent(id) DEFERRABLE INITIALLY DEFERRED)",
  );
  sqlite.run(
    "CREATE TRIGGER guard_audit AFTER INSERT ON brick_audit BEGIN INSERT INTO guard (v) VALUES (999); END",
  );
}

describe("CRUD writes are recorded", () => {
  it("over HTTP: create, update and delete, each with its record", async () => {
    const { service, rows } = fixture();
    const app = brick({ services: [service], requestLogging: false });
    const call = (method: string, path: string, body?: unknown) =>
      app.handle(
        new Request(`http://localhost/api/${service.name}/person${path}`, {
          method,
          headers: {
            "content-type": "application/json",
            "x-session": "u1",
            "x-trace-id": "tr_crud",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    expect((await call("POST", "", { name: "Ada" })).status).toBe(200);
    expect(
      (await call("PATCH", "/1", { data: { name: "Ada L." } })).status,
    ).toBe(200);
    expect((await call("DELETE", "/1")).status).toBe(200);
    // Reads leave no row.
    await call("POST", "/query", {});
    await call("POST", "/count", {});
    await call("POST", "/find-one", {});
    await call("POST", "/exists", {});
    await call("GET", "/1");
    expect(
      rows().map((row) => [row.action, row.resource, row.recordId]),
    ).toEqual([
      ["person.create", "person", "1"],
      ["person.update", "person", "1"],
      ["person.delete", "person", "1"],
    ]);
    expect(rows()[0]).toMatchObject({
      service: service.name,
      actorId: "u1",
      actorLabel: "u1@x",
      tenant: "acme",
      traceId: "tr_crud",
      meta: null,
    });
  });

  it("in process, as over HTTP, and null actor when anonymous", async () => {
    const { resource, rows } = fixture();
    await resource.create.run({ name: "Ada" }, as("u2"));
    await resource.update.run({ id: 1, data: { name: "B" } }, as());
    await resource.delete.run({ id: 1 }, as("u2"));
    expect(rows().map((row) => [row.action, row.actorId, row.tenant])).toEqual([
      ["person.create", "u2", "acme"],
      ["person.update", null, null],
      ["person.delete", "u2", "acme"],
    ]);
  });

  it("records one row per record of a bulk write, with the single operation's name", async () => {
    const { resource, rows } = fixture();
    await resource.bulkCreate.run(
      { items: [{ name: "a" }, { name: "b" }, { name: "c" }] },
      as("u1"),
    );
    await resource.bulkUpdate.run(
      {
        items: [
          { id: 1, data: { name: "a2" } },
          { id: 2, data: { name: "b2" } },
        ],
      },
      as("u1"),
    );
    await resource.bulkDelete.run({ ids: [1, 3] }, as("u1"));
    expect(rows().map((row) => `${row.action}:${row.recordId}`)).toEqual([
      "person.create:1",
      "person.create:2",
      "person.create:3",
      "person.update:1",
      "person.update:2",
      "person.delete:1",
      "person.delete:3",
    ]);
  });

  it("records a bulk call made over HTTP", async () => {
    const { service, rows } = fixture();
    const app = brick({ services: [service], requestLogging: false });
    const response = await app.handle(
      new Request(`http://localhost/api/${service.name}/person/bulk-create`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-session": "u1" },
        body: JSON.stringify({ items: [{ name: "a" }, { name: "b" }] }),
      }),
    );
    expect(response.status).toBe(200);
    expect(rows().map((row) => row.action)).toEqual([
      "person.create",
      "person.create",
    ]);
  });

  it("copies no row data into the log", async () => {
    const { resource, rows } = fixture();
    await resource.create.run({ name: "Visible", secret: "hunter2" }, as("u1"));
    await resource.update.run(
      { id: 1, data: { secret: "swordfish" } },
      as("u1"),
    );
    const text = JSON.stringify(rows());
    for (const value of ["Visible", "hunter2", "swordfish"])
      expect(text).not.toContain(value);
    expect(rows().every((row) => row.meta === null)).toBe(true);
  });

  it("records a write a user hook of the resource made through the same call", async () => {
    const seen: string[] = [];
    const { resource, rows } = fixture({
      hooks: { hooks: { afterCreate: () => void seen.push("hook") } },
    });
    await resource.create.run({ name: "a" }, as("u1"));
    expect(seen).toEqual(["hook"]);
    expect(rows()).toHaveLength(1);
  });

  it("says in introspect() which operations are audited", () => {
    const { service } = fixture();
    const audited = Object.fromEntries(
      service.introspect().actions.map((a) => [a.name, a.audited]),
    );
    expect(audited).toMatchObject({
      "person.create": true,
      "person.update": true,
      "person.delete": true,
      "person.bulkCreate": true,
      "person.bulkUpdate": true,
      "person.bulkDelete": true,
      "person.list": undefined,
      "person.get": undefined,
      "person.count": undefined,
      "person.exists": undefined,
      "person.findOne": undefined,
    });
  });

  it("records each write once, however often the database is set", async () => {
    const { database, service, resource, rows } = fixture();
    (service as any).setDb(database);
    (service as any).setDb(database);
    await resource.create.run({ name: "Ada" }, as("u1"));
    expect(rows().map((row) => row.action)).toEqual(["person.create"]);
  });

  it("records nothing, and opens no transaction of its own, without the table", async () => {
    const { resource, sqlite } = fixture({ table: false });
    const statements: string[] = [];
    const run = sqlite.run.bind(sqlite);
    sqlite.run = ((query: string, ...rest: unknown[]) => {
      statements.push(String(query));
      return run(query, ...(rest as []));
    }) as typeof sqlite.run;
    await resource.create.run({ name: "a" }, as("u1"));
    expect(statements.filter((query) => query.startsWith("BEGIN"))).toEqual([]);
  });
});

describe("crud() over the audit table", () => {
  const over = (operations: object) => {
    const { service } = fixture();
    return () =>
      service
        .resource({ name: "audit", table: auditLog, id: auditLog.seq })
        .use(
          crud({
            access: "public",
            fields: { seq: { read: true }, action: { read: true } },
            operations,
          } as Parameters<typeof crud>[0]),
        );
  };
  const readOnly = { create: false, update: false, delete: false };

  it("is refused with its default operations, naming the resource and how to make it read-only", () => {
    expect(over({})).toThrow(
      /'audit' is over the audit table.*read-only.*create: false, update: false, delete: false/,
    );
    expect(over({ update: false, delete: false })).toThrow("audit table");
  });

  it("is refused when a bulk write is turned on", () => {
    expect(over({ ...readOnly, bulkDelete: true })).toThrow("audit table");
  });

  it("is allowed, and reads, when every write is off", async () => {
    const { service, rows } = fixture();
    const audit: any = service
      .resource({ name: "audit", table: auditLog, id: auditLog.seq })
      .use(
        crud({
          access: "public",
          fields: { seq: { read: true }, action: { read: true } },
          operations: readOnly,
        } as Parameters<typeof crud>[0]),
      );
    expect(audit.create).toBeUndefined();
    expect(Object.keys(audit).filter((key) => key.startsWith("bulk"))).toEqual(
      [],
    );
    expect(rows()).toEqual([]);
    expect(await audit.list.run({}, as("u1"))).toMatchObject({ items: [] });
  });
});

describe("a plain action's row, beside a CRUD write", () => {
  it("survives the rollback of a CRUD write that was open when the action returned", async () => {
    let started!: () => void;
    const open = new Promise<void>((resolve) => (started = resolve));
    let fail!: () => void;
    const gate = new Promise<void>((_, reject) => (fail = reject));
    const { service, resource, rows } = fixture({
      hooks: {
        hooks: {
          beforeCreate: async () => {
            started();
            await gate;
          },
        },
      },
    });
    const touch = service.action({ name: "touch", execute: () => "ok" });
    const creating = resource.create
      .run({ name: "a" }, as("u1"))
      .catch(() => {});
    await open;
    const touching = touch.run(undefined, as("u1"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    fail();
    await Promise.all([creating, touching]);
    expect(rows().map((row) => row.action)).toEqual(["touch"]);
  });
});

describe("a CRUD write and its row commit or roll back together", () => {
  it("keeps neither when the write fails after the audit insert", async () => {
    const { resource, rows, names, sqlite } = fixture();
    failAtCommit(sqlite);
    await expect(
      resource.create.run({ name: "a" }, as("u1")),
    ).rejects.toThrow();
    expect(names()).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("keeps neither when the audit insert fails", async () => {
    const { resource, names, sqlite } = fixture();
    sqlite.run("DROP TABLE brick_audit");
    await expect(
      resource.create.run({ name: "a" }, as("u1")),
    ).rejects.toThrow();
    expect(names()).toEqual([]);
  });

  it("keeps no row of a write that fails before it", async () => {
    const { resource, rows } = fixture();
    await resource.create.run({ name: "taken" }, as("u1"));
    await expect(
      resource.create.run({ name: "taken" }, as("u1")),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      resource.update.run({ id: 99, data: { name: "x" } }, as("u1")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows().map((row) => row.action)).toEqual(["person.create"]);
  });

  it("keeps no row of a bulk write that fails on a later item, nor the earlier items", async () => {
    const { resource, rows, names } = fixture();
    await resource.create.run({ name: "taken" }, as("u1"));
    await expect(
      resource.bulkCreate.run(
        { items: [{ name: "fresh" }, { name: "taken" }] },
        as("u1"),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(names()).toEqual(["taken"]);
    expect(rows()).toHaveLength(1);
  });

  it("keeps neither of a bulk write when the commit fails", async () => {
    const { resource, rows, names, sqlite } = fixture();
    failAtCommit(sqlite);
    await expect(
      resource.bulkCreate.run(
        { items: [{ name: "a" }, { name: "b" }] },
        as("u1"),
      ),
    ).rejects.toThrow();
    expect(names()).toEqual([]);
    expect(rows()).toEqual([]);
  });
});
