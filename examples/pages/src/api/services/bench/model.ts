import { integer, pgTable, text } from "@brickkit/core/pg";

// The benchmark's lookup table: owned and migrated by TS (drizzle/), seeded
// with ids 1..100 by migration 0002. The Go and Rust services only query it.
export const benchItemsTable = pgTable("bench_items", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  value: integer("value").notNull(),
});
