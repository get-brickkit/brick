import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import {
  brick as createApp,
  defineDatabase,
  defineService,
  getTableName,
  sqliteTable,
  text,
} from "@brickkit/core";
import { appDatabases } from "../src/db";
import app from "./fixtures/db-app";

const cli = resolve(import.meta.dir, "../src/bin.ts");
const entry = join(import.meta.dir, "fixtures/db-app.ts");
const roots: string[] = [];
afterAll(() =>
  Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))),
);

async function tempRoot() {
  const root = await mkdtemp(resolve(import.meta.dir, "../.brick-db-test-"));
  roots.push(root);
  return root;
}

async function brick(args: string[], env: Record<string, string | undefined>) {
  const child = Bun.spawn([process.execPath, cli, "db", ...args, entry], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, BRICK_DB_V2: undefined, ...env },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out: stdout + stderr };
}

describe("brick db: table discovery", () => {
  it("finds declared, resource, plugin and outbox tables per database", () => {
    const [found, ...rest] = appDatabases(app);
    expect(rest).toEqual([]);
    expect(found.name).toBe("notes");
    expect(found.tables.map((table) => getTableName(table)).sort()).toEqual([
      "brick_outbox",
      "notes",
      "tag_audit_log",
      "tags",
    ]);
  });

  it("refuses two databases with one name, which would share a migrations folder", () => {
    const service = (name: string) =>
      defineService(name, {
        database: defineDatabase({
          name: "main",
          path: ":memory:",
          tables: { t: sqliteTable(name, { id: text("id").primaryKey() }) },
        }),
      });
    expect(() =>
      appDatabases(
        createApp({
          services: [service("a"), service("b")],
          requestLogging: false,
        }),
      ),
    ).toThrow('two databases are named "main"');
  });

  it("lists the db commands in help", async () => {
    const child = Bun.spawn([process.execPath, cli, "db", "--help"], {
      stdout: "pipe",
    });
    const help = await new Response(child.stdout).text();
    for (const command of ["generate", "migrate", "push"])
      expect(help).toContain(command);
  });
});

