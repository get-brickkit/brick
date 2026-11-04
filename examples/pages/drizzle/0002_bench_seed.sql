-- Seed the benchmark lookup table (bench/run.ts): ids 1..100.
INSERT INTO "bench_items" ("id", "name", "value")
SELECT i, 'item-' || i, i * 10 FROM generate_series(1, 100) AS i;
