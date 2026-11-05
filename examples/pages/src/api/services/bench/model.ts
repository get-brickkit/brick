import { integer, pgTable, text } from "@brickkit/core/pg";

// The benchmark's lookup table. Not part of the app's schema or migrations:
// bench/run.ts creates and seeds it (ids 1..100) in the benchmark's own
// database (scripts/migrations.ts, seedBench). The Go and Rust services only query it.
export const benchItemsTable = pgTable("bench_items", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  value: integer("value").notNull(),
});