describe("brick db on SQLite", () => {
  it("generates, migrates, and generates only the change next time", async () => {
    const root = await tempRoot();
    const out = join(root, "drizzle");
    const notes = join(out, "notes");
    const env = { BRICK_DB_FILE: join(root, "app.db") };
    expect((await brick(["generate", "--out", out], env)).code).toBe(0);
    const first = await readFile(join(notes, "0000_migration.sql"), "utf8");
    for (const table of ["notes", "tags", "tag_audit_log", "brick_outbox"])
      expect(first).toContain(`CREATE TABLE \`${table}\``);
    expect((await brick(["migrate", "--out", out], env)).code).toBe(0);

    const v2 = { ...env, BRICK_DB_V2: "1" };
    const second = await brick(
      ["generate", "--out", out, "--name", "add_title"],
      v2,
    );
    expect(second.out).toContain("0001_add_title.sql");
    expect(await readFile(join(notes, "0001_add_title.sql"), "utf8")).toBe(
      "ALTER TABLE `notes` ADD `title` text;",
    );
    expect((await brick(["migrate", "--out", out], v2)).code).toBe(0);
    expect((await brick(["generate", "--out", out], v2)).out).toContain(
      "no schema changes",
    );
    expect((await readdir(join(notes, "meta"))).sort()).toEqual([
      "0000_snapshot.json",
      "0001_snapshot.json",
      "_journal.json",
    ]);
    const db = new Database(env.BRICK_DB_FILE);
    db.run("INSERT INTO notes (id, body, title) VALUES ('1', 'b', 't')");
    db.close();
  });

  it("keeps a database's migrations folder when the app gains a second database", async () => {
    const root = await tempRoot();
    const out = join(root, "drizzle");
    const env = { BRICK_DB_FILE: join(root, "app.db") };
    expect((await brick(["generate", "--out", out], env)).out).toContain(
      join(out, "notes", "0000_migration.sql"),
    );
    const both = await brick(["generate", "--out", out], {
      ...env,
      BRICK_DB_BILLING: join(root, "billing.db"),
    });
    expect(both.out).toContain("notes (sqlite): no schema changes");
    expect(both.out).toContain(join(out, "billing", "0000_migration.sql"));
  });

  it("refuses to migrate without migrations", async () => {
    const root = await tempRoot();
    const result = await brick(["migrate", "--out", join(root, "none")], {
      BRICK_DB_FILE: join(root, "app.db"),
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain("run `brick db generate` first");
  });

  it("pushes changes, leaves unknown tables alone, and needs --force to drop data", async () => {
    const root = await tempRoot();
    const file = join(root, "app.db");
    const db = new Database(file);
    db.run("CREATE TABLE other (id INTEGER PRIMARY KEY)");
    db.run("INSERT INTO other VALUES (1)");
    db.run("CREATE VIRTUAL TABLE notes_fts USING fts5(body)");
    const env = { BRICK_DB_FILE: file };
    // push writes no files, so it takes no --out.
    expect((await brick(["push", "--out", root], env)).out).toContain(
      "unknown option '--out'",
    );
    expect((await brick(["push"], env)).out).toContain("applied");
    expect((await brick(["push"], { ...env, BRICK_DB_V2: "1" })).code).toBe(0);
    db.run("INSERT INTO notes VALUES ('1', 'b', 't')");
    // Back to v1 drops the title column.
    const refused = await brick(["push"], env);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("--force");
    expect((await brick(["push", "--force"], env)).code).toBe(0);
    expect(db.query("SELECT * FROM notes").all()).toEqual([
      { id: "1", body: "b" },
    ]);
    expect(db.query("SELECT * FROM other").all()).toEqual([{ id: 1 }]);
    db.query("SELECT * FROM notes_fts").all();
    db.close();
  });
});

const url = process.env.TEST_DATABASE_URL;
// describe.skip still runs this body, so it must not connect without a URL.
(url ? describe : describe.skip)("brick db on Postgres", () => {
  const name = `brick_db_${randomUUID().slice(0, 8)}`;
  const admin = new SQL(url ?? "postgres://localhost/unused");
  const target = new URL(url ?? "postgres://localhost/unused");
  target.pathname = `/${name}`;
  const env = { BRICK_DB_URL: target.href };
  afterAll(async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.close();
  });

  it("generates, migrates and pushes against a real database", async () => {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const root = await tempRoot();
    const out = join(root, "drizzle");
    expect((await brick(["generate", "--out", out], env)).code).toBe(0);
    const first = await readFile(
      join(out, "notes", "0000_migration.sql"),
      "utf8",
    );
    for (const table of ["notes", "tags", "tag_audit_log", "brick_outbox"])
      expect(first).toContain(`CREATE TABLE "${table}"`);
    const migrated = await brick(["migrate", "--out", out], env);
    expect(migrated.out).toContain("applied");

    const db = new SQL(target.href);
    try {
      await db.unsafe(`CREATE TABLE other (id int PRIMARY KEY)`);
      const v2 = { ...env, BRICK_DB_V2: "1" };
      expect((await brick(["push"], v2)).out).toContain("applied 1 change");
      await db.unsafe(`INSERT INTO notes VALUES ('1', 'b', 't')`);
      expect((await brick(["push"], env)).code).toBe(1);
      expect((await brick(["push", "--force"], env)).code).toBe(0);
      expect(await db.unsafe(`SELECT * FROM notes`)).toEqual([
        { id: "1", body: "b" },
      ]);
      // A table the app does not know survives push.
      expect(await db.unsafe(`SELECT to_regclass('other') AS t`)).toEqual([
        { t: "other" },
      ]);
    } finally {
      await db.close();
    }
  });
});
