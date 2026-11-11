import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
  setSystemTime,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetGlobalRegistry, type EventsWorld } from "@brickkit/core";
import { createCarrier } from "../src/carrier";
import { auditLog, notifications, outbox } from "../src/schema";

const ROOT = join(import.meta.dir, "..");
const REDIS_URL = process.env.REDIS_URL;

// Workflow listeners run on a Redis world. With REDIS_URL set, the workflow files
// are transformed and bundled before the app is imported, so it is imported late.
if (REDIS_URL) {
  // A run waits out step retries and a 1s sleep, and its tests poll for up to
  // 15s: past bun's 5s default on bullmq-world, whose delayed jobs are slower.
  setDefaultTimeout(20_000);
  const { buildWorkflows, registerWorkflowTransform } =
    await import("@brickkit/cli/workflows");
  await registerWorkflowTransform(ROOT);
  await buildWorkflows({ root: ROOT });
}
const { createOrdersApp } = await import("../src/create-app");

type OrdersApp = ReturnType<typeof createOrdersApp>;

const FAST_RETRY = { timer: false, maxBackoffMs: 1 } as const;
const opened: OrdersApp[] = [];
const directories: string[] = [];

function open(options: Partial<Parameters<typeof createOrdersApp>[0]> = {}) {
  const made = createOrdersApp({
    path: ":memory:",
    dispatch: FAST_RETRY,
    ...options,
  });
  opened.push(made);
  return made;
}

function call(
  { app }: OrdersApp,
  path: string,
  method = "GET",
  body?: unknown,
) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );
}

async function place(made: OrdersApp, extra: Record<string, unknown> = {}) {
  const response = await call(made, "/api/orders/order", "POST", {
    customer: "ada@example.com",
    totalCents: 4200,
    ...extra,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; status: string };
}

const ship = (made: OrdersApp, id: string) =>
  call(made, `/api/orders/order/${id}/ship`, "POST", {});

const rows = (made: OrdersApp, table: typeof auditLog | typeof notifications) =>
  (made.database.getDb() as any).select().from(table);

async function settle(made: OrdersApp, done: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  for (;;) {
    await made.app.events!.drain();
    if (await done()) return;
    if (Date.now() > deadline) throw new Error("deliveries did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => resetGlobalRegistry());

afterEach(async () => {
  for (const made of opened.splice(0)) {
    await made.app.events?.stop();
    await made.database.close?.();
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  resetGlobalRegistry();
});

describe("events from generated writes", () => {
  it("records an event with the write and delivers it to every listener that wants it", async () => {
    const made = open();
    const order = await place(made);
    expect(await made.app.events!.counts()).toMatchObject({ pending: 2 });

    await made.app.events!.drain();

    expect(await made.app.events!.counts()).toMatchObject({
      pending: 0,
      delivered: 2,
    });
    expect(await rows(made, auditLog)).toEqual([
      expect.objectContaining({
        event: "order.create",
        orderId: order.id,
        detail: "placed by ada@example.com",
      }),
    ]);
    expect(await rows(made, notifications)).toEqual([
      expect.objectContaining({
        kind: "receipt",
        orderId: order.id,
        recipient: "ada@example.com",
      }),
    ]);
  });

  it("an update carries before and after, and only the ship command books the carrier", async () => {
    const carrier = createCarrier();
    const made = open({ carrier });
    const order = await place(made);
    await call(made, `/api/orders/order/${order.id}`, "PATCH", {
      data: { internalNote: "gift wrap" },
    });
    await made.app.events!.drain();
    expect(carrier.bookings).toEqual([]);

    expect((await ship(made, order.id)).status).toBe(200);
    await made.app.events!.drain();
    // The command's rule: only a placed order ships, and a refusal records nothing.
    const again = await ship(made, order.id);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "NOT_PLACED" });
    expect(await made.app.events!.counts()).toMatchObject({ pending: 0 });

    expect(carrier.bookings).toEqual([order.id]);
    const audit = await rows(made, auditLog);
    expect(audit.map((row: any) => row.detail).sort()).toEqual([
      "no visible change",
      "placed by ada@example.com",
      "shipped",
    ]);
    expect(await rows(made, notifications)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "shipped",
          recipient: "ada@example.com",
        }),
      ]),
    );
  });

  it("a delete is audited", async () => {
    const made = open();
    const order = await place(made);
    expect(
      (await call(made, `/api/orders/order/${order.id}`, "DELETE")).status,
    ).toBe(200);
    await made.app.events!.drain();
    expect(
      (await rows(made, auditLog)).map((row: any) => row.event).sort(),
    ).toEqual(["order.create", "order.delete"]);
  });

  it("reads emit nothing", async () => {
    const made = open();
    const order = await place(made);
    await made.app.events!.drain();
    await call(made, `/api/orders/order/${order.id}`);
    await call(made, "/api/orders/order/query", "POST", {});
    expect(await made.app.events!.counts()).toMatchObject({
      pending: 0,
      delivered: 2,
    });
  });

  it("a write that is refused records no event", async () => {
    const made = open();
    const response = await call(made, "/api/orders/order", "POST", {
      customer: "ada@example.com",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await (made.database.getDb() as any).select().from(outbox)).toEqual(
      [],
    );
  });

  it("never puts a column the resource does not let clients read into an event", async () => {
    const made = open();
    await place(made, { internalNote: "top secret note" });
    const stored = await (made.database.getDb() as any).select().from(outbox);
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain("top secret note");
    expect(JSON.stringify(stored)).not.toContain("internalNote");
  });
});

