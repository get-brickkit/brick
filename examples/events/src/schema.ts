import {
  integer,
  outboxTable,
  scheduleTable,
  sqliteTable,
  text,
} from "@brickkit/core";

export const orders = sqliteTable("orders", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  customer: text("customer").notNull(),
  totalCents: integer("total_cents").notNull(),
  status: text("status").notNull().default("placed"),
  internalNote: text("internal_note"),
});

export const auditLog = sqliteTable("audit_log", {
  id: text("id").primaryKey(),
  event: text("event").notNull(),
  orderId: text("order_id").notNull(),
  detail: text("detail").notNull(),
});

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  orderId: text("order_id").notNull(),
  recipient: text("recipient").notNull(),
  detail: text("detail"),
});

export const outbox = outboxTable("sqlite");
export const schedules = scheduleTable("sqlite");

export type OrderRow = {
  id: string;
  customer: string;
  totalCents: number;
  status: string;
};
