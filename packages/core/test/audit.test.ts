import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  auditTable,
  brick,
  compileBrickApplication,
  createMcpHandler,
  createMcpRegistry,
  defineDatabase,
  defineService,
  recordAudit,
  resetGlobalRegistry,
  runInTransaction,
  syncSchema,
  t,
  useService,
  type Service,
} from "../src";
import { postJson, track } from "./helpers";

const notes = sqliteTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  body: text("body").notNull(),
  status: text("status").notNull().default("open"),
});
const auditLog = auditTable("sqlite");

beforeEach(resetGlobalRegistry);

function fixture(
  options: {
    table?: boolean;
    identity?: boolean;
    context?: boolean;
    name?: string;
  } = {},
) {
  const {
    table = true,
    identity = true,
    context = true,
    name = "notes",
  } = options;
  const database = defineDatabase({
    tables: table ? { notes, auditLog } : { notes },
  });
  const db: any = database.getDb();
  syncSchema(table ? [notes, auditLog] : [notes], db);
  const sqlite: Database = db.$client;
  const service = defineService(name, {
    database,
    ...(context && {
      context: ({ request, user }) => ({
        session: request.headers.get("x-session") ?? (user as string) ?? null,
      }),
    }),
    ...(identity && {
      identity: (ctx: any) =>
        ctx.session
          ? {
              id: ctx.session,
              label: `${ctx.session}@example.com`,
              tenant: "acme",
            }
          : null,
    }),
  });
  const rows = (): any[] =>
    db.select().from(auditLog).orderBy(auditLog.seq).all();
  const body = (id: number) =>
    db.select().from(notes).where(eq(notes.id, id)).get()?.body;
  return { database, db, sqlite, service, rows, body };
}

const as = (session?: string, extra: object = {}) => ({
  request: new Request("http://localhost", {
    headers: session ? { "x-session": session } : {},
  }),
  ...extra,
});
const post = (
  app: Parameters<typeof postJson>[0],
  path: string,
  body: unknown,
  session?: string,
  headers: Record<string, string> = {},
) =>
  postJson(app, path, body, {
    ...(session ? { "x-session": session } : {}),
    ...headers,
  });
const serve = (...services: Service<any, any>[]) =>
  track(brick({ services, requestLogging: false, docs: false }));

function withRename(options: Parameters<typeof fixture>[0] = {}) {
  const made = fixture(options);
  const rename = made.service.action({
    name: "rename",
    input: t.Object({ id: t.Number(), body: t.String() }),
    output: t.Object({ id: t.Number(), body: t.String() }),
    audit: { resource: "note", record: ({ input }) => input.id },
    execute: async ({ input, ctx }) => {
      await ctx.db
        .update(notes)
        .set({ body: input.body })
        .where(eq(notes.id, input.id));
      return { id: input.id, body: input.body };
    },
  });
  made.db.insert(notes).values({ body: "old" }).run();
  return { ...made, rename };
}

