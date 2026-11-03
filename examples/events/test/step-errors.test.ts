import { afterAll, beforeAll, describe, expect, it } from "bun:test";
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
import {
  buildWorkflows,
  registerWorkflowTransform,
} from "@brickkit/cli/workflows";

const REDIS_URL = process.env.REDIS_URL;
const root = new URL("..", import.meta.url).pathname;

// A typed step error crosses the Workflow SDK's serialization and is not retried.
describe.skipIf(!REDIS_URL)("a typed step error", () => {
  let app: ReturnType<typeof brick>;
  let seen: typeof import("./fixtures/reject-parcel").seen;

  beforeAll(async () => {
    await registerWorkflowTransform(root);
    const fixture = await import("./fixtures/reject-parcel");
    seen = fixture.seen;
    await buildWorkflows({ root });
    const { createWorld } = await import("@brickkit/redis-world");
    const items = sqliteTable("items", { id: integer("id").primaryKey() });
    const outbox = outboxTable("sqlite");
    const database = defineDatabase({ tables: { items, outbox } });
    syncSchema([items, outbox], database.getDb() as never);
    const service = defineService("parcels", { database });
    service.action({
      name: "ship",
      input: t.Object({}),
      execute: async ({ ctx }) => {
        await emitEvent(ctx, "parcel.shipped", {});
        return { ok: true };
      },
    });
    app = brick({
      services: [service],
      events: {
        world: createWorld({
          redis: REDIS_URL!,
          keyPrefix: `parcels-test:${crypto.randomUUID()}:`,
        }) as EventsWorld,
        workflows: { root },
        listeners: [
          defineListener({
            name: "ship-parcel",
            on: "parcel.shipped",
            workflow: fixture.shipParcel,
          }),
        ],
      },
      requestLogging: false,
      docs: false,
    });
    app.events!.start();
  });

  afterAll(async () => {
    await app.events!.stop();
  });

  it("reaches the workflow with its code and details, after one attempt", async () => {
    await app.handle(
      new Request("http://localhost/api/parcels/ship", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const deadline = Date.now() + 15_000;
    while (!seen.failure && Date.now() < deadline) {
      await app.events!.drain();
      await Bun.sleep(50);
    }
    expect(seen.failure).toEqual({
      code: "CARRIER_REJECTED",
      message: "The carrier refused the parcel",
      details: { reason: "oversize" },
    });
    expect(seen.attempts).toBe(1);
  });
});