describe("failures and retries", () => {
  it("retries a listener that throws until it succeeds, without repeating the others", async () => {
    const carrier = createCarrier({ failures: 2 });
    const made = open({ carrier });
    const order = await place(made);
    await made.app.events!.drain();
    await ship(made, order.id);

    await settle(
      made,
      async () => (await made.app.events!.counts()).delivered === 4,
    );

    expect(carrier.bookings).toEqual([order.id]);
    expect(await made.app.events!.counts()).toMatchObject({
      pending: 0,
      dead: 0,
    });
    expect(await rows(made, notifications)).toHaveLength(2);
    expect(await rows(made, auditLog)).toHaveLength(2);
  });

  it("parks a delivery as dead when its attempts run out, then delivers it after retryDead", async () => {
    const carrier = createCarrier({ failures: 99 });
    const made = open({ carrier });
    const order = await place(made);
    await ship(made, order.id);

    await settle(
      made,
      async () => (await made.app.events!.counts()).dead === 1,
    );
    expect(carrier.bookings).toEqual([]);
    // The audit and receipt deliveries of the same events were not held up.
    expect(await rows(made, auditLog)).toHaveLength(2);

    carrier.failNext(0);
    expect(await made.app.events!.retryDead()).toBe(1);
    await made.app.events!.drain();

    expect(carrier.bookings).toEqual([order.id]);
    expect(await made.app.events!.counts()).toMatchObject({ dead: 0 });
    expect(await rows(made, notifications)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "shipped" })]),
    );
  });

  it("running a delivery twice changes nothing, because rows are keyed by delivery id", async () => {
    const made = open();
    await place(made);
    await made.app.events!.drain();

    (made.database.getDb() as any)
      .update(outbox)
      .set({ status: "pending", deliveredAt: null })
      .run();
    await made.app.events!.drain();

    expect(await rows(made, auditLog)).toHaveLength(1);
    expect(await rows(made, notifications)).toHaveLength(1);
  });
});