describe("a plain action is recorded", () => {
  it("over HTTP: who, what, which record, and the ids to find the request", async () => {
    const { service, rows } = withRename();
    const response = await post(
      serve(service),
      "/api/notes/rename",
      { id: 1, body: "new" },
      "u1",
      { "x-trace-id": "tr_http" },
    );
    expect(response.status).toBe(200);
    const [row, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(row).toMatchObject({
      service: "notes",
      action: "rename",
      resource: "note",
      recordId: "1",
      actorId: "u1",
      actorLabel: "u1@example.com",
      tenant: "acme",
      traceId: "tr_http",
      requestId: response.headers.get("x-request-id"),
      meta: null,
    });
    expect(row.id).toBeString();
    expect(row.seq).toBe(1);
    expect(Math.abs(row.at.getTime() - Date.now())).toBeLessThan(5000);
  });

  it("in process, as over HTTP", async () => {
    const { rename, rows, body } = withRename();
    await rename.run({ id: 1, body: "new" }, as("u2", { traceId: "tr_in" }));
    expect(body(1)).toBe("new");
    expect(rows()).toEqual([
      expect.objectContaining({
        action: "rename",
        resource: "note",
        recordId: "1",
        actorId: "u2",
        traceId: "tr_in",
      }),
    ]);
  });

  it("through useService, as a call from another service", async () => {
    const { service, rows } = withRename();
    await (useService(service) as any).rename(
      { id: 1, body: "x" },
      { user: "u3" },
    );
    expect(rows()).toEqual([expect.objectContaining({ actorId: "u3" })]);
  });

  it("has no resource or record unless the action says", async () => {
    const { service, rows } = fixture();
    const touch = service.action({ name: "touch", execute: () => "ok" });
    await touch.run(undefined, as("u1"));
    expect(rows()[0]).toMatchObject({
      action: "touch",
      resource: null,
      recordId: null,
    });
  });

  it("stores a record id that is not a string or a number as JSON", async () => {
    const { service, rows } = fixture();
    const move = service.action({
      name: "move",
      audit: { record: () => ({ org: 1, slug: "a" }) as never },
      execute: () => "ok",
    });
    await move.run(undefined, as("u1"));
    expect(rows()[0].recordId).toBe('{"org":1,"slug":"a"}');
  });

  it("is not recorded when the action reads: GET, or audit: false", async () => {
    const { service, rows } = fixture();
    const list = service.action({
      name: "list",
      method: "GET",
      execute: () => "ok",
    });
    const getReport = service.action({
      name: "getReport",
      execute: () => "ok",
    });
    const search = service.action({
      name: "search",
      method: "POST",
      audit: false,
      execute: () => "ok",
    });
    await list.run(undefined, as("u1"));
    await search.run(undefined, as("u1"));
    expect(rows()).toEqual([]);
    await getReport.run(undefined, as("u1"));
    expect(rows().map((row) => row.action)).toEqual(["getReport"]);
  });

  it("records every method but GET", async () => {
    const { service, rows } = fixture();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const)
      await service
        .action({ name: method.toLowerCase(), method, execute: () => "ok" })
        .run(undefined, as("u1"));
    expect(rows().map((row) => row.action)).toEqual([
      "post",
      "put",
      "patch",
      "delete",
    ]);
  });

  it("records nothing for an action that throws, is refused or is invalid", async () => {
    const { service, rows } = fixture();
    service.action({
      name: "boom",
      execute: () => {
        throw new Error("nope");
      },
    });
    service.action({
      name: "locked",
      authorize: () => false,
      execute: () => "ok",
    });
    service.action({
      name: "typed",
      input: t.Object({ n: t.Number() }),
      execute: () => "ok",
    });
    const app = serve(service);
    expect((await post(app, "/api/notes/boom", {}, "u1")).status).toBe(500);
    expect((await post(app, "/api/notes/locked", {}, "u1")).status).toBe(401);
    expect((await post(app, "/api/notes/typed", { n: "x" }, "u1")).status).toBe(
      400,
    );
    expect(rows()).toEqual([]);
  });

  it("keeps the result and logs when the audit insert fails", async () => {
    const { rename, sqlite, body } = withRename();
    sqlite.run("DROP TABLE brick_audit");
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      const logger = { info() {}, warn() {}, debug() {}, error };
      expect(
        await rename.run({ id: 1, body: "kept" }, as("u1", { logger })),
      ).toEqual({ id: 1, body: "kept" });
      expect(body(1)).toBe("kept");
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0]![0])).toContain("rename");

      error.mockClear();
      const http = withRename({ name: "again" });
      http.sqlite.run("DROP TABLE brick_audit");
      const response = await post(
        serve(http.service),
        "/api/again/rename",
        { id: 1, body: "x" },
        "u1",
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 1, body: "x" });
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it("logs the complete row, and no input or output, when the audit insert fails", async () => {
    const { rename, sqlite } = withRename();
    sqlite.run("DROP TABLE brick_audit");
    const error = mock(() => {});
    const logger = { info() {}, warn() {}, debug() {}, error };
    await rename.run(
      { id: 1, body: "TOP-SECRET" },
      as("u1", { logger, traceId: "tr_1", requestId: "rq_1" }),
    );
    expect(error).toHaveBeenCalledTimes(1);
    const [, row, cause] = error.mock.calls[0] as unknown as [
      string,
      object,
      unknown,
    ];
    expect(row).toEqual({
      id: expect.any(String),
      at: expect.any(Date),
      service: "notes",
      action: "rename",
      resource: "note",
      recordId: "1",
      actorId: "u1",
      actorLabel: "u1@example.com",
      tenant: "acme",
      traceId: "tr_1",
      requestId: "rq_1",
      meta: null,
    });
    expect(cause).toBeInstanceOf(Error);
    expect(JSON.stringify(row)).not.toContain("TOP-SECRET");
  });

  it("logs the rest of the row, and keeps the result, when the record function throws", async () => {
    const made = fixture();
    const act = made.service.action({
      name: "act",
      audit: {
        resource: "note",
        record: () => {
          throw new Error("no id");
        },
      },
      execute: () => "done",
    });
    const error = mock(() => {});
    const logger = { info() {}, warn() {}, debug() {}, error };
    expect(await act.run(undefined, as("u1", { logger }))).toBe("done");
    expect(made.rows()).toEqual([]);
    const [, row] = error.mock.calls[0] as unknown as [string, object];
    expect(row).toMatchObject({
      action: "act",
      resource: "note",
      recordId: null,
      actorId: "u1",
    });
  });

  it("names the service the action is registered on now, not the one it first ran on", async () => {
    const made = fixture();
    const act = made.service.action({ name: "act", execute: () => "done" });
    await act.run(undefined, as("u1"));
    const other = defineService("other", {
      database: made.database,
      identity: () => ({ id: "u2" }),
    });
    other.action(act);
    await act.run(undefined, as("u1"));
    expect(made.rows().map((row) => row.service)).toEqual(["notes", "other"]);
  });

  it("records anonymous calls with null actor, label and tenant", async () => {
    const { rename, rows } = withRename();
    await rename.run({ id: 1, body: "x" }, as());
    expect(rows()[0]).toMatchObject({
      actorId: null,
      actorLabel: null,
      tenant: null,
    });
  });

  it("stores what identity returns and nothing else, without reading ctx.user", async () => {
    const database = defineDatabase({ tables: { auditLog } });
    syncSchema([auditLog], database.getDb() as any);
    const service = defineService("whoami", {
      database,
      context: () => ({ account: { sub: "s-9", pw: "hunter2", org: "o-1" } }),
      identity: ({ account }) => ({ id: account.sub, tenant: account.org }),
    });
    const act = service.action({ name: "act", execute: () => "ok" });
    await act.run(undefined, {
      user: { id: "wrong", email: "wrong@x" },
    } as never);
    const [row] = (database.getDb() as any).select().from(auditLog).all();
    expect(row).toMatchObject({
      actorId: "s-9",
      actorLabel: null,
      tenant: "o-1",
    });
    expect(JSON.stringify(row)).not.toContain("hunter2");
    expect(JSON.stringify(row)).not.toContain("wrong");
  });

  it("takes the actor from identity alone: a ctx.user is not a fallback", async () => {
    const { service, rows } = fixture({ context: false });
    const act = service.action({ name: "act", execute: () => "ok" });
    await act.run(undefined, { user: { id: "wrong" } } as never);
    expect(rows()).toEqual([
      expect.objectContaining({
        actorId: null,
        actorLabel: null,
        tenant: null,
      }),
    ]);
  });

  it("resolves the actor before the action runs, once", async () => {
    const order: string[] = [];
    const database = defineDatabase({ tables: { auditLog } });
    syncSchema([auditLog], database.getDb() as any);
    const service = defineService("early", {
      database,
      identity: () => {
        order.push("identity");
        return { id: "u1" };
      },
    });
    const act = service.action({
      name: "act",
      execute: () => {
        order.push("execute");
      },
    });
    await act.run(undefined, {} as never);
    expect(order).toEqual(["identity", "execute"]);
  });

  it("records a service whose database is set after it was made", async () => {
    const service = defineService("late", {
      identity: () => ({ id: "u1" }),
    });
    const act = service.action({ name: "act", execute: () => "ok" });
    const database = defineDatabase({ tables: { auditLog } });
    syncSchema([auditLog], database.getDb() as any);
    (service as any).setDb(database);
    await act.run(undefined, {} as never);
    expect(
      (database.getDb() as any)
        .select()
        .from(auditLog)
        .all()
        .map((row: any) => row.action),
    ).toEqual(["act"]);
  });

  it("records an MCP tool call, and not a tool with audit: false", async () => {
    const { service, rows } = fixture();
    service.tool({
      name: "lookup",
      input: t.Object({}),
      execute: () => "x",
    });
    service.tool({
      name: "quiet",
      input: t.Object({}),
      audit: false,
      execute: () => "x",
    });
    const mounted = createMcpHandler({
      registry: createMcpRegistry({ services: [service] }),
      serverInfo: { name: "t", version: "1" },
    });
    for (const name of ["lookup", "quiet"]) {
      const response = await mounted(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", "x-session": "u1" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: {} },
          }),
        }),
      );
      expect(((await response.json()) as any).result.isError).not.toBe(true);
    }
    expect(rows()).toEqual([
      expect.objectContaining({ action: "lookup", actorId: "u1" }),
    ]);
  });

  it("copies no input or output into the row", async () => {
    const { service, rows } = fixture();
    const act = service.action({
      name: "store",
      input: t.Object({ secret: t.String() }),
      output: t.Object({ echoed: t.String() }),
      execute: ({ input }) => ({ echoed: `${input.secret}-out` }),
    });
    await act.run({ secret: "TOP-SECRET" }, as("u1"));
    const text = JSON.stringify(rows());
    expect(text).not.toContain("TOP-SECRET");
    expect(rows()[0].meta).toBeNull();
  });

  it("is written through the transaction queue: a rollback elsewhere does not take its row, nor a recordAudit without tx", async () => {
    const { service, rows, db } = fixture();
    const act = service.action({ name: "act", execute: () => "ok" });
    const manual = service.action({
      name: "manual",
      execute: ({ ctx }) => recordAudit(ctx, { action: "by-hand" }),
    });
    let fail!: () => void;
    const gate = new Promise<void>((_, reject) => (fail = reject));
    const other = runInTransaction(db, async () => gate).catch(() => {});
    await Promise.resolve();
    const running = [act, manual].map((one) => one.run(undefined, as("u1")));
    await new Promise((resolve) => setTimeout(resolve, 10));
    fail();
    await Promise.all([...running, other]);
    expect(
      rows()
        .map((row) => row.action)
        .sort(),
    ).toEqual(["act", "by-hand", "manual"]);
  });

  it("does not deadlock when the action is called inside a transaction, and rolls back with it", async () => {
    const { service, rows } = fixture();
    const inner = service.action({ name: "inner", execute: () => "in" });
    const outer = service.action({
      name: "outer",
      input: t.Object({ fail: t.Boolean() }),
      execute: ({ input, ctx }) =>
        runInTransaction(ctx.db, async () => {
          await inner.run(undefined, ctx);
          if (input.fail) throw new Error("rolled back");
        }),
    });
    await outer.run({ fail: false }, as("u1"));
    expect(rows().map((row) => row.action)).toEqual(["inner", "outer"]);
    await expect(outer.run({ fail: true }, as("u1"))).rejects.toThrow();
    expect(rows()).toHaveLength(2);
  });

  it("gives each nested call its own row, with one trace id", async () => {
    const { service, rows } = fixture();
    const inner = service.action({ name: "inner", execute: () => "in" });
    const outer = service.action({
      name: "outer",
      execute: async ({ ctx }) => inner.run(undefined, ctx),
    });
    await outer.run(undefined, as("u1"));
    const found = rows();
    expect(found.map((row) => row.action).sort()).toEqual(["inner", "outer"]);
    expect(new Set(found.map((row) => row.traceId)).size).toBe(1);
    expect(found[0].traceId).toBeString();
  });

  it("records a call to another audited service in that service's table, with the same trace", async () => {
    const first = fixture({ name: "first" });
    const second = fixture({ name: "second" });
    const far = second.service.action({ name: "far", execute: () => "far" });
    const near = first.service.action({
      name: "near",
      execute: async ({ ctx }) =>
        (useService(second.service) as any).far({}, ctx),
    });
    expect(far).toBeDefined();
    await near.run(undefined, as("u1", { traceId: "tr_shared" }));
    expect(first.rows().map((row) => [row.action, row.traceId])).toEqual([
      ["near", "tr_shared"],
    ]);
    expect(second.rows().map((row) => [row.action, row.traceId])).toEqual([
      ["far", "tr_shared"],
    ]);
  });
});

