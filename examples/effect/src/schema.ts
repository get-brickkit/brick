import { integer, scheduleTable, sqliteTable, text } from "@brickkit/core";

export const monitors = sqliteTable("monitors", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  url: text("url").notNull(),
});

export const checks = sqliteTable("checks", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  monitorId: text("monitor_id").notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  status: integer("status"),
  latencyMs: integer("latency_ms"),
  error: text("error"),
  checkedAt: integer("checked_at").notNull(),
});

export const schedules = scheduleTable("sqlite");
