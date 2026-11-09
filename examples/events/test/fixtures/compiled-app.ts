import {
  brick,
  defineDatabase,
  defineListener,
  defineService,
  emitEvent,
  integer,
  outboxTable,
  sqliteTable,
  syncSchema,
  t,
  type EventsWorld,
} from "@brickkit/core";
import { createWorld } from "@brickkit/redis-world";
import { recordGreeting } from "./compiled-workflow";

/**
 * An app built by `brick build` and run as a compiled server (#109). As in a
 * real deployment, its world and workflow listener exist only when the env
 * names a Redis at run time, never at build time.
 */
const redis = process.env.COMPILED_APP_REDIS_URL;

// A job that holds the process open, as an app's timers or Redis clients do.
setInterval(() => {}, 60_000);

const items = sqliteTable("items", { id: integer("id").primaryKey() });
const outbox = outboxTable("sqlite");
const database = defineDatabase({ tables: { items, outbox } });
syncSchema([items, outbox], database.getDb() as never);

const service = defineService("greetings", { database });
service.action({
  name: "request",
  input: t.Object({}),
  execute: async ({ ctx }) => {
    await emitEvent(ctx, "greeting.requested", {});
    return { ok: true };
  },
});

export default brick({
  services: [service],
  events: {
    world: redis
      ? (createWorld({
          redis,
          keyPrefix: `compiled-test:${crypto.randomUUID()}:`,
        }) as EventsWorld)
      : undefined,
    listeners: redis
      ? [
          defineListener({
            name: "greet",
            on: "greeting.requested",
            workflow: recordGreeting,
          }),
        ]
      : [],
  },
  requestLogging: false,
  docs: false,
});