describe("recordAudit", () => {
  const refund = (
    made: ReturnType<typeof fixture>,
    after?: () => void,
    withTx = true,
  ) =>
    made.service.action({
      name: "refund",
      input: t.Object({ id: t.Number() }),
      execute: async ({ input, ctx }) => {
        await runInTransaction(ctx.db, async (tx) => {
          await tx
            .update(notes)
            .set({ status: "refunded" })
            .where(eq(notes.id, input.id));
          await recordAudit(
            ctx,
            { resource: "note", recordId: input.id, meta: { reason: "late" } },
            withTx ? { tx } : undefined,
          );
          after?.();
        });
        return "ok";
      },
    });
  const status = (made: ReturnType<typeof fixture>) =>
    made.db.select().from(notes).get()?.status;

  it("with tx is the call's record, and the automatic row is not written", async () => {
    const made = fixture();
    made.db.insert(notes).values({ body: "b" }).run();
    await refund(made).run({ id: 1 }, as("u1"));
    expect(made.rows()).toEqual([
      expect.objectContaining({
        action: "refund",
        resource: "note",
        recordId: "1",
        actorId: "u1",
        meta: { reason: "late" },
      }),
    ]);
    expect(status(made)).toBe("refunded");
  });

  it("with tx rolls back with the transaction", async () => {
    const made = fixture();
    made.db.insert(notes).values({ body: "b" }).run();
    const failing = refund(made, () => {
      throw new Error("after the audit insert");
    });
    await expect(failing.run({ id: 1 }, as("u1"))).rejects.toThrow();
    expect(made.rows()).toEqual([]);
    expect(status(made)).toBe("open");
  });

  it("without tx writes at once, and the automatic row is written too", async () => {
    const made = fixture();
    made.db.insert(notes).values({ body: "b" }).run();
    await refund(made, undefined, false).run({ id: 1 }, as("u1"));
    expect(made.rows().map((row) => row.meta)).toEqual([
      { reason: "late" },
      null,
    ]);
  });

  it("with tx covers only its own call: a nested call is still recorded", async () => {
    const made = fixture();
    made.db.insert(notes).values({ body: "b" }).run();
    const inner = made.service.action({ name: "inner", execute: () => "in" });
    const outer = made.service.action({
      name: "outer",
      execute: async ({ ctx }) => {
        await inner.run(undefined, ctx);
        await recordAudit(ctx, { recordId: 1 }, { tx: ctx.db });
      },
    });
    await outer.run(undefined, as("u1"));
    expect(made.rows().map((row) => row.action)).toEqual(["inner", "outer"]);
  });

  it("with a tx that rolls back leaves the automatic row to Brick", async () => {
    const made = fixture();
    made.db.insert(notes).values({ body: "b" }).run();
    const act = made.service.action({
      name: "refund",
      execute: async ({ ctx }) => {
        await runInTransaction(ctx.db, async (tx) => {
          await recordAudit(
            ctx,
            { recordId: 1, meta: { forged: true } },
            { tx },
          );
          throw new Error("rolled back");
        }).catch(() => {});
        await ctx.db.update(notes).set({ status: "refunded" });
      },
    });
    await act.run(undefined, as("u1"));
    expect(made.rows()).toEqual([
      expect.objectContaining({ action: "refund", meta: null, actorId: "u1" }),
    ]);
    expect(status(made)).toBe("refunded");
  });

  it("with a tx of a savepoint that rolls back, but an outer commit, leaves the automatic row to Brick", async () => {
    const made = fixture();
    const act = made.service.action({
      name: "refund",
      execute: async ({ ctx }) => {
        await runInTransaction(ctx.db, async (outer) => {
          await runInTransaction(outer, async (inner) => {
            await recordAudit(ctx, { recordId: 1 }, { tx: inner });
            throw new Error("savepoint rolled back");
          }).catch(() => {});
        });
      },
    });
    await act.run(undefined, as("u1"));
    expect(made.rows().map((row) => row.action)).toEqual(["refund"]);
    expect(made.rows()[0].recordId).toBeNull();
  });

  it("with a tx Brick did not open does not stand in for the automatic row", async () => {
    const made = fixture();
    const untracked = drizzle(made.sqlite);
    const act = made.service.action({
      name: "act",
      execute: async ({ ctx }) => {
        await recordAudit(ctx, { action: "by hand" }, { tx: untracked });
      },
    });
    await act.run(undefined, as("u1"));
    expect(made.rows().map((row) => row.action)).toEqual(["by hand", "act"]);
  });

  it("without tx, twice at once inside one transaction, writes both rows", async () => {
    const made = fixture();
    const act = made.service.action({
      name: "act",
      audit: false,
      execute: async ({ ctx }) => {
        await runInTransaction(ctx.db, () =>
          Promise.all([
            recordAudit(ctx, { action: "one" }),
            recordAudit(ctx, { action: "two" }),
          ]),
        );
      },
    });
    await act.run(undefined, as("u1"));
    expect(
      made
        .rows()
        .map((row) => row.action)
        .sort(),
    ).toEqual(["one", "two"]);
  });

  it("without tx, inside a transaction, joins it instead of waiting for it", async () => {
    const made = fixture();
    const act = made.service.action({
      name: "act",
      execute: async ({ ctx }) => {
        await runInTransaction(ctx.db, async () => {
          await recordAudit(ctx, { action: "inside" });
        });
        await runInTransaction(ctx.db, async () => {
          await recordAudit(ctx, { action: "undone" });
          throw new Error("rolled back");
        }).catch(() => {});
      },
    });
    await act.run(undefined, as("u1"));
    expect(made.rows().map((row) => row.action)).toEqual(["inside", "act"]);
  });

  it("needs an action name where no recorded action is running, and a service with an audit table", async () => {
    const made = fixture();
    const failure = (run: () => Promise<void>) =>
      run().then(
        () => "recorded",
        (error: Error) => error.message,
      );
    const read = made.service.action({
      name: "read",
      method: "GET",
      execute: ({ ctx }) => failure(() => recordAudit(ctx, { recordId: 1 })),
    });
    expect(await read.run(undefined, as("u1"))).toContain(
      "recordAudit needs an action",
    );
    const named = made.service.action({
      name: "named",
      method: "GET",
      execute: ({ ctx }) =>
        recordAudit(ctx, { action: "note.exported", recordId: 1 }),
    });
    await named.run(undefined, as("u1"));
    expect(made.rows().map((row) => row.action)).toEqual(["note.exported"]);

    const bare = fixture({ table: false, name: "bare" });
    const act = bare.service.action({
      name: "act",
      execute: ({ ctx }) => failure(() => recordAudit(ctx, { action: "x" })),
    });
    expect(await act.run(undefined, as("u1"))).toContain("audit table");
    expect(
      await failure(() => recordAudit({} as never, { action: "x" })),
    ).toContain("audit table");
  });
});

