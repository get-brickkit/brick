import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import {
  auditTable,
  defineDatabase,
  defineService,
  recordAudit,
  resetGlobalRegistry,
  runInTransaction,
  t,
} from "../src";
import { requireService } from "./helpers";

const url = requireService("TEST_DATABASE_URL", "audit.postgres");
const suite = url ? describe : describe.skip;

beforeEach(resetGlobalRegistry);

const databases: { close?(): void | Promise<void> }[] = [];
const created: string[] = [];
afterAll(async () => {
  const [first] = databases as any[];
  if (first)
    for (const sql of created.reverse())
      await first.getDb().$client.unsafe(sql);
  await Promise.all(databases.map((database) => database.close?.()));
});

let serial = 0;
async function setup() {
  const suffix = `${Date.now().toString(36)}_${++serial}_${randomUUID().slice(0, 6)}`;
  const ordersName = `orders_${suffix}`;
  const auditName = `audit_${suffix}`;
  const orders = pgTable(ordersName, {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
  });
  const auditLog = auditTable("postgres", { name: auditName });
  const database = defineDatabase({
    engine: "postgres",
    url,
    max: 5,
    tables: { [ordersName]: orders, [auditName]: auditLog },
  });
  databases.push(database);
  const db: any = database.getDb();
  const sql = (text: string) => db.$client.unsafe(text);
  await sql(`
    CREATE TABLE ${ordersName} (id text PRIMARY KEY, status text NOT NULL);
    CREATE TABLE ${auditName} (
      seq bigserial PRIMARY KEY, id text NOT NULL UNIQUE, at timestamptz NOT NULL,
      service text NOT NULL, action text NOT NULL, resource text, record_id text,
      actor_id text, actor_label text, tenant text, trace_id text, request_id text,
      meta jsonb
    );`);
  created.push(`DROP TABLE IF EXISTS ${ordersName}, ${auditName} CASCADE`);
  await sql(`INSERT INTO ${ordersName} VALUES ('o1', 'paid')`);
  const service = defineService(`shop_${suffix}`, {
    database,
    context: ({ request }) => ({ session: request.headers.get("x-session") }),
    identity: (ctx) =>
      ctx.session
        ? { id: ctx.session, label: `${ctx.session}@x`, tenant: "acme" }
        : null,
  });
  const order = service.resource({ name: "order", table: orders });
  return {
    suffix,
    service,
    order,
    orders,
    auditName,
    sql,
    created,
    db,
    rows: async (): Promise<any[]> =>
      sql(`SELECT * FROM ${auditName} ORDER BY seq`),
    status: async (): Promise<string> =>
      (await sql(`SELECT status FROM ${ordersName}`))[0].status,
  };
}

const as = (session?: string) => ({
  request: new Request("http://localhost", {
    headers: session ? { "x-session": session } : {},
  }),
});

