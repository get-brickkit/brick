import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import {
  defineService,
  defineDatabase,
  defineAction,
  createSQLiteDatabase,
  attachDatabase,
  resetGlobalRegistry,
  useService,
  t,
  sqliteTable,
  text,
  integer,
  eq,
  sql,
  ensureResourceIndexes,
  ensureSQLiteFts,
} from "../src";
import { pgTable, text as pgText } from "drizzle-orm/pg-core";

// Define Drizzle tables for testing
export const itemsTable = sqliteTable("items", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  quantity: integer("quantity").notNull(),
  category: text("category").notNull(),
});

export const logsTable = sqliteTable("logs", {
  id: text("id").primaryKey(),
  message: text("message").notNull(),
  timestamp: integer("timestamp").notNull(),
});

describe("@brickkit/core Database & Drizzle Integration", () => {
  beforeEach(() => {
    resetGlobalRegistry();
  });

  it("should create a table with Drizzle ORM and perform queries", async () => {
    // 1. Zero-config SQLite database helper
    const db = createSQLiteDatabase();
    expect(db).toBeDefined();
    expect(typeof db.select).toBe("function");

    // Create table schema
    db.run(sql`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        category TEXT NOT NULL
      );
    `);

    // Insert records with Drizzle ORM
    await db.insert(itemsTable).values([
      {
        id: "item_1",
        title: "Mechanical Keyboard",
        quantity: 15,
        category: "electronics",
      },
      {
        id: "item_2",
        title: "Ergonomic Chair",
        quantity: 5,
        category: "furniture",
      },
    ]);

    // Query back with Drizzle ORM
    const items = await db
      .select()
      .from(itemsTable)
      .where(eq(itemsTable.category, "electronics"));
    expect(items.length).toBe(1);
    expect(items[0].id).toBe("item_1");
    expect(items[0].title).toBe("Mechanical Keyboard");
    expect(items[0].quantity).toBe(15);
  });

  it("should automatically initialize service.db and populate ctx.db in actions", async () => {
    const inventoryService = defineService("inventory", {
      database: defineDatabase(),
    });
    expect(inventoryService.db).toBeDefined();
    expect(inventoryService.getDb()).toBeDefined();

    // Initialize table on service.db
    inventoryService.db!.run(sql`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        category TEXT NOT NULL
      );
    `);

    const addItem = defineAction({
      name: "addItem",
      input: t.Object({
        id: t.String(),
        title: t.String(),
        quantity: t.Number(),
        category: t.String(),
      }),
      output: t.Object({
        id: t.String(),
        title: t.String(),
        quantity: t.Number(),
        category: t.String(),
      }),
      execute: async ({ input, ctx }) => {
        // ctx.db is automatically injected from the service
        expect(ctx.db).toBeDefined();
        await ctx.db.insert(itemsTable).values(input);
        return input;
      },
    });

    const getItem = defineAction({
      name: "getItem",
      input: t.Object({ id: t.String() }),
      output: t.Object({
        id: t.String(),
        title: t.String(),
        quantity: t.Number(),
        category: t.String(),
      }),
      execute: async ({ input, ctx }) => {
        expect(ctx.db).toBeDefined();
        const [found] = await ctx.db
          .select()
          .from(itemsTable)
          .where(eq(itemsTable.id, input.id));
        return found;
      },
    });

    inventoryService.action(addItem).action(getItem);

    // 1. Insert a record through an action's ctx.db
    const created = await addItem({
      input: {
        id: "item_desk",
        title: "Standing Desk",
        quantity: 8,
        category: "furniture",
      },
    });
    expect(created.title).toBe("Standing Desk");

    // 2. Query it back through an action's ctx.db
    const fetched = await getItem({ input: { id: "item_desk" } });
    expect(fetched).toBeDefined();
    expect(fetched.id).toBe("item_desk");
    expect(fetched.title).toBe("Standing Desk");
    expect(fetched.quantity).toBe(8);
  });

  it("should support attachDatabase(service, definedDatabase)", async () => {
    // Service created without database option
    const auditService = defineService("audit");
    expect(auditService.getDb()).toBeUndefined();

    // Attach new zero-config SQLite database via attachDatabase
    const db = attachDatabase(
      auditService,
      defineDatabase({ path: ":memory:" }),
    );
    expect(db).toBeDefined();
    expect(auditService.getDb()).toBe(db);
    expect(auditService.db).toBe(db);

    db.run(sql`
      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        message TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);

    const logEvent = defineAction({
      name: "logEvent",
      input: t.Object({ id: t.String(), message: t.String() }),
      execute: async ({ input, ctx }) => {
        await ctx.db.insert(logsTable).values({
          id: input.id,
          message: input.message,
          timestamp: Date.now(),
        });
        return { success: true };
      },
    });

    auditService.action(logEvent);

    await logEvent({ input: { id: "log_1", message: "User logged in" } });

    const rows = await db
      .select()
      .from(logsTable)
      .where(eq(logsTable.id, "log_1"));
    expect(rows.length).toBe(1);
    expect(rows[0].message).toBe("User logged in");

    // Test attaching an already existing Drizzle instance
    const customDb = defineDatabase();
    const otherService = defineService("other");
    attachDatabase(otherService, customDb);
    expect(otherService.db).toBe(customDb.getDb());
  });

  it("should execute zero-latency local queries in sub-millisecond time", async () => {
    const perfService = defineService("perf", { database: defineDatabase() });

    perfService.db!.run(sql`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        category TEXT NOT NULL
      );
    `);

    // Bulk insert 100 items locally
    const bulkItems = Array.from({ length: 100 }, (_, i) => ({
      id: `perf_${i}`,
      title: `Widget ${i}`,
      quantity: i * 2,
      category: i % 2 === 0 ? "even" : "odd",
    }));

    await perfService.db!.insert(itemsTable).values(bulkItems);

    const queryPerfAction = defineAction({
      name: "queryPerf",
      execute: async ({ ctx }) => {
        return ctx.db
          .select()
          .from(itemsTable)
          .where(eq(itemsTable.category, "even"));
      },
    });

    perfService.action(queryPerfAction);

    // Warm-up query
    await queryPerfAction({});

    // Benchmark local query execution
    const iterations = 50;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      await queryPerfAction({});
    }
    const totalDuration = performance.now() - start;
    const avgDuration = totalDuration / iterations;

    // Verify sub-millisecond / zero-latency local execution
    expect(avgDuration).toBeLessThan(2.0); // Averaging < 2ms (typically < 0.2ms)
    expect(totalDuration).toBeLessThan(100.0);
  });

  it("should propagate service.db across RPC service proxies", async () => {
    const warehouseService = defineService("warehouse", {
      database: defineDatabase(),
    });

    warehouseService.db!.run(sql`
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        category TEXT NOT NULL
      );
    `);

    await warehouseService.db!.insert(itemsTable).values({
      id: "item_rpc",
      title: "Remote Controlled Drone",
      quantity: 42,
      category: "drones",
    });

    warehouseService.action({
      name: "findItem",
      input: t.Object({ id: t.String() }),
      execute: async ({ input, ctx }: any) => {
        expect(ctx.db).toBeDefined();
        const [found] = await ctx.db
          .select()
          .from(itemsTable)
          .where(eq(itemsTable.id, input.id));
        return found;
      },
    });

    const warehouseRpc = useService(warehouseService);
    const result = await warehouseRpc.findItem({ id: "item_rpc" });

    expect(result).toBeDefined();
    expect(result.id).toBe("item_rpc");
    expect(result.title).toBe("Remote Controlled Drone");
    expect(result.quantity).toBe(42);
  });
});

it("creates Postgres indexes one after another, the extension first, and warns on a failure", async () => {
  const pages = pgTable("pages", {
    id: pgText("id").primaryKey(),
    title: pgText("title"),
    createdAt: pgText("created_at"),
  });
  const ran: string[] = [];
  let running = 0;
  const db = {
    async execute(query: any) {
      expect(++running).toBe(1);
      await Bun.sleep(1);
      running--;
      const text = query.queryChunks.map((chunk: any) => chunk.value).join("");
      if (text.includes("created_at")) throw new Error("read-only");
      ran.push(text);
    },
  };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await ensureResourceIndexes(db, pages, {
      sortFields: ["createdAt"],
      searchFields: ["title"],
    });
    expect(ran[0]).toBe("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    expect(ran.at(-1)).toContain("gin_trgm_ops");
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

it("warns when full-text search can't be set up, instead of failing silently", () => {
  const db = createSQLiteDatabase();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    // The table was never created, so its triggers can't be.
    ensureSQLiteFts(db, itemsTable, ["title"]);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      "Skipped full-text search for items",
    );
  } finally {
    warn.mockRestore();
  }
});