describe("an action that is not recorded, called inside a recorded one", () => {
  function outerAndPeek(
    peekBody: (ctx: any) => Promise<unknown>,
    peekMethod: "GET" | "POST" = "GET",
  ) {
    const made = fixture();
    const peek = made.service.action({
      name: "peek",
      method: peekMethod,
      ...(peekMethod === "POST" && { audit: false as const }),
      execute: ({ ctx }: any) => peekBody(ctx),
    });
    const outer = made.service.action({
      name: "outer",
      execute: async ({ ctx }: any) => {
        await peek.run(undefined, ctx);
        return "ok";
      },
    });
    return { ...made, outer };
  }

  it("cannot take the outer action's name in recordAudit", async () => {
    const { outer, rows } = outerAndPeek((ctx) => recordAudit(ctx, {}));
    await expect(outer.run(undefined, as("u1"))).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
    expect(rows()).toEqual([]);
  });

  for (const method of ["GET", "POST"] as const)
    it(`keeps the outer action's own row when a nested ${method} commits a recordAudit row`, async () => {
      const { outer, rows } = outerAndPeek(
        (ctx) =>
          runInTransaction(ctx.db, async (tx) => {
            await recordAudit(ctx, { action: "peeked" }, { tx });
          }),
        method,
      );
      await outer.run(undefined, as("u1"));
      expect(rows().map((row) => row.action)).toEqual(["peeked", "outer"]);
    });
});

