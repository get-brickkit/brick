import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
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

// Bundling the workflows on a cold CI runner can pass bun's 5s hook default.
setDefaultTimeout(20_000);

// A workflow that waits for a webhook is resumed by a request to the Brick server:
// the route, and the URL the Workflow SDK builds for it, are what is checked here.
describe.skipIf(!REDIS_URL)("a workflow waiting on a webhook", () => {
  let app: ReturnType<typeof brick>;
  let seen: typeof import("./fixtures/await-approval").seen;

  beforeAll(async () => {
    await registerWorkflowTransform(root);
    const fixture = await import("./fixtures/await-approval");
    seen = fixture.seen;
    await buildWorkflows({ root });
    const { createWorld } = await import("@brickkit/redis-world");
    const items = sqliteTable("items", { id: integer("id").primaryKey() });
    const outbox = outboxTable("sqlite");
    const database = defineDatabase({ tables: { items, outbox } });
    syncSchema([items, outbox], database.getDb() as never);
    const service = defineService("approvals", { database });
    service.action({
      name: "request",
      input: t.Object({}),
      execute: async ({ ctx }) => {
        await emitEvent(ctx, "approval.requested", {});
        return { ok: true };
      },
    });
    app = brick({
      services: [service],
      events: {
        world: createWorld({
          redis: REDIS_URL!,
          keyPrefix: `orders-test:${crypto.randomUUID()}:`,
        }) as EventsWorld,
        workflows: { root },
        listeners: [
          defineListener({
            name: "approval",
            on: "approval.requested",
            workflow: fixture.awaitApproval,
          }),
        ],
      },
      requestLogging: false,
      docs: false,
    });
    app.listen(0);
    app.events!.start();
  });

  afterAll(async () => {
    await app.events!.stop();
    await app.stop();
  });

  it("resumes when its webhook URL is called on the server", async () => {
    const base = `http://localhost:${app.server!.port}`;
    await fetch(`${base}/api/approvals/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const deadline = Date.now() + 15_000;
    while (!seen.url && Date.now() < deadline) await Bun.sleep(50);
    // The SDK finds the port with @workflow/utils, which the example lists for this.
    expect(seen.url).toStartWith(`${base}/.well-known/workflow/v1/webhook/`);

    const response = await fetch(seen.url!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true }),
    });
    expect(response.status).toBe(202);
    while (!seen.body && Date.now() < deadline) await Bun.sleep(50);
    expect(seen.body).toEqual({ approved: true });
  });
});
