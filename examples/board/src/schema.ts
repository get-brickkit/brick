import { integer, outboxTable, sqliteTable, text } from "@brickkit/core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

/** A thread in a channel. A task is a thread with a `tasks` row of the same id. */
export const threads = sqliteTable("threads", {
  id: id(),
  channel: text("channel").notNull(),
  text: text("text").notNull(),
  author: text("author").notNull(),
  /** `key=value` labels as a JSON object. `board.*` keys are the board's own. */
  labels: text("labels", { mode: "json" })
    .$type<Record<string, string>>()
    .notNull()
    .default({}),
  followUpAt: integer("follow_up_at"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const messages = sqliteTable("messages", {
  id: id(),
  threadId: text("thread_id").notNull(),
  author: text("author").notNull(),
  text: text("text").notNull(),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const tasks = sqliteTable("tasks", {
  /** The id of the task's thread. */
  id: text("id").primaryKey(),
  channel: text("channel").notNull(),
  state: text("state").notNull().default("ready"),
  holder: text("holder"),
  /** Raised by every claim: a write from an older claim is refused. */
  epoch: integer("epoch").notNull().default(0),
  leaseUntil: integer("lease_until"),
  result: text("result"),
  createdAt: integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const outbox = outboxTable("sqlite");
