import { randomUUID } from "node:crypto";
import { EntityConflictError } from "@workflow/errors";
import { eventIdToSlot, slotToEventId } from "@workflow/world";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from "../src/storage.js";
import { describeRedis, redisUrl } from "./helpers.js";

// The v5 spec makes an event id the event's position in its run's log. These
// tests pin the parts a type check cannot: slots are chosen at the commit, stay
// dense under concurrency, and a stale writer is bumped and told what it missed.
describeRedis("slot-numbered event log (Redis integration)", () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(redisUrl);
  });

  afterAll(async () => {
    await redis.quit();
  });

  /** Fresh storage under a prefix of its own, so tests never see each other. */
  function createStorage() {
    const config = { redis, keyPrefix: `slots:${randomUUID()}:` };
    return {
      runs: createRunsStorage(config),
      steps: createStepsStorage(config),
      events: createEventsStorage(config),
      hooks: createHooksStorage(config),
    };
  }
  type Storage = ReturnType<typeof createStorage>;

  async function startRun(storage: Storage) {
    const created = await storage.events.create(null, {
      eventType: "run_created",
      eventData: { deploymentId: "d", workflowName: "w", input: [] },
    });
    const runId = created.run!.runId;
    await storage.events.create(runId, { eventType: "run_started" });
    return runId;
  }

  async function slotsOf(storage: Storage, runId: string) {
    const log = await storage.events.list({
      runId,
      pagination: { limit: 1000 },
    });
    return log.data.map((event) => eventIdToSlot(event.eventId));
  }

  it("numbers a run from slot 1 and keeps it dense", async () => {
    const storage = createStorage();
    const created = await storage.events.create(null, {
      eventType: "run_created",
      eventData: { deploymentId: "d", workflowName: "w", input: [] },
    });
    expect(created.event?.eventId).toBe(slotToEventId(1));
    const runId = created.run!.runId;

    const started = await storage.events.create(runId, {
      eventType: "run_started",
    });
    expect(started.event?.eventId).toBe(slotToEventId(2));
    expect(await slotsOf(storage, runId)).toEqual([1, 2]);
  });

  it("builds the same event ids as slotToEventId, across digit boundaries", async () => {
    // The ids are padded inside the Lua script, which cannot call slotToEventId.
    const storage = createStorage();
    const runId = await startRun(storage);
    for (let i = 0; i < 125; i++) {
      await storage.events.create(runId, {
        eventType: "step_created",
        correlationId: `step-${i}`,
        eventData: { stepName: "s", input: [] },
      });
    }
    const log = await storage.events.list({
      runId,
      pagination: { limit: 1000 },
    });
    expect(log.data.map((event) => event.eventId)).toEqual(
      Array.from({ length: 127 }, (_, i) => slotToEventId(i + 1)),
    );
  });

  it("keeps the log dense when many writers race for the same slot", async () => {
    const storage = createStorage();
    const runId = await startRun(storage);
    const writers = 40;

    // Every writer holds the same stale view: it has seen run_created and run_started.
    const results = await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        storage.events.create(
          runId,
          {
            eventType: "step_created",
            correlationId: `step-${i}`,
            eventData: { stepName: "s", input: [] },
          },
          { eventCount: 2 },
        ),
      ),
    );

    // No write was refused, and no two writes took the same slot.
    const slots = results.map((result) =>
      eventIdToSlot(result.event!.eventId)!,
    );
    expect(new Set(slots).size).toBe(writers);
    expect([...slots].sort((x, y) => x - y)).toEqual(
      Array.from({ length: writers }, (_, i) => i + 3),
    );

    // The log has no holes.
    expect(await slotsOf(storage, runId)).toEqual(
      Array.from({ length: writers + 2 }, (_, i) => i + 1),
    );
  });

  it("reports the events a stale writer skipped over, and nothing else", async () => {
    const storage = createStorage();
    const runId = await startRun(storage);
    const writers = 12;

    const results = await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        storage.events.create(
          runId,
          {
            eventType: "step_created",
            correlationId: `step-${i}`,
            eventData: { stepName: "s", input: [] },
          },
          { eventCount: 2 },
        ),
      ),
    );

    for (const result of results) {
      const landed = eventIdToSlot(result.event!.eventId)!;
      const reported = (result.events ?? []).map((event) =>
        eventIdToSlot(event.eventId),
      );
      // Exactly the slots between the one asked for (3) and the one landed on.
      expect(reported).toEqual(
        Array.from({ length: landed - 3 }, (_, i) => i + 3),
      );
      // A report is a lower bound, not a read to the end: it must not move the cursor.
      if (landed > 3) {
        expect(result.cursor).toBeNull();
        expect(result.hasMore).toBe(false);
      }
    }
  });

  it("reports nothing when the writer was current", async () => {
    const storage = createStorage();
    const runId = await startRun(storage);
    const result = await storage.events.create(
      runId,
      {
        eventType: "step_created",
        correlationId: "step-current",
        eventData: { stepName: "s", input: [] },
      },
      { eventCount: 2 },
    );
    expect(result.event?.eventId).toBe(slotToEventId(3));
    expect(result.events).toBeUndefined();
  });

  it("accepts a write that carries no eventCount", async () => {
    const storage = createStorage();
    const runId = await startRun(storage);
    await storage.events.create(runId, {
      eventType: "step_created",
      correlationId: "step-a",
      eventData: { stepName: "s", input: [] },
    });
    const result = await storage.events.create(runId, {
      eventType: "step_created",
      correlationId: "step-b",
      eventData: { stepName: "s", input: [] },
    });
    expect(result.event?.eventId).toBe(slotToEventId(4));
    expect(result.events).toBeUndefined();
  });

  it("returns an inline delta after sinceCursor that includes the write itself", async () => {
    const storage = createStorage();
    const runId = await startRun(storage);
    await storage.events.create(runId, {
      eventType: "step_created",
      correlationId: "step-a",
      eventData: { stepName: "s", input: [] },
    });

    // The writer last read slot 2; the delta is everything after it.
    const result = await storage.events.create(
      runId,
      {
        eventType: "step_created",
        correlationId: "step-b",
        eventData: { stepName: "s", input: [] },
      },
      { sinceCursor: slotToEventId(2), eventCount: 2 },
    );
    expect(result.events?.map((event) => eventIdToSlot(event.eventId))).toEqual(
      [3, 4],
    );
    expect(result.cursor).toBe(slotToEventId(4));
    expect(result.hasMore).toBe(false);
  });

  it("pages a run forward and backward by slot", async () => {
    const storage = createStorage();
    const runId = await startRun(storage);
    for (let i = 0; i < 5; i++) {
      await storage.events.create(runId, {
        eventType: "step_created",
        correlationId: `step-${i}`,
        eventData: { stepName: "s", input: [] },
      });
    }

    const first = await storage.events.list({
      runId,
      pagination: { limit: 3 },
    });
    expect(first.data.map((e) => eventIdToSlot(e.eventId))).toEqual([1, 2, 3]);
    expect(first.hasMore).toBe(true);

    const second = await storage.events.list({
      runId,
      pagination: { limit: 3, cursor: first.cursor! },
    });
    expect(second.data.map((e) => eventIdToSlot(e.eventId))).toEqual([4, 5, 6]);
    expect(second.hasMore).toBe(true);

    const third = await storage.events.list({
      runId,
      pagination: { limit: 3, cursor: second.cursor! },
    });
    expect(third.data.map((e) => eventIdToSlot(e.eventId))).toEqual([7]);
    expect(third.hasMore).toBe(false);

    const newest = await storage.events.list({
      runId,
      pagination: { limit: 3, sortOrder: "desc" },
    });
    expect(newest.data.map((e) => eventIdToSlot(e.eventId))).toEqual([7, 6, 5]);
    expect(newest.hasMore).toBe(true);
  });

  describe("step outcome races", () => {
    it("records only one of two concurrent step_completed writes", async () => {
      const storage = createStorage();
      const runId = await startRun(storage);
      await storage.events.create(runId, {
        eventType: "step_created",
        correlationId: "step-1",
        eventData: { stepName: "s", input: [] },
      });
      await storage.events.create(runId, {
        eventType: "step_started",
        correlationId: "step-1",
      });

      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          storage.events.create(runId, {
            eventType: "step_completed",
            correlationId: "step-1",
            eventData: { result: new Uint8Array([1]) },
          }),
        ),
      );
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      const completed = (await storage.events.list({ runId })).data.filter(
        (e) => e.eventType === "step_completed",
      );
      expect(completed).toHaveLength(1);
    });
  });

  describe("run status", () => {
    it("lets only one of two concurrent run_started writes append the event", async () => {
      const storage = createStorage();
      const created = await storage.events.create(null, {
        eventType: "run_created",
        eventData: { deploymentId: "d", workflowName: "w", input: [] },
      });
      const runId = created.run!.runId;

      await Promise.all(
        Array.from({ length: 8 }, () =>
          storage.events.create(runId, { eventType: "run_started" }),
        ),
      );
      const started = (await storage.events.list({ runId })).data.filter(
        (e) => e.eventType === "run_started",
      );
      expect(started).toHaveLength(1);
    });
  });

  describe("listing", () => {
    async function runsInStates(storage: Storage, name: string) {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const created = await storage.events.create(null, {
          eventType: "run_created",
          eventData: { deploymentId: "d", workflowName: name, input: [] },
        });
        ids.push(created.run!.runId);
        // Distinct transition times keep the order unambiguous.
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
      for (const runId of ids.slice(0, 3)) {
        await storage.events.create(runId, { eventType: "run_started" });
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
      return ids;
    }

    async function pageThrough(
      storage: Storage,
      params: Parameters<Storage["runs"]["list"]>[0],
      limit: number,
    ) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await storage.runs.list({
          ...params,
          pagination: { ...params?.pagination, limit, cursor },
        });
        seen.push(...result.data.map((run) => run.runId));
        if (!result.hasMore) return seen;
        cursor = result.cursor ?? undefined;
      }
      throw new Error("paging did not end");
    }

    it("visits every run once when paging across several statuses", async () => {
      const storage = createStorage();
      const ids = await runsInStates(storage, "merged");
      const desc = await pageThrough(
        storage,
        { status: ["pending", "running"] },
        2,
      );
      expect([...desc].sort()).toEqual([...ids].sort());
      expect(new Set(desc).size).toBe(ids.length);

      // Ascending is the same set in the opposite order.
      const asc = await pageThrough(
        storage,
        { status: ["pending", "running"], pagination: { sortOrder: "asc" } },
        2,
      );
      expect(asc).toEqual([...desc].reverse());
    });

    it("lists hooks oldest first and runs newest first by default", async () => {
      const storage = createStorage();
      const runId = await startRun(storage);
      for (const name of ["a", "b", "c"]) {
        await storage.events.create(runId, {
          eventType: "hook_created",
          correlationId: `hook-${name}`,
          eventData: { token: `token-${name}-${randomUUID()}` },
        });
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
      const hooks = await storage.hooks.list({ runId });
      expect(hooks.data.map((hook) => hook.hookId)).toEqual([
        "hook-a",
        "hook-b",
        "hook-c",
      ]);
      const newest = await storage.hooks.list({
        runId,
        pagination: { sortOrder: "desc" },
      });
      expect(newest.data.map((hook) => hook.hookId)).toEqual([
        "hook-c",
        "hook-b",
        "hook-a",
      ]);
    });
  });

  describe("attributes", () => {
    it("seeds attributes at creation and returns them on reads", async () => {
      const storage = createStorage();
      const created = await storage.events.create(null, {
        eventType: "run_created",
        eventData: {
          deploymentId: "d",
          workflowName: "w",
          input: [],
          attributes: { team: "core" },
        },
      });
      expect(created.run?.attributes).toEqual({ team: "core" });
      const read = await storage.runs.get(created.run!.runId);
      expect(read.attributes).toEqual({ team: "core" });
    });

    it("keeps concurrent changes to different keys", async () => {
      const storage = createStorage();
      const runId = await startRun(storage);
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          storage.events.create(runId, {
            eventType: "attr_set",
            eventData: {
              changes: [{ key: `k${i}`, value: `v${i}` }],
              writer: { type: "workflow" },
            },
          } as never),
        ),
      );
      const run = await storage.runs.get(runId);
      expect(Object.keys(run.attributes).sort()).toEqual(
        Array.from({ length: 10 }, (_, i) => `k${i}`).sort(),
      );
    });
  });

  describe("attr_set", () => {
    const set = (
      storage: Storage,
      runId: string,
      extra: Record<string, unknown> = {},
    ) =>
      storage.events.create(runId, {
        eventType: "attr_set",
        eventData: {
          changes: [{ key: "k", value: "v" }],
          writer: { type: "workflow" },
        },
        ...extra,
      } as never);

    it("is refused on a finished run", async () => {
      const storage = createStorage();
      const runId = await startRun(storage);
      await storage.events.create(runId, { eventType: "run_cancelled" });
      await expect(set(storage, runId)).rejects.toBeInstanceOf(
        EntityConflictError,
      );
    });

    it("is applied once per correlation id when a workflow replays it", async () => {
      const storage = createStorage();
      const runId = await startRun(storage);
      await set(storage, runId, { correlationId: "attr_1" });
      await expect(
        set(storage, runId, { correlationId: "attr_1" }),
      ).rejects.toBeInstanceOf(EntityConflictError);
    });
  });

  describe("lazy hook resume", () => {
    async function runWithHook(storage: Storage) {
      const runId = await startRun(storage);
      await storage.events.create(runId, {
        eventType: "hook_created",
        correlationId: "hook-1",
        eventData: { token: `token-${randomUUID()}` },
      });
      return runId;
    }

    it("converges two writers with one resumeId on a single event", async () => {
      const storage = createStorage();
      const runId = await runWithHook(storage);

      const writes = await Promise.all(
        Array.from({ length: 5 }, () =>
          storage.events.create(
            runId,
            {
              eventType: "hook_received",
              correlationId: "hook-1",
              eventData: { payload: new Uint8Array([9]) },
            },
            { resumeId: "resume-1", resumePayloadDigest: "digest-a" },
          ),
        ),
      );
      expect(new Set(writes.map((w) => w.event?.eventId)).size).toBe(1);
      const received = (await storage.events.list({ runId })).data.filter(
        (e) => e.eventType === "hook_received",
      );
      expect(received).toHaveLength(1);
    });

    it("refuses a reused resumeId that carries a different payload", async () => {
      const storage = createStorage();
      const runId = await runWithHook(storage);
      const write = (digest: string) =>
        storage.events.create(
          runId,
          {
            eventType: "hook_received",
            correlationId: "hook-1",
            eventData: { payload: new Uint8Array([9]) },
          },
          { resumeId: "resume-2", resumePayloadDigest: digest },
        );
      await write("digest-a");
      await expect(write("digest-b")).rejects.toBeInstanceOf(
        EntityConflictError,
      );
    });
  });
});