describe("commands are recorded in their transaction", () => {
  const orders = sqliteTable("orders", {
    id: text("id").primaryKey(),
    status: text("status").notNull(),
  });
  function commandFixture() {
    const database = defineDatabase({ tables: { orders, auditLog } });
    const db: any = database.getDb();
    syncSchema([orders, auditLog], db);
    db.insert(orders).values({ id: "o1", status: "paid" }).run();
    const service = defineService("shop", {
      database,
      context: ({ request }) => ({ session: request.headers.get("x-session") }),
      identity: (ctx) =>
        ctx.session ? { id: ctx.session, tenant: "acme" } : null,
    });
    const order = service.resource({ name: "order", table: orders });
    const ship = order.command("ship", {
      input: t.Object({ carrier: t.String() }),
      access: "public",
      errors: { NOT_PAID: { status: 409, message: "unpaid" } },
      decide: (row, input, { error }) =>
        row.status !== "paid"
          ? error.NOT_PAID()
          : { set: { status: `shipped-${input.carrier}` } },
    });
    return {
      db,
      sqlite: db.$client as Database,
      service,
      order,
      ship,
      rows: (): any[] => db.select().from(auditLog).all(),
      status: () => db.select().from(orders).get().status,
    };
  }

  it("cannot be defined over the audit table", () => {
    const database = defineDatabase({ tables: { auditLog } });
    const service = defineService("shop", {
      database,
      identity: () => null,
    });
    const log = service.resource({ name: "audit", table: auditLog });
    expect(() =>
      log.command("forge", {
        access: "public",
        decide: () => ({ set: { action: "forged" } }),
      } as never),
    ).toThrow(/over the audit table/);
  });

  it("with the resource and the record id, over HTTP and in process", async () => {
    const made = commandFixture();
    const app = serve(made.service);
    const response = await post(
      app,
      "/api/shop/order/o1/ship",
      { carrier: "dhl" },
      "u1",
    );
    expect(response.status).toBe(200);
    expect(made.rows()).toEqual([
      expect.objectContaining({
        service: "shop",
        action: "order.ship",
        resource: "order",
        recordId: "o1",
        actorId: "u1",
        tenant: "acme",
      }),
    ]);
    made.db.update(orders).set({ status: "paid" }).run();
    await made.ship.run({ id: "o1", carrier: "ups" }, as("u2"));
    expect(made.rows().map((row) => row.actorId)).toEqual(["u1", "u2"]);
  });

  it("records nothing for a rejected command, and audit: false leaves one out", async () => {
    const made = commandFixture();
    made.db.update(orders).set({ status: "new" }).run();
    await expect(
      made.ship.run({ id: "o1", carrier: "x" }, as("u1")),
    ).rejects.toMatchObject({ code: "NOT_PAID" });
    expect(made.rows()).toEqual([]);
    const quiet = made.order.command("quiet", {
      access: "public",
      audit: false,
      decide: () => ({ set: { status: "quiet" } }),
    });
    await quiet.run({ id: "o1" }, as("u1"));
    expect(made.status()).toBe("quiet");
    expect(made.rows()).toEqual([]);
  });

  it("rolls the write back when the audit insert fails", async () => {
    const made = commandFixture();
    made.sqlite.run("DROP TABLE brick_audit");
    await expect(
      made.ship.run({ id: "o1", carrier: "dhl" }, as("u1")),
    ).rejects.toThrow();
    expect(made.status()).toBe("paid");
  });

  it("rolls the row back when the write fails after the audit insert", async () => {
    const made = commandFixture();
    failAtCommit(made.sqlite);
    await expect(
      made.ship.run({ id: "o1", carrier: "dhl" }, as("u1")),
    ).rejects.toThrow();
    expect(made.status()).toBe("paid");
    expect(made.rows()).toEqual([]);
  });

  it("records a resource action by its record, as a plain action", async () => {
    const made = commandFixture();
    const cancel = made.order.action({
      name: "cancel",
      record: true,
      access: "public",
      execute: async ({ row, ctx }) => {
        await ctx.db.update(orders).set({ status: "cancelled" });
        return { id: row.id };
      },
    });
    await cancel.run({ id: "o1" }, as("u1"));
    expect(made.rows()).toEqual([
      expect.objectContaining({
        action: "order.cancel",
        resource: "order",
        recordId: "o1",
      }),
    ]);
  });
});

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