describe("schedules", () => {
  it("reminds the warehouse of unshipped orders at 09:00 Berlin time on weekdays", async () => {
    // Friday 2026-01-09, 08:59 in Berlin (UTC+1).
    setSystemTime(new Date("2026-01-09T07:59:00Z"));
    try {
      const made = open();
      const order = await place(made);
      const shipped = await place(made);
      expect((await ship(made, shipped.id)).status).toBe(200);
      const schedules = made.app.events!.schedules!;
      expect(await schedules.drain()).toBe(0);
      expect((await schedules.list())[0]!.nextRunAt).toBe(
        "2026-01-09T08:00:00.000Z",
      );

      setSystemTime(new Date("2026-01-09T08:00:00Z"));
      expect(await schedules.drain()).toBe(1);
      const reminders = (await rows(made, notifications)).filter(
        (row: { kind: string }) => row.kind === "unshipped",
      );
      expect(reminders).toEqual([
        expect.objectContaining({ orderId: order.id }),
      ]);
      // Next is Monday morning: weekends are skipped.
      expect((await schedules.list())[0]!.nextRunAt).toBe(
        "2026-01-12T08:00:00.000Z",
      );
    } finally {
      setSystemTime();
    }
  });
});

describe("a process that restarts", () => {
  it("delivers what an API-only process recorded", async () => {
    const directory = mkdtempSync(join(tmpdir(), "brick-events-example-"));
    directories.push(directory);
    const path = join(directory, "orders.sqlite");

    const recorder = createOrdersApp({ path, dispatch: false });
    const order = await place(recorder);
    await recorder.app.events!.stop();
    await recorder.database.close?.();
    resetGlobalRegistry();

    const worker = open({ path, dispatch: { intervalMs: 20 } });
    worker.app.events!.start();
    await settle(
      worker,
      async () => (await worker.app.events!.counts()).delivered === 2,
    );

    expect(await rows(worker, auditLog)).toEqual([
      expect.objectContaining({ event: "order.create", orderId: order.id }),
    ]);
    expect(await rows(worker, notifications)).toHaveLength(1);
  });
});