suite("audit log on Postgres", () => {
  it("records a plain action, and meta as JSON", async () => {
    const made = await setup();
    const act = made.service.action({
      name: "refund",
      input: t.Object({ id: t.String() }),
      audit: { resource: "order", record: ({ input }) => input.id },
      execute: () => "ok",
    });
    const meta = made.service.action({
      name: "annotate",
      execute: ({ ctx }) =>
        recordAudit(ctx, { recordId: 7, meta: { reason: "late", n: 2 } }),
    });
    await act.run({ id: "o1" }, as("u1"));
    await meta.run(undefined, as("u1"));
    const [first, second] = await made.rows();
    expect(first).toMatchObject({
      action: "refund",
      resource: "order",
      record_id: "o1",
      actor_id: "u1",
      actor_label: "u1@x",
      tenant: "acme",
      meta: null,
    });
    expect(Math.abs(new Date(first.at).getTime() - Date.now())).toBeLessThan(
      5000,
    );
    expect(first.trace_id).toBeString();
    expect(second).toMatchObject({
      action: "annotate",
      record_id: "7",
      meta: { reason: "late", n: 2 },
    });
  });

  it("records a command in its transaction: it commits, or rolls back, with the write", async () => {
    const made = await setup();
    const ship = made.order.command("ship", {
      access: "public",
      decide: () => ({ set: { status: "shipped" } }),
    });
    await ship.run({ id: "o1" }, as("u1"));
    expect(await made.status()).toBe("shipped");
    expect(await made.rows()).toEqual([
      expect.objectContaining({
        action: "order.ship",
        resource: "order",
        record_id: "o1",
      }),
    ]);

    // The write fails at COMMIT, after the audit insert.
    const g = `guard_${made.suffix}`;
    await made.sql(`
      CREATE TABLE ${g}_parent (id int PRIMARY KEY);
      CREATE TABLE ${g} (v int REFERENCES ${g}_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION ${g}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO ${g} VALUES (999); RETURN NEW; END $$;
      CREATE TRIGGER ${g}_trg AFTER INSERT ON ${made.auditName} FOR EACH ROW EXECUTE FUNCTION ${g}_fn();`);
    made.created.push(
      `DROP TABLE IF EXISTS ${g}, ${g}_parent CASCADE`,
      `DROP FUNCTION IF EXISTS ${g}_fn() CASCADE`,
    );
    const again = made.order.command("again", {
      access: "public",
      decide: () => ({ set: { status: "again" } }),
    });
    await expect(again.run({ id: "o1" }, as("u1"))).rejects.toThrow();
    expect(await made.status()).toBe("shipped");
    expect(await made.rows()).toHaveLength(1);
  });

  it("recordAudit with tx commits, or rolls back, with the transaction", async () => {
    const made = await setup();
    const make = (fail: boolean) =>
      made.service.action({
        name: fail ? "failing" : "refund",
        execute: async ({ ctx }) => {
          await runInTransaction(ctx.db, async (tx) => {
            await tx
              .update(made.orders)
              .set({ status: "refunded" })
              .where(eq(made.orders.id, "o1"));
            await recordAudit(
              ctx,
              { resource: "order", recordId: "o1", meta: { why: "x" } },
              { tx },
            );
            if (fail) throw new Error("after the audit insert");
          });
        },
      });
    await expect(make(true).run(undefined, as("u1"))).rejects.toThrow();
    expect(await made.rows()).toEqual([]);
    expect(await made.status()).toBe("paid");
    await make(false).run(undefined, as("u1"));
    // One row, the explicit one: the automatic row was suppressed.
    expect(await made.rows()).toEqual([
      expect.objectContaining({ action: "refund", meta: { why: "x" } }),
    ]);
    expect(await made.status()).toBe("refunded");
  });

  it("keeps the result when the audit insert of a plain action fails", async () => {
    const made = await setup();
    const act = made.service.action({ name: "act", execute: () => "kept" });
    await made.sql(`DROP TABLE ${made.auditName}`);
    const errors: unknown[][] = [];
    const logger = {
      info() {},
      warn() {},
      debug() {},
      error: (...args: unknown[]) => void errors.push(args),
    };
    expect(await act.run(undefined, { ...as("u1"), logger })).toBe("kept");
    expect(errors).toHaveLength(1);
  });

  it("refuses UPDATE, DELETE and TRUNCATE with the trigger in the docs, and still inserts", async () => {
    const made = await setup();
    const docs = readFileSync(
      new URL(
        "../../../www/content/docs/(brick)/audit-log.mdx",
        import.meta.url,
      ),
      "utf8",
    );
    const trigger = docs.match(/```sql title="Postgres"\n([\s\S]*?)```/)?.[1];
    expect(trigger).toBeString();
    await made.sql(trigger!.replaceAll("brick_audit", made.auditName));
    made.created.push(
      `DROP FUNCTION IF EXISTS ${made.auditName}_append_only() CASCADE`,
    );
    const act = made.service.action({ name: "act", execute: () => "ok" });
    await act.run(undefined, as("u1"));
    await act.run(undefined, as("u1"));
    for (const statement of [
      `UPDATE ${made.auditName} SET actor_id = 'someone-else'`,
      `DELETE FROM ${made.auditName}`,
      `DELETE FROM ${made.auditName} WHERE seq = 1`,
      `TRUNCATE ${made.auditName}`,
    ]) {
      const outcome = await Promise.resolve(made.sql(statement)).then(
        () => "ran",
        (error: Error) => error.message,
      );
      expect(outcome).toContain("append-only");
    }
    expect((await made.rows()).map((row) => row.actor_id)).toEqual([
      "u1",
      "u1",
    ]);
    await act.run(undefined, as("u1"));
    expect(await made.rows()).toHaveLength(3);
  });
});