describe("when a service records, and what it costs", () => {
  it("fails at build, naming the service, when it has an audit table and no identity", () => {
    const { service } = fixture({ identity: false, name: "unnamed" });
    expect(() => service.build()).toThrow(
      /Service "unnamed".*audit table.*no identity/,
    );
    expect(() =>
      brick({ services: [service], requestLogging: false, docs: false }),
    ).toThrow('Service "unnamed"');
  });

  it("records nothing, and needs no identity, in a service without the table", async () => {
    const { service, db } = fixture({ table: false, identity: false });
    const act = service.action({
      name: "act",
      audit: { resource: "note" },
      execute: () => "ok",
    });
    service.build();
    expect(await act.run(undefined, as("u1"))).toBe("ok");
    expect(
      db.all(sql`SELECT name FROM sqlite_master WHERE name = 'brick_audit'`),
    ).toEqual([]);
    expect(service.introspect().actions.some((a) => "audited" in a)).toBe(
      false,
    );
  });

  it("keeps the synchronous path without the table; an audited mutation waits, a read does not", () => {
    const calls = (service: ReturnType<typeof fixture>["service"]) =>
      Object.fromEntries(
        compileBrickApplication({ services: [service] }).routes.map((route) => [
          route.ir.action,
          route.handler({
            request: new Request("http://localhost"),
            set: { headers: {} },
            headers: {},
          }),
        ]),
      );
    const bare = fixture({
      table: false,
      identity: false,
      context: false,
      name: "bare",
    }).service;
    bare.action({ name: "mutate", execute: () => "ok" });
    expect(calls(bare).mutate).toBe("ok");

    const audited = fixture({ context: false, name: "audited" }).service;
    audited.action({ name: "mutate", execute: () => "ok" });
    audited.action({ name: "read", method: "GET", execute: () => "ok" });
    audited.action({ name: "quiet", audit: false, execute: () => "ok" });
    const result = calls(audited);
    expect(result.mutate).toBeInstanceOf(Promise);
    expect(result.read).toBe("ok");
    expect(result.quiet).toBe("ok");
  });

  it("says in introspect() which actions are audited", () => {
    const { service } = fixture();
    service.action({ name: "write", execute: () => "ok" });
    service.action({ name: "read", method: "GET", execute: () => "ok" });
    service.action({ name: "quiet", audit: false, execute: () => "ok" });
    const audited = Object.fromEntries(
      service.introspect().actions.map((a) => [a.name, a.audited]),
    );
    expect(audited).toEqual({ write: true, read: undefined, quiet: undefined });
  });
});