// Shipping as a durable workflow needs a Redis world: REDIS_URL=redis://localhost:6379 bun test
for (const worldPackage of ["redis-world", "bullmq-world"] as const)
  describe.skipIf(!REDIS_URL)(
    `shipping as a workflow on ${worldPackage}`,
    () => {
      async function open2(
        options: Partial<Parameters<typeof createOrdersApp>[0]> = {},
        prefix?: string,
      ) {
        const { createWorld } = await import(`@brickkit/${worldPackage}`);
        const keyPrefix = prefix ?? `orders-test:${crypto.randomUUID()}:`;
        // Worlds with the same job prefix would take each other's queued messages.
        const world = createWorld({
          redis: REDIS_URL!,
          keyPrefix,
          jobPrefix: keyPrefix.replaceAll(":", "_"),
        });
        return open({ world: world as EventsWorld, ...options });
      }

      async function until<T>(
        what: string,
        probe: () => Promise<T | undefined | false>,
        timeoutMs = 15_000,
      ): Promise<T> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const found = await probe();
          if (found) return found;
          if (Date.now() > deadline)
            throw new Error(`Timed out waiting for ${what}`);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }

      const shipped = async (made: OrdersApp) =>
        (await rows(made, notifications)).find(
          (row: any) => row.kind === "shipped",
        );

      /** The workflow run a delivery started: its id follows from the delivery's id and time. */
      async function runOf(made: OrdersApp) {
        const [row] = (
          (await (made.database.getDb() as any).select().from(outbox)) as any[]
        ).filter((row) => row.listener === "fulfilment");
        const world = (made.app.events as any).runtime.world;
        const runId = `wrun_${world.createRunId({
          runKey: row.id,
          runKeyTime: row.occurredAt.getTime(),
        })}`;
        return { runId, world, row };
      }

      async function runStatus(made: OrdersApp, terminal: string) {
        const { runId, world } = await runOf(made);
        return until(`run ${runId} to be ${terminal}`, async () => {
          const run = await world.runs.get(runId, { resolveData: "none" });
          return run.status === terminal ? run : undefined;
        });
      }

      it("books the carrier, waits, and notifies, as one run", async () => {
        const carrier = createCarrier();
        const made = await open2({ carrier });
        const order = await place(made);
        await made.app.events!.drain();
        await ship(made, order.id);
        await made.app.events!.drain();

        const notice = await until("the shipped notification", () =>
          shipped(made),
        );

        expect(notice).toMatchObject({
          id: expect.stringMatching(/:fulfilment$/),
          orderId: order.id,
          recipient: "ada@example.com",
          detail: `trk_${order.id.slice(0, 8)}`,
        });
        expect(carrier.bookings).toEqual([order.id]);
        await runStatus(made, "completed");
        expect(await made.app.events!.counts()).toMatchObject({
          pending: 0,
          dead: 0,
        });
      });

      it("does not run for an update that is not a shipment", async () => {
        const carrier = createCarrier();
        const made = await open2({ carrier });
        const order = await place(made);
        await call(made, `/api/orders/order/${order.id}`, "PATCH", {
          data: { internalNote: "gift wrap" },
        });
        await made.app.events!.drain();

        const stored = await (made.database.getDb() as any)
          .select()
          .from(outbox);
        expect(stored.some((row: any) => row.listener === "fulfilment")).toBe(
          false,
        );
        expect(carrier.bookings).toEqual([]);
        expect(await shipped(made)).toBeUndefined();
      });

      it("retries the booking step when the carrier fails, and books once", async () => {
        const carrier = createCarrier({ failures: 2 });
        const made = await open2({ carrier });
        const order = await place(made);
        await ship(made, order.id);
        await made.app.events!.drain();

        await until("the shipped notification", () => shipped(made));

        expect(carrier.bookings).toEqual([order.id]);
        await runStatus(made, "completed");
        // The retries happened inside the run: the delivery was never retried.
        const [delivery] = (
          (await (made.database.getDb() as any).select().from(outbox)) as any[]
        ).filter((row) => row.listener === "fulfilment");
        expect(delivery).toMatchObject({ status: "delivered", attempts: 1 });
      });

      it("fails the run, not the delivery, when the carrier never answers", async () => {
        const carrier = createCarrier({ failures: 99 });
        const made = await open2({ carrier });
        const order = await place(made);
        await ship(made, order.id);
        await made.app.events!.drain();

        await runStatus(made, "failed");

        expect(await shipped(made)).toBeUndefined();
        expect(await made.app.events!.counts()).toMatchObject({
          pending: 0,
          dead: 0,
        });
      });

      it("starts one run however often the delivery is tried", async () => {
        const carrier = createCarrier();
        const made = await open2({ carrier });
        const order = await place(made);
        await ship(made, order.id);
        await made.app.events!.drain();
        await until("the shipped notification", () => shipped(made));

        (made.database.getDb() as any)
          .update(outbox)
          .set({ status: "pending", deliveredAt: null })
          .run();
        await made.app.events!.drain();
        await new Promise((resolve) => setTimeout(resolve, 1500));

        expect(carrier.bookings).toEqual([order.id]);
        expect(
          (await rows(made, notifications)).filter(
            (row: any) => row.kind === "shipped",
          ),
        ).toHaveLength(1);
      });

      it("finishes a run that was in flight when the process went away", async () => {
        const directory = mkdtempSync(join(tmpdir(), "brick-events-example-"));
        directories.push(directory);
        const path = join(directory, "orders.sqlite");
        const prefix = `orders-test:${crypto.randomUUID()}:`;
        const carrier = createCarrier();

        const first = await open2({ path, carrier }, prefix);
        const order = await place(first);
        await first.app.events!.drain();
        await ship(first, order.id);
        await first.app.events!.drain();
        opened.splice(opened.indexOf(first), 1);
        await first.app.events!.stop();
        await first.database.close?.();
        resetGlobalRegistry();

        const second = await open2({ path, carrier }, prefix);
        second.app.events!.start();

        await until("the shipped notification after the restart", () =>
          shipped(second),
        );
        expect(carrier.bookings).toEqual([order.id]);
        await runStatus(second, "completed");
      });
    },
  );