describe("the append-only triggers in the docs", () => {
  const docs = readFileSync(
    new URL("../../../www/content/docs/(brick)/audit-log.mdx", import.meta.url),
    "utf8",
  );
  const block = (title: string) =>
    docs.match(
      new RegExp('```sql title="' + title + '"\\n([\\s\\S]*?)```'),
    )?.[1];

  it("refuse UPDATE, DELETE and a replacing INSERT on SQLite and leave inserts alone", async () => {
    const made = fixture();
    const trigger = block("SQLite");
    expect(trigger).toBeString();
    made.sqlite.run("PRAGMA recursive_triggers = OFF");
    made.sqlite.exec(trigger!);
    const act = made.service.action({ name: "act", execute: () => "ok" });
    await act.run(undefined, as("u1"));
    await act.run(undefined, as("u1"));
    expect(made.rows()).toHaveLength(2);
    expect(() =>
      made.sqlite.run("UPDATE brick_audit SET actor_id = 'someone-else'"),
    ).toThrow(/append-only/);
    expect(() => made.sqlite.run("DELETE FROM brick_audit")).toThrow(
      /append-only/,
    );
    expect(() =>
      made.sqlite.run("DELETE FROM brick_audit WHERE seq = 1"),
    ).toThrow(/append-only/);
    for (const statement of [
      "INSERT OR REPLACE INTO brick_audit (seq, id, at, service, action) VALUES (1, 'forged', 0, 's', 'a')",
      "INSERT OR REPLACE INTO brick_audit (id, at, service, action) SELECT id, 0, 's', 'a' FROM brick_audit WHERE seq = 1",
      "INSERT INTO brick_audit (seq, id, at, service, action) VALUES (1, 'x', 0, 's', 'a') ON CONFLICT (seq) DO UPDATE SET action = 'forged'",
    ])
      expect(() => made.sqlite.run(statement)).toThrow(/append-only/);
    expect(made.rows().map((row) => row.actorId)).toEqual(["u1", "u1"]);
    await act.run(undefined, as("u1"));
    expect(made.rows()).toHaveLength(3);
  });
});
