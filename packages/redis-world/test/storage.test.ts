import { setTimeout } from "node:timers/promises";
import { type Event, eventIdToSlot, slotToEventId } from "@workflow/world";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keys } from "../src/keys.js";
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from "../src/storage.js";
import { createStreamer } from "../src/streamer.js";
import { describeRedis, expectRejectedWith, redisUrl } from "./helpers.js";

describeRedis("Storage (Redis integration)", () => {
  let redis: Redis;
  let runs: ReturnType<typeof createRunsStorage>;
  let steps: ReturnType<typeof createStepsStorage>;
  let events: ReturnType<typeof createEventsStorage>;
  let _hooks: ReturnType<typeof createHooksStorage>;

  const keyPrefix = "workflow:test:";
  const k = keys(keyPrefix);

  async function flushTestKeys() {
    const found = await redis.keys(`${keyPrefix}*`);
    if (found.length > 0) {
      await redis.del(...found);
    }
  }

  async function createRun(opts?: {
    deploymentId?: string;
    workflowName?: string;
    input?: any;
    executionContext?: Record<string, any>;
  }) {
    const result = await events.create(null, {
      eventType: "run_created",
      eventData: {
        deploymentId: opts?.deploymentId ?? "deployment-123",
        workflowName: opts?.workflowName ?? "test-workflow",
        input: opts?.input ?? [],
        executionContext: opts?.executionContext,
      },
    });
    return result.run!;
  }

  async function createStep(
    runId: string,
    opts?: { stepId?: string; stepName?: string; input?: any },
  ) {
    const stepId = opts?.stepId ?? "step-123";
    const result = await events.create(runId, {
      eventType: "step_created",
      correlationId: stepId,
      eventData: {
        stepName: opts?.stepName ?? "test-step",
        input: opts?.input ?? ["input1"],
      },
    });
    return result.step!;
  }

  beforeAll(() => {
    redis = new Redis(redisUrl);
    const config = { redis, keyPrefix };
    runs = createRunsStorage(config);
    steps = createStepsStorage(config);
    events = createEventsStorage(config);
    _hooks = createHooksStorage(config);
  });

  beforeEach(async () => {
    await flushTestKeys();
  });

  afterAll(async () => {
    await redis.quit();
  });

  describe("runs", () => {
    describe("create via event", () => {
      it("should create a new workflow run via run_created event", async () => {
        const run = await createRun({
          deploymentId: "deployment-123",
          workflowName: "test-workflow",
          executionContext: { userId: "user-1" },
          input: ["arg1", "arg2"],
        });

        expect(run.runId).toMatch(/^wrun_/);
        expect(run.deploymentId).toBe("deployment-123");
        expect(run.status).toBe("pending");
        expect(run.workflowName).toBe("test-workflow");
        expect(run.executionContext).toEqual({ userId: "user-1" });
        expect(run.input).toEqual(["arg1", "arg2"]);
        expect(run.output).toBeUndefined();
        expect(run.error).toBeUndefined();
        expect(run.startedAt).toBeUndefined();
        expect(run.completedAt).toBeUndefined();
        expect(run.createdAt).toBeInstanceOf(Date);
        expect(run.updatedAt).toBeInstanceOf(Date);
      });

      it("should handle minimal run data", async () => {
        const run = await createRun({
          deploymentId: "deployment-123",
          workflowName: "minimal-workflow",
          input: [],
        });

        expect(run.input).toEqual([]);
      });
    });

    describe("get", () => {
      it("should retrieve an existing run", async () => {
        const created = await createRun({
          deploymentId: "deployment-123",
          workflowName: "test-workflow",
          input: ["arg"],
        });

        const retrieved = await runs.get(created.runId);
        expect(retrieved.runId).toBe(created.runId);
        expect(retrieved.workflowName).toBe("test-workflow");
        expect(retrieved.input).toEqual(["arg"]);
      });

      it("should throw WorkflowRunNotFoundError for non-existent run", async () => {
        await expect(runs.get("missing")).rejects.toMatchObject({
          name: "WorkflowRunNotFoundError",
        });
      });
    });

    describe("status transitions via events", () => {
      it("should update run status to running via run_started event", async () => {
        const created = await createRun();

        const result = await events.create(created.runId, {
          eventType: "run_started",
        });

        expect(result.run?.status).toBe("running");
        expect(result.run?.startedAt).toBeInstanceOf(Date);
      });

      it("should update run status to completed via run_completed event", async () => {
        const created = await createRun();

        await events.create(created.runId, {
          eventType: "run_started",
        });

        const result = await events.create(created.runId, {
          eventType: "run_completed",
          eventData: { output: [{ result: 42 }] },
        });

        expect(result.run?.status).toBe("completed");
        expect(result.run?.completedAt).toBeInstanceOf(Date);
      });

      it("should keep a run_failed error as the raw serialized value, with errorCode beside it", async () => {
        const created = await createRun();
        await events.create(created.runId, { eventType: "run_started" });

        // The error is whatever the runtime serialized the thrown value to;
        // the world neither reshapes it nor nests the code inside it.
        const serialized = new Uint8Array([9, 8, 7, 255]);
        const result = await events.create(created.runId, {
          eventType: "run_failed",
          eventData: { error: serialized, errorCode: "USER_ERROR" },
        });

        expect(result.run?.status).toBe("failed");
        expect(result.run?.error).toEqual(serialized);
        expect(result.run?.errorCode).toBe("USER_ERROR");

        const reread = await runs.get(created.runId);
        expect(reread.error).toEqual(serialized);
        expect(reread.errorCode).toBe("USER_ERROR");
      });

      it("should accept a plain string error and leave errorCode unset without one", async () => {
        const created = await createRun();
        await events.create(created.runId, { eventType: "run_started" });

        const result = await events.create(created.runId, {
          eventType: "run_failed",
          eventData: { error: "plain failure" },
        });

        expect(result.run?.error).toBe("plain failure");
        expect(result.run?.errorCode).toBeUndefined();
      });
    });

    describe("list", () => {
      it("should list all runs", async () => {
        const run1 = await createRun({
          deploymentId: "deployment-1",
          workflowName: "workflow-1",
        });

        await setTimeout(5);

        const run2 = await createRun({
          deploymentId: "deployment-2",
          workflowName: "workflow-2",
        });

        const result = await runs.list();

        expect(result.data).toHaveLength(2);
        // Should be in descending order (most recent first)
        expect(result.data[0].runId).toBe(run2.runId);
        expect(result.data[1].runId).toBe(run1.runId);
      });

      it("should filter runs by workflowName", async () => {
        await createRun({
          deploymentId: "deployment-1",
          workflowName: "workflow-1",
        });
        const run2 = await createRun({
          deploymentId: "deployment-2",
          workflowName: "workflow-2",
        });

        const result = await runs.list({ workflowName: "workflow-2" });

        expect(result.data).toHaveLength(1);
        expect(result.data[0].runId).toBe(run2.runId);
      });

      describe("status filter", () => {
        let pending: string;
        let running: string;
        let completed: string;
        let cancelled: string;

        beforeEach(async () => {
          pending = (await createRun()).runId;
          running = (await createRun()).runId;
          await events.create(running, { eventType: "run_started" });
          completed = (await createRun()).runId;
          await events.create(completed, { eventType: "run_started" });
          await events.create(completed, {
            eventType: "run_completed",
            eventData: { output: [] },
          });
          cancelled = (await createRun()).runId;
          await events.create(cancelled, { eventType: "run_cancelled" });
        });

        const ids = (result: { data: { runId: string }[] }) =>
          result.data.map((r) => r.runId).sort();

        it("should filter by a single status", async () => {
          expect(ids(await runs.list({ status: "running" }))).toEqual([
            running,
          ]);
          expect(ids(await runs.list({ status: "pending" }))).toEqual([
            pending,
          ]);
        });

        it("should match a run whose status is any of an array of statuses", async () => {
          const result = await runs.list({ status: ["running", "completed"] });
          expect(ids(result)).toEqual([running, completed].sort());
        });

        it("should treat a one-element array like the plain status", async () => {
          expect(ids(await runs.list({ status: ["cancelled"] }))).toEqual([
            cancelled,
          ]);
        });

        it("should match nothing for an empty status array, unlike omitting the filter", async () => {
          const none = await runs.list({ status: [] });
          expect(none.data).toEqual([]);
          expect(none.hasMore).toBe(false);

          const all = await runs.list();
          expect(all.data).toHaveLength(4);
        });

        it("should combine an array of statuses with a workflowName filter", async () => {
          const named = (await createRun({ workflowName: "named-workflow" }))
            .runId;
          await events.create(named, { eventType: "run_started" });

          const result = await runs.list({
            workflowName: "named-workflow",
            status: ["running", "completed"],
          });
          expect(ids(result)).toEqual([named]);
        });

        it("should paginate an array filter without gaps or repeats", async () => {
          const collected: string[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 10; page++) {
            const result = await runs.list({
              status: ["pending", "running", "completed"],
              pagination: { limit: 2, ...(cursor ? { cursor } : {}) },
            });
            collected.push(...result.data.map((r) => r.runId));
            if (!result.hasMore) break;
            cursor = result.cursor ?? undefined;
          }
          expect([...collected].sort()).toEqual(
            [pending, running, completed].sort(),
          );
        });
      });
    });

    describe("cancel via event", () => {
      it("should cancel a run via run_cancelled event", async () => {
        const created = await createRun();

        const result = await events.create(created.runId, {
          eventType: "run_cancelled",
        });

        expect(result.run?.status).toBe("cancelled");
        expect(result.run?.completedAt).toBeInstanceOf(Date);
      });
    });
  });

  describe("steps", () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun();
      testRunId = run.runId;
    });

    describe("create via event", () => {
      it("should create a new step via step_created event", async () => {
        const step = await createStep(testRunId, {
          stepId: "step-123",
          stepName: "test-step",
          input: ["input1", "input2"],
        });

        expect(step.runId).toBe(testRunId);
        expect(step.stepId).toBe("step-123");
        expect(step.stepName).toBe("test-step");
        expect(step.status).toBe("pending");
        expect(step.input).toEqual(["input1", "input2"]);
        expect(step.attempt).toBe(0);
      });
    });

    describe("get", () => {
      it("should retrieve a step", async () => {
        const created = await createStep(testRunId, {
          stepId: "step-123",
          stepName: "test-step",
          input: ["input1"],
        });

        const retrieved = await steps.get(testRunId, "step-123");
        expect(retrieved.stepId).toBe(created.stepId);
      });

      it("should throw error for non-existent step", async () => {
        await expect(
          steps.get(testRunId, "missing-step"),
        ).rejects.toMatchObject({ status: 404 });
      });

      it("should scope a step id to its run", async () => {
        // A step id only identifies a step within its run, so two runs can use
        // the same one and `steps.get` has to be told which run it means.
        const otherRun = await createRun();
        await createStep(testRunId, {
          stepId: "shared-step",
          stepName: "first-run-step",
        });
        await createStep(otherRun.runId, {
          stepId: "shared-step",
          stepName: "second-run-step",
        });

        const first = await steps.get(testRunId, "shared-step");
        expect(first.runId).toBe(testRunId);
        expect(first.stepName).toBe("first-run-step");

        const second = await steps.get(otherRun.runId, "shared-step");
        expect(second.runId).toBe(otherRun.runId);
        expect(second.stepName).toBe("second-run-step");
      });

      it("should not find a step through a different run", async () => {
        const otherRun = await createRun();
        await createStep(testRunId, { stepId: "only-in-first-run" });

        await expect(
          steps.get(otherRun.runId, "only-in-first-run"),
        ).rejects.toMatchObject({
          status: 404,
        });
      });
    });

    describe("update via events", () => {
      it("should update step status to completed via step_completed event", async () => {
        await createStep(testRunId, {
          stepId: "step-123",
          stepName: "test-step",
          input: ["input1"],
        });

        await events.create(testRunId, {
          eventType: "step_started",
          correlationId: "step-123",
        });

        const result = await events.create(testRunId, {
          eventType: "step_completed",
          correlationId: "step-123",
          eventData: { result: ["ok"] },
        });

        expect(result.step?.status).toBe("completed");
        expect(result.step?.completedAt).toBeInstanceOf(Date);
      });

      it("should increment attempt on step_started", async () => {
        await createStep(testRunId, {
          stepId: "step-123",
          stepName: "test-step",
          input: ["input1"],
        });

        const result = await events.create(testRunId, {
          eventType: "step_started",
          correlationId: "step-123",
        });

        expect(result.step?.attempt).toBe(1);
      });

      it("should store a step_failed error as the raw serialized value", async () => {
        await createStep(testRunId, { stepId: "step-err" });
        await events.create(testRunId, {
          eventType: "step_started",
          correlationId: "step-err",
        });

        // The runtime hands the world whatever it serialized the thrown value
        // to; the world keeps it verbatim rather than reshaping it.
        const serialized = new Uint8Array([1, 2, 3, 250]);
        const result = await events.create(testRunId, {
          eventType: "step_failed",
          correlationId: "step-err",
          eventData: { error: serialized },
        });

        expect(result.step?.status).toBe("failed");
        expect(result.step?.error).toEqual(serialized);
        const persisted = await steps.get(testRunId, "step-err");
        expect(persisted.error).toEqual(serialized);
      });
    });

    describe("lazy start via step_started", () => {
      it("should create a running step plus a synthetic step_created event", async () => {
        const result = await events.create(testRunId, {
          eventType: "step_started",
          correlationId: "lazy-step",
          eventData: { stepName: "lazy-step-name", input: ["lazy-input"] },
        });

        expect(result.stepCreated).toBe(true);
        expect(result.step).toMatchObject({
          runId: testRunId,
          stepId: "lazy-step",
          stepName: "lazy-step-name",
          input: ["lazy-input"],
          status: "running",
          attempt: 1,
        });
        expect(result.step?.startedAt).toBeInstanceOf(Date);

        const persisted = await steps.get(testRunId, "lazy-step");
        expect(persisted.status).toBe("running");
        expect(persisted.attempt).toBe(1);

        // Replay still observes the creation: step_created lands ahead of the
        // step_started, in consecutive slots.
        const log = await events.listByCorrelationId({
          runId: testRunId,
          correlationId: "lazy-step",
        });
        expect(log.data.map((e) => e.eventType)).toEqual([
          "step_created",
          "step_started",
        ]);
        expect(
          eventIdToSlot(log.data[1].eventId)! -
            eventIdToSlot(log.data[0].eventId)!,
        ).toBe(1);
        expect(log.data[1].eventId).toBe(result.event?.eventId);
        // The input rides the synthetic step_created, not the start.
        expect(
          (log.data[1].eventData as { input?: unknown }).input,
        ).toBeUndefined();
      });

      it("should let exactly one of several concurrent lazy starts claim the step", async () => {
        const settled = await Promise.allSettled(
          Array.from({ length: 5 }, () =>
            events.create(testRunId, {
              eventType: "step_started",
              correlationId: "lazy-race",
              eventData: { stepName: "lazy-race-name", input: [] },
            }),
          ),
        );

        expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expectRejectedWith(settled, "EntityConflictError");
        const log = await events.listByCorrelationId({
          runId: testRunId,
          correlationId: "lazy-race",
        });
        expect(log.data.map((e) => e.eventType)).toEqual([
          "step_created",
          "step_started",
        ]);
      });

      it("should refuse a lazy start on a terminal run", async () => {
        await events.create(testRunId, { eventType: "run_started" });
        await events.create(testRunId, {
          eventType: "run_completed",
          eventData: { output: [] },
        });

        await expect(
          events.create(testRunId, {
            eventType: "step_started",
            correlationId: "lazy-after-terminal",
            eventData: { stepName: "late", input: [] },
          }),
        ).rejects.toMatchObject({ name: "RunExpiredError" });
      });
    });

    describe("terminal run", () => {
      it("should refuse step_started even when the step still reads running", async () => {
        await createStep(testRunId, { stepId: "claimed-step" });
        await events.create(testRunId, { eventType: "run_started" });
        await events.create(testRunId, {
          eventType: "step_started",
          correlationId: "claimed-step",
        });
        await events.create(testRunId, {
          eventType: "run_completed",
          eventData: { output: [] },
        });

        // A redelivery of a start some earlier delivery already claimed.
        await expect(
          events.create(testRunId, {
            eventType: "step_started",
            correlationId: "claimed-step",
          }),
        ).rejects.toMatchObject({ name: "RunExpiredError" });
      });

      it("should still accept step_completed for a step already in flight", async () => {
        await createStep(testRunId, { stepId: "in-flight-step" });
        await events.create(testRunId, { eventType: "run_started" });
        await events.create(testRunId, {
          eventType: "step_started",
          correlationId: "in-flight-step",
        });
        await events.create(testRunId, {
          eventType: "run_completed",
          eventData: { output: [] },
        });

        const result = await events.create(testRunId, {
          eventType: "step_completed",
          correlationId: "in-flight-step",
          eventData: { result: ["late"] },
        });
        expect(result.step?.status).toBe("completed");
      });
    });
  });

  describe("events", () => {
    let testRunId: string;

    beforeEach(async () => {
      const run = await createRun();
      testRunId = run.runId;
    });

    describe("create", () => {
      it("should create a new event", async () => {
        // First create a step so step_started has a target
        await createStep(testRunId, {
          stepId: "corr_123",
          stepName: "test-step",
        });

        const result = await events.create(testRunId, {
          eventType: "step_started",
          correlationId: "corr_123",
        });

        expect(result.event?.runId).toBe(testRunId);
        // Event ids are log positions: run_created is slot 1, step_created
        // slot 2, so this step_started is slot 3.
        expect(result.event?.eventId).toBe(slotToEventId(3));
        expect(result.event?.eventType).toBe("step_started");
        expect(result.event?.correlationId).toBe("corr_123");
        expect(result.event?.createdAt).toBeInstanceOf(Date);
      });

      it("should reuse event ids across runs and tell them apart by run", async () => {
        // Event ids are unique only within a run: both runs' first event is slot 1.
        const other = await createRun();
        const mine = await events.get(testRunId, slotToEventId(1));
        const theirs = await events.get(other.runId, slotToEventId(1));

        expect(mine.eventId).toBe(theirs.eventId);
        expect(mine.runId).toBe(testRunId);
        expect(theirs.runId).toBe(other.runId);
        expect(mine.eventType).toBe("run_created");
      });

      it("should throw 404 from events.get for an event the run does not hold", async () => {
        await expect(
          events.get(testRunId, slotToEventId(99)),
        ).rejects.toMatchObject({
          status: 404,
        });
      });

      it("should strip eventData from a stored run_started event", async () => {
        await events.create(testRunId, {
          eventType: "run_started",
          eventData: {
            deploymentId: "deployment-123",
            workflowName: "test-workflow",
            input: ["should-not-be-stored"],
          },
        });

        const log = await events.list({
          runId: testRunId,
          pagination: { sortOrder: "asc" },
        });
        const started = log.data.find((e) => e.eventType === "run_started");
        expect(started).toBeDefined();
        expect(started && "eventData" in started).toBe(false);
      });

      it("should create a new event with null byte in payload", async () => {
        await createStep(testRunId, {
          stepId: "corr_123",
          stepName: "test-step",
        });

        await events.create(testRunId, {
          eventType: "step_started",
          correlationId: "corr_123",
        });

        const result = await events.create(testRunId, {
          eventType: "step_failed",
          correlationId: "corr_123",
          eventData: { error: "Error with null byte \u0000 in message" },
        });

        expect(result.event?.runId).toBe(testRunId);
        // run_created, step_created, step_started, then this step_failed.
        expect(result.event?.eventId).toBe(slotToEventId(4));
        expect(result.event?.eventType).toBe("step_failed");
        expect(result.event?.correlationId).toBe("corr_123");
        expect(result.event?.createdAt).toBeInstanceOf(Date);
      });
    });

    describe("list", () => {
      it("should list all events for a run", async () => {
        // The run_created event is already created by createRun
        // Create a second event
        const startResult = await events.create(testRunId, {
          eventType: "run_started",
        });

        const result = await events.list({
          runId: testRunId,
          pagination: { sortOrder: "asc" },
        });

        // run_created + run_started
        expect(result.data.length).toBeGreaterThanOrEqual(2);
        expect(result.data[0].eventType).toBe("run_created");
        expect(result.data[1].eventId).toBe(startResult.event?.eventId);
      });
    });

    describe("listByCorrelationId", () => {
      it("should list events by correlation ID", async () => {
        const correlationId = "step-abc123";

        await createStep(testRunId, {
          stepId: correlationId,
          stepName: "test-step",
        });

        const startResult = await events.create(testRunId, {
          eventType: "step_started",
          correlationId,
        });

        const completeResult = await events.create(testRunId, {
          eventType: "step_completed",
          correlationId,
          eventData: { result: "success" },
        });

        const result = await events.listByCorrelationId({
          runId: testRunId,
          correlationId,
          pagination: {},
        });

        // step_created + step_started + step_completed
        expect(result.data).toHaveLength(3);
        expect(result.data[0].eventType).toBe("step_created");
        expect(result.data[1].eventId).toBe(startResult.event?.eventId);
        expect(result.data[2].eventId).toBe(completeResult.event?.eventId);
      });

      it("should handle hook lifecycle events", async () => {
        const hookId = "hook_test123";

        // Create a typical hook lifecycle
        const createdResult = await events.create(testRunId, {
          eventType: "hook_created",
          correlationId: hookId,
          eventData: { token: "test-token-123" },
        });

        const received1Result = await events.create(testRunId, {
          eventType: "hook_received",
          correlationId: hookId,
          eventData: { payload: { request: 1 } },
        });

        const received2Result = await events.create(testRunId, {
          eventType: "hook_received",
          correlationId: hookId,
          eventData: { payload: { request: 2 } },
        });

        const disposedResult = await events.create(testRunId, {
          eventType: "hook_disposed",
          correlationId: hookId,
        });

        const result = await events.listByCorrelationId({
          runId: testRunId,
          correlationId: hookId,
          pagination: {},
        });

        expect(result.data).toHaveLength(4);
        expect(result.data[0].eventId).toBe(createdResult.event?.eventId);
        expect(result.data[0].eventType).toBe("hook_created");
        expect(result.data[1].eventId).toBe(received1Result.event?.eventId);
        expect(result.data[1].eventType).toBe("hook_received");
        expect(result.data[2].eventId).toBe(received2Result.event?.eventId);
        expect(result.data[2].eventType).toBe("hook_received");
        expect(result.data[3].eventId).toBe(disposedResult.event?.eventId);
        expect(result.data[3].eventType).toBe("hook_disposed");
      });

      const sharedCorrelationId = "hook-shared-correlation";

      // A hook is addressable from any run, so two runs can emit events under
      // one correlation id. Interleave them three apiece; a lookup is always
      // scoped to one run because a correlation id is only unique within its run.
      async function seedInterleavedRuns() {
        const runA = await createRun();
        const runB = await createRun();

        const a1 = await events.create(runA.runId, {
          eventType: "hook_created",
          correlationId: sharedCorrelationId,
          eventData: { token: "token-shared-correlation" },
        });
        const b1 = await events.create(runB.runId, {
          eventType: "hook_received",
          correlationId: sharedCorrelationId,
          eventData: { payload: { request: 1 } },
        });
        const a2 = await events.create(runA.runId, {
          eventType: "hook_received",
          correlationId: sharedCorrelationId,
          eventData: { payload: { request: 2 } },
        });
        const b2 = await events.create(runB.runId, {
          eventType: "hook_received",
          correlationId: sharedCorrelationId,
          eventData: { payload: { request: 3 } },
        });
        const a3 = await events.create(runA.runId, {
          eventType: "hook_received",
          correlationId: sharedCorrelationId,
          eventData: { payload: { request: 4 } },
        });
        const b3 = await events.create(runB.runId, {
          eventType: "hook_received",
          correlationId: sharedCorrelationId,
          eventData: { payload: { request: 5 } },
        });

        return {
          runA: runA.runId,
          runB: runB.runId,
          a: [a1, a2, a3].map((r) => r.event!.eventId),
          b: [b1, b2, b3].map((r) => r.event!.eventId),
        };
      }

      it("should scope events to the requested run", async () => {
        const seeded = await seedInterleavedRuns();

        const result = await events.listByCorrelationId({
          correlationId: sharedCorrelationId,
          runId: seeded.runA,
          pagination: {},
        });

        expect(result.data.map((e) => e.eventId)).toEqual(seeded.a);
        expect(result.data.every((e) => e.runId === seeded.runA)).toBe(true);
        expect(result.hasMore).toBe(false);
      });

      it("should keep the two runs apart even though their event ids collide", async () => {
        const seeded = await seedInterleavedRuns();

        // Event ids are log positions, unique only within a run: each run's
        // three events sit in slots 2-4 behind its run_created.
        expect(seeded.a).toEqual([2, 3, 4].map(slotToEventId));
        expect(seeded.b).toEqual(seeded.a);

        const forA = await events.listByCorrelationId({
          correlationId: sharedCorrelationId,
          runId: seeded.runA,
        });
        const forB = await events.listByCorrelationId({
          correlationId: sharedCorrelationId,
          runId: seeded.runB,
        });

        expect(forA.data.map((e) => e.eventType)).toEqual([
          "hook_created",
          "hook_received",
          "hook_received",
        ]);
        expect(forA.data.every((e) => e.runId === seeded.runA)).toBe(true);
        expect(forB.data.map((e) => e.eventType)).toEqual([
          "hook_received",
          "hook_received",
          "hook_received",
        ]);
        expect(forB.data.every((e) => e.runId === seeded.runB)).toBe(true);
      });

      it("should return nothing for a run that never used the correlation id", async () => {
        const seeded = await seedInterleavedRuns();
        const bystander = await createRun();

        const result = await events.listByCorrelationId({
          correlationId: sharedCorrelationId,
          runId: bystander.runId,
        });

        expect(seeded.a).toHaveLength(3);
        expect(result.data).toEqual([]);
        expect(result.hasMore).toBe(false);
      });

      it("should paginate the scoped set without gaps or duplicates", async () => {
        const seeded = await seedInterleavedRuns();

        const page1 = await events.listByCorrelationId({
          correlationId: sharedCorrelationId,
          runId: seeded.runA,
          pagination: { limit: 2 },
        });

        expect(page1.data.map((e) => e.eventId)).toEqual([
          seeded.a[0],
          seeded.a[1],
        ]);
        expect(page1.hasMore).toBe(true);
        expect(page1.cursor).toBe(seeded.a[1]);

        const page2 = await events.listByCorrelationId({
          correlationId: sharedCorrelationId,
          runId: seeded.runA,
          pagination: { limit: 2, cursor: page1.cursor ?? undefined },
        });

        expect(page2.data.map((e) => e.eventId)).toEqual([seeded.a[2]]);
        expect(page2.hasMore).toBe(false);
      });
    });
  });

  describe("Event idempotency", () => {
    it("rejects a duplicate step_created with EntityConflictError", async () => {
      const run = await createRun();
      const stepId = "step-idempotent-test";

      const result1 = await events.create(run.runId, {
        eventType: "step_created",
        correlationId: stepId,
        eventData: { stepName: "test-step", input: ["input1"] },
      });
      expect(result1.step).toBeDefined();
      expect(result1.step!.stepId).toBe(stepId);

      // Redelivered step_created: the runtime catches EntityConflictError as
      // its dedup signal. Returning success would append a second
      // step_created row and poison replay with ReplayDivergenceError.
      await expect(
        events.create(run.runId, {
          eventType: "step_created",
          correlationId: stepId,
          eventData: { stepName: "test-step", input: ["input1"] },
        }),
      ).rejects.toMatchObject({ name: "EntityConflictError" });

      const listResult = await steps.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(1);
      expect(listResult.data[0].stepId).toBe(stepId);

      const eventList = await events.list({
        runId: run.runId,
        pagination: { sortOrder: "asc" },
      });
      expect(
        eventList.data.filter((e) => e.eventType === "step_created"),
      ).toHaveLength(1);
    });

    it("rejects a duplicate wait_created with EntityConflictError", async () => {
      const run = await createRun();
      const waitId = "wait-idempotent-test";
      const eventData = {
        eventType: "wait_created" as const,
        correlationId: waitId,
        eventData: { resumeAt: new Date(Date.now() + 60_000) },
      };

      await events.create(run.runId, eventData);

      // Waits have no entity in this world; the event log is the only
      // dedup surface guarding a replayed wait_created.
      await expect(events.create(run.runId, eventData)).rejects.toMatchObject({
        name: "EntityConflictError",
      });

      const eventList = await events.list({
        runId: run.runId,
        pagination: { sortOrder: "asc" },
      });
      expect(
        eventList.data.filter((e) => e.eventType === "wait_created"),
      ).toHaveLength(1);
    });

    it("rejects a duplicate run_created with EntityConflictError", async () => {
      const result1 = await events.create(null, {
        eventType: "run_created",
        eventData: {
          deploymentId: "test-deployment",
          workflowName: "test-workflow-idempotent",
          input: [],
        },
      });
      expect(result1.run).toBeDefined();
      const runId = result1.run!.runId;

      // A redelivered run_created must not return the existing run AND
      // append a second run_created row; core catches EntityConflictError
      // as "the run already exists" on its concurrent-create path.
      await expect(
        events.create(runId, {
          eventType: "run_created",
          eventData: {
            deploymentId: "test-deployment",
            workflowName: "test-workflow-idempotent",
            input: [],
          },
        }),
      ).rejects.toMatchObject({ name: "EntityConflictError" });

      const listResult = await runs.list({
        workflowName: "test-workflow-idempotent",
      });
      expect(listResult.data.some((r) => r.runId === runId)).toBe(true);

      const eventList = await events.list({ runId, pagination: {} });
      expect(
        eventList.data.filter((e) => e.eventType === "run_created"),
      ).toHaveLength(1);
    });

    it("concurrent creation deliveries settle on exactly one event row", async () => {
      const run = await createRun();

      // Steps: five racers, one entity, one step_created row.
      const stepId = "step-race";
      const stepResults = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          events.create(run.runId, {
            eventType: "step_created",
            correlationId: stepId,
            eventData: { stepName: "test-step", input: ["input1"] },
          }),
        ),
      );
      expect(stepResults.filter((r) => r.status === "fulfilled")).toHaveLength(
        1,
      );
      expectRejectedWith(stepResults, "EntityConflictError");
      const stepEvents = await events.listByCorrelationId({
        runId: run.runId,
        correlationId: stepId,
        pagination: {},
      });
      expect(stepEvents.data.map((e) => e.eventType)).toEqual(["step_created"]);

      // Hooks: five racers on one token, one hook_created row, no conflict.
      const hookId = "hook-race";
      const hookResults = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          events.create(run.runId, {
            eventType: "hook_created",
            correlationId: hookId,
            eventData: { token: "race-token" },
          }),
        ),
      );
      expect(hookResults.filter((r) => r.status === "fulfilled")).toHaveLength(
        1,
      );
      const hookEvents = await events.listByCorrelationId({
        runId: run.runId,
        correlationId: hookId,
        pagination: {},
      });
      expect(hookEvents.data.map((e) => e.eventType)).toEqual(["hook_created"]);
    });

    it("should handle duplicate hook_created events with different tokens", async () => {
      const run = await createRun();
      const hookId1 = "hook-idempotent-test-1";
      const hookId2 = "hook-idempotent-test-2";

      // Test idempotency by creating two separate hooks
      const result1 = await events.create(run.runId, {
        eventType: "hook_created",
        correlationId: hookId1,
        eventData: { token: "test-token-1" },
      });
      expect(result1.hook).toBeDefined();

      const result2 = await events.create(run.runId, {
        eventType: "hook_created",
        correlationId: hookId2,
        eventData: { token: "test-token-2" },
      });
      expect(result2.hook).toBeDefined();

      // Both hooks should be in the index
      const listResult = await _hooks.list({ runId: run.runId });
      expect(listResult.data).toHaveLength(2);
      expect(listResult.data.some((h) => h.hookId === hookId1)).toBe(true);
      expect(listResult.data.some((h) => h.hookId === hookId2)).toBe(true);
    });

    it("should not create duplicate run_started event on replay", async () => {
      const run = await createRun();

      const result1 = await events.create(run.runId, {
        eventType: "run_started",
      });
      expect(result1.run?.status).toBe("running");
      expect(result1.run?.startedAt).toBeInstanceOf(Date);
      const originalStartedAt = result1.run!.startedAt!;

      // Second run_started (replay scenario, should be idempotent)
      const result2 = await events.create(run.runId, {
        eventType: "run_started",
      });
      expect(result2.run?.status).toBe("running");
      // startedAt should be preserved from first call
      expect(result2.run!.startedAt!.getTime()).toBe(
        originalStartedAt.getTime(),
      );

      // Only ONE run_started event should exist in the log
      const eventList = await events.list({
        runId: run.runId,
        pagination: { sortOrder: "asc" },
      });
      const runStartedEvents = eventList.data.filter(
        (e) => e.eventType === "run_started",
      );
      expect(runStartedEvents).toHaveLength(1);
    });

    it("should throw WorkflowRunNotFoundError for run_started on missing run without bootstrap data", async () => {
      await expect(
        events.create("wrun_missing_run", { eventType: "run_started" }),
      ).rejects.toMatchObject({ name: "WorkflowRunNotFoundError" });
    });
  });

  describe("Error taxonomy (core matches errors by name)", () => {
    it("should throw EntityConflictError for step_started on a terminal step", async () => {
      const run = await createRun();
      const stepId = "step-terminal-guard";
      await createStep(run.runId, { stepId });
      await events.create(run.runId, {
        eventType: "step_started",
        correlationId: stepId,
      });
      await events.create(run.runId, {
        eventType: "step_completed",
        correlationId: stepId,
        eventData: { result: "ok" },
      });

      await expect(
        events.create(run.runId, {
          eventType: "step_started",
          correlationId: stepId,
        }),
      ).rejects.toMatchObject({ name: "EntityConflictError" });
    });

    it("should throw EntityConflictError for duplicate step_completed", async () => {
      const run = await createRun();
      const stepId = "step-double-complete";
      await createStep(run.runId, { stepId });
      await events.create(run.runId, {
        eventType: "step_started",
        correlationId: stepId,
      });
      await events.create(run.runId, {
        eventType: "step_completed",
        correlationId: stepId,
        eventData: { result: "ok" },
      });

      await expect(
        events.create(run.runId, {
          eventType: "step_completed",
          correlationId: stepId,
          eventData: { result: "ok again" },
        }),
      ).rejects.toMatchObject({ name: "EntityConflictError" });
    });

    it("should throw HookNotFoundError for hook_disposed on a missing hook", async () => {
      const run = await createRun();
      await expect(
        events.create(run.runId, {
          eventType: "hook_disposed",
          correlationId: "hook-never-created",
        }),
      ).rejects.toMatchObject({ name: "HookNotFoundError" });
    });

    it("should throw HookNotFoundError from hooks.get and hooks.getByToken", async () => {
      await expect(_hooks.get("missing-hook")).rejects.toMatchObject({
        name: "HookNotFoundError",
      });
      await expect(_hooks.getByToken("missing-token")).rejects.toMatchObject({
        name: "HookNotFoundError",
      });
    });
  });

  describe("hooks.list", () => {
    async function createHook(runId: string, hookId: string) {
      await events.create(runId, {
        eventType: "hook_created",
        correlationId: hookId,
        eventData: { token: `token-${hookId}` },
      });
    }

    const ids = (page: { data: { hookId: string }[] }) =>
      page.data.map((hook) => hook.hookId);

    it("should list the hooks of every run when no runId is given", async () => {
      const first = await createRun();
      const second = await createRun();
      await events.create(second.runId, { eventType: "run_started" });
      await createHook(first.runId, "hook-a1");
      await createHook(first.runId, "hook-a2");
      await createHook(second.runId, "hook-b1");

      const all = await _hooks.list({});
      expect(ids(all).sort()).toEqual(["hook-a1", "hook-a2", "hook-b1"]);
      expect(all.hasMore).toBe(false);
      expect(all.data.find((hook) => hook.hookId === "hook-b1")?.runId).toBe(
        second.runId,
      );
    });

    it("should list nothing when there are no hooks", async () => {
      await createRun();
      expect(await _hooks.list({})).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
      });
    });

    it("should only list the hooks of the run given by runId", async () => {
      const first = await createRun();
      const second = await createRun();
      await createHook(first.runId, "hook-a1");
      await createHook(second.runId, "hook-b1");
      await createHook(second.runId, "hook-b2");

      expect(ids(await _hooks.list({ runId: first.runId }))).toEqual([
        "hook-a1",
      ]);
      expect(ids(await _hooks.list({ runId: second.runId })).sort()).toEqual([
        "hook-b1",
        "hook-b2",
      ]);
    });

    it("should paginate across runs without gaps or repeats, in either order", async () => {
      const first = await createRun();
      const second = await createRun();
      for (const [runId, hookId] of [
        [first.runId, "hook-1"],
        [second.runId, "hook-2"],
        [first.runId, "hook-3"],
        [second.runId, "hook-4"],
        [first.runId, "hook-5"],
      ] as const) {
        await createHook(runId, hookId);
      }

      const asc = ids(
        await _hooks.list({ pagination: { sortOrder: "asc", limit: 100 } }),
      );
      expect([...asc].sort()).toEqual([
        "hook-1",
        "hook-2",
        "hook-3",
        "hook-4",
        "hook-5",
      ]);
      expect(
        ids(
          await _hooks.list({ pagination: { sortOrder: "desc", limit: 100 } }),
        ),
      ).toEqual([...asc].reverse());

      const paged: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const page = await _hooks.list({
          pagination: { sortOrder: "asc", limit: 2, cursor },
        });
        paged.push(...ids(page));
        pages++;
        if (!page.hasMore) break;
        expect(page.data).toHaveLength(2);
        cursor = page.cursor ?? undefined;
      }
      expect(pages).toBe(3);
      expect(paged).toEqual(asc);
    });

    it("should not list disposed hooks or the hooks of a finished run", async () => {
      const kept = await createRun();
      const disposing = await createRun();
      const finishing = await createRun();
      await events.create(finishing.runId, { eventType: "run_started" });
      await createHook(kept.runId, "hook-kept");
      await createHook(disposing.runId, "hook-disposed");
      await createHook(finishing.runId, "hook-finished");
      expect(ids(await _hooks.list({})).sort()).toEqual([
        "hook-disposed",
        "hook-finished",
        "hook-kept",
      ]);

      await events.create(disposing.runId, {
        eventType: "hook_disposed",
        correlationId: "hook-disposed",
      });
      await events.create(finishing.runId, {
        eventType: "run_completed",
        eventData: { output: [] },
      });

      expect(ids(await _hooks.list({}))).toEqual(["hook-kept"]);
      expect(await _hooks.list({ runId: disposing.runId })).toMatchObject({
        data: [],
      });
      expect(await _hooks.list({ runId: finishing.runId })).toMatchObject({
        data: [],
      });
    });
  });

  describe("step retry backoff (retryAfter)", () => {
    it("should reject early step_started with TooEarlyError while retryAfter is in the future", async () => {
      const run = await createRun();
      const stepId = "step-backoff";
      await createStep(run.runId, { stepId });
      await events.create(run.runId, {
        eventType: "step_started",
        correlationId: stepId,
      });
      await events.create(run.runId, {
        eventType: "step_retrying",
        correlationId: stepId,
        eventData: { error: "boom", retryAfter: new Date(Date.now() + 60_000) },
      });

      await expect(
        events.create(run.runId, {
          eventType: "step_started",
          correlationId: stepId,
        }),
      ).rejects.toMatchObject({ name: "TooEarlyError" });
    });

    it("should clear retryAfter once the step starts after the backoff window", async () => {
      const run = await createRun();
      const stepId = "step-backoff-elapsed";
      await createStep(run.runId, { stepId });
      await events.create(run.runId, {
        eventType: "step_started",
        correlationId: stepId,
      });
      await events.create(run.runId, {
        eventType: "step_retrying",
        correlationId: stepId,
        eventData: { error: "boom", retryAfter: new Date(Date.now() - 1000) },
      });

      const beforeRestart = await steps.get(run.runId, stepId);
      expect(beforeRestart.retryAfter).toBeInstanceOf(Date);

      const result = await events.create(run.runId, {
        eventType: "step_started",
        correlationId: stepId,
      });
      expect(result.step?.status).toBe("running");
      expect(result.step?.retryAfter).toBeUndefined();

      const persisted = await steps.get(run.runId, stepId);
      expect(persisted.retryAfter).toBeUndefined();
    });
  });

  describe("hook_created duplicate semantics", () => {
    it("should throw EntityConflictError for a duplicate hook_created of the same hook", async () => {
      const run = await createRun();
      const hookId = "hook-duplicate-same";
      const token = "token-duplicate-same";

      const first = await events.create(run.runId, {
        eventType: "hook_created",
        correlationId: hookId,
        eventData: { token },
      });
      expect(first.hook).toBeDefined();

      // Duplicate delivery of the SAME (runId, hookId): must be an
      // EntityConflictError, NOT a self hook_conflict event that would
      // poison later replays with HookConflictError.
      await expect(
        events.create(run.runId, {
          eventType: "hook_created",
          correlationId: hookId,
          eventData: { token },
        }),
      ).rejects.toMatchObject({ name: "EntityConflictError" });

      const eventList = await events.listByCorrelationId({
        runId: run.runId,
        correlationId: hookId,
        pagination: {},
      });
      expect(
        eventList.data.filter((e) => e.eventType === "hook_conflict"),
      ).toHaveLength(0);
      // Exactly one hook_created row: a duplicate that appended a second
      // creation event would poison replay with ReplayDivergenceError.
      expect(eventList.data.map((e) => e.eventType)).toEqual(["hook_created"]);
    });

    it("rejects a legacy crash orphan (hook entity without hook_created event)", async () => {
      const run = await createRun();
      const hookId = "hook-orphan";
      const token = "token-orphan";

      // Simulate a crash between the hook entity write and the event write:
      // create the hook entity + indexes directly, with no hook_created event.
      const orphanHook = {
        runId: run.runId,
        hookId,
        token,
        ownerId: "",
        projectId: "",
        environment: "",
        specVersion: 4,
        createdAt: new Date(),
      };
      await redis.set(k.hookKey(hookId), JSON.stringify(orphanHook));
      await redis.set(k.hooksByTokenKey(token), hookId);
      await redis.zadd(k.hooksIndexKey(run.runId), Date.now(), hookId);

      // Entity and creation event are now written in one atomic script, so
      // this state can only be legacy data. A replayed hook_created rejects
      // (the entity exists) rather than risking a duplicate append; it does
      // NOT record a self hook_conflict.
      await expect(
        events.create(run.runId, {
          eventType: "hook_created",
          correlationId: hookId,
          eventData: { token },
        }),
      ).rejects.toMatchObject({ name: "EntityConflictError" });

      const eventList = await events.listByCorrelationId({
        runId: run.runId,
        correlationId: hookId,
        pagination: {},
      });
      expect(
        eventList.data.filter((e) => e.eventType === "hook_created"),
      ).toHaveLength(0);
      expect(
        eventList.data.filter((e) => e.eventType === "hook_conflict"),
      ).toHaveLength(0);
    });

    it("should record hook_conflict with conflictingRunId when another run holds the token", async () => {
      const runA = await createRun();
      const runB = await createRun();
      const token = "token-cross-run";

      await events.create(runA.runId, {
        eventType: "hook_created",
        correlationId: "hook-owner",
        eventData: { token },
      });

      const result = await events.create(runB.runId, {
        eventType: "hook_created",
        correlationId: "hook-intruder",
        eventData: { token },
      });

      expect(result.hook).toBeUndefined();
      expect(result.event?.eventType).toBe("hook_conflict");
      expect(
        (result.event as { eventData?: { conflictingRunId?: string } })
          .eventData,
      ).toMatchObject({
        token,
        conflictingRunId: runA.runId,
      });
    });
  });

  describe("runs.list combined filtering", () => {
    it("should paginate correctly when combining workflowName and status filters", async () => {
      const workflowName = "combined-filter-workflow";

      // 12 runs of the same workflow; complete every other one, so 6 remain
      // pending. With limit 3 the pending runs span multiple index pages.
      const runIds: string[] = [];
      for (let i = 0; i < 12; i++) {
        const run = await createRun({ workflowName });
        runIds.push(run.runId);
        if (i % 2 === 0) {
          await events.create(run.runId, { eventType: "run_started" });
          await events.create(run.runId, {
            eventType: "run_completed",
            eventData: { output: ["done"] },
          });
        }
        await setTimeout(2);
      }

      const collected: string[] = [];
      let cursor: string | null | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await runs.list({
          workflowName,
          status: "pending",
          pagination: { limit: 3, ...(cursor ? { cursor } : {}) },
        });
        collected.push(...result.data.map((r) => r.runId));
        if (!result.hasMore) break;
        cursor = result.cursor;
      }

      const expectedPending = runIds.filter((_, i) => i % 2 === 1);
      expect(new Set(collected)).toEqual(new Set(expectedPending));
    });
  });

  describe("streamer", () => {
    it("should not drop chunks when stream sequence numbers cross a digit boundary", async () => {
      const streamer = createStreamer({ redis, keyPrefix });
      try {
        // Pre-populate a stream with entries in the same millisecond whose
        // sequence numbers cross the 9 -> 10 digit boundary. Lexicographic ID
        // comparison would drop entries 7-10 through 7-12 and the eof marker.
        // A stream is keyed by its run as well as its name.
        const runId = "wrun_digit_boundary";
        const streamName = "digit-boundary-stream";
        const key = k.streamKey(runId, streamName);
        for (let seq = 1; seq <= 12; seq++) {
          await redis.xadd(
            key,
            `7-${seq}`,
            "data",
            Buffer.from(`chunk-${seq}`).toString("base64"),
            "eof",
            "false",
          );
        }
        await redis.xadd(key, "7-13", "data", "", "eof", "true");

        const stream = await streamer.streams.get(runId, streamName);
        const reader = stream.getReader();
        const chunks: string[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(Buffer.from(value).toString());
        }

        expect(chunks).toEqual(
          Array.from({ length: 12 }, (_, i) => `chunk-${i + 1}`),
        );
      } finally {
        await streamer.close();
      }
    });
  });

  describe("binary payload serialization", () => {
    it("round-trips Uint8Array through storage using the tagged base64 encoding", async () => {
      const payload = new Uint8Array([0, 1, 2, 250, 255]);
      const run = await createRun({ input: [payload] });

      const fetched = await runs.get(run.runId);
      const roundTripped = (fetched.input as unknown[])[0];
      expect(roundTripped).toBeInstanceOf(Uint8Array);
      expect(Array.from(roundTripped as Uint8Array)).toEqual([
        0, 1, 2, 250, 255,
      ]);

      const raw = await redis.get(k.runKey(run.runId));
      expect(raw).toContain('"__type":"Uint8Array"');
      expect(raw).not.toContain("__uint8array");
    });

    it("round-trips a fat binary payload through a step result", async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: "run_started" });
      const step = await createStep(run.runId, { stepId: "fat-step" });
      await events.create(run.runId, {
        eventType: "step_started",
        correlationId: step.stepId,
      });

      const payload = new Uint8Array(64 * 1024);
      for (let i = 0; i < payload.length; i++) {
        payload[i] = i % 256;
      }
      const result = await events.create(run.runId, {
        eventType: "step_completed",
        correlationId: step.stepId,
        eventData: { result: payload },
      });

      const output = result.step?.output as Uint8Array;
      expect(output).toBeInstanceOf(Uint8Array);
      expect(output.length).toBe(payload.length);
      expect(output[1000]).toBe(payload[1000]);

      const raw = await redis.get(k.stepKey(run.runId, step.stepId));
      expect(raw).toContain('"__type":"Uint8Array"');
      expect(raw).not.toContain("__uint8array");
    });
  });

  describe("maxEvents (EventResult.maxEvents)", () => {
    it("reports the default per-run event ceiling on run_started", async () => {
      const run = await createRun();
      const result = await events.create(run.runId, {
        eventType: "run_started",
      });
      expect(result.maxEvents).toBe(25_000);
    });

    it("reports the ceiling again on the idempotent run_started replay", async () => {
      const run = await createRun();
      await events.create(run.runId, { eventType: "run_started" });
      const replay = await events.create(run.runId, {
        eventType: "run_started",
      });
      expect(replay.run?.status).toBe("running");
      expect(replay.maxEvents).toBe(25_000);
    });

    it("honours an explicit maxEventsPerRun config", async () => {
      const scoped = createEventsStorage({
        redis,
        keyPrefix,
        maxEventsPerRun: 10,
      });
      const created = await scoped.create(null, {
        eventType: "run_created",
        eventData: { deploymentId: "d", workflowName: "capped", input: [] },
      });
      expect(created.maxEvents).toBe(10);
      const started = await scoped.create(created.run!.runId, {
        eventType: "run_started",
      });
      expect(started.maxEvents).toBe(10);
    });

    it("rejects a maxEventsPerRun that is not a positive integer", () => {
      expect(() =>
        createEventsStorage({ redis, keyPrefix, maxEventsPerRun: 0 }),
      ).toThrow(TypeError);
      expect(() =>
        createEventsStorage({ redis, keyPrefix, maxEventsPerRun: 1.5 }),
      ).toThrow(TypeError);
    });
  });

  // The compact `run:meta:` key and the per-run hook token map are both
  // written going forward but are absent from runs that already existed when
  // they were introduced. Each read path has to degrade to the old behaviour
  // rather than mistake a missing key for a missing entity.
  describe("records written before the meta key and hook token map existed", () => {
    it("validates events against the run body when the meta key is missing", async () => {
      const run = await createRun();
      await redis.del(k.runMetaKey(run.runId));

      // step_created only consults status/specVersion, which now normally come
      // from the meta key; without it the run body must still be consulted.
      const step = await createStep(run.runId, { stepId: "step-no-meta" });
      expect(step.status).toBe("pending");
    });

    it("releases hook tokens on a terminal run via the token map", async () => {
      const run = await createRun();
      await events.create(run.runId, {
        eventType: "run_started",
        eventData: {},
      });
      await events.create(run.runId, {
        eventType: "hook_created",
        correlationId: "hook-mapped",
        eventData: { token: "token-mapped" },
      });
      await events.create(run.runId, {
        eventType: "run_completed",
        eventData: { output: "done" },
      });

      expect(await redis.get(k.hookKey("hook-mapped"))).toBeNull();
      expect(await redis.get(k.hooksByTokenKey("token-mapped"))).toBeNull();
      expect(await redis.exists(k.hooksTokenMapKey(run.runId))).toBe(0);
    });
  });

  // `parse` takes a fast path that skips JSON's reviver when the payload holds
  // no binary. Dates still have to come back as Dates on that path.
  describe("date revival on the non-binary fast path", () => {
    it("revives entity timestamps as Date instances", async () => {
      const run = await createRun();
      const reread = await runs.get(run.runId);
      expect(reread.createdAt).toBeInstanceOf(Date);
      expect(reread.updatedAt).toBeInstanceOf(Date);
    });

    it("revives retryAfter inside a stored event payload", async () => {
      const run = await createRun();
      await events.create(run.runId, {
        eventType: "run_started",
        eventData: {},
      });
      const step = await createStep(run.runId, { stepId: "step-retry-date" });
      await events.create(run.runId, {
        eventType: "step_started",
        correlationId: step.stepId,
        eventData: {},
      });

      const retryAfter = new Date(Date.now() + 30_000);
      await events.create(run.runId, {
        eventType: "step_retrying",
        correlationId: step.stepId,
        eventData: { error: "boom", retryAfter },
      });

      const stored = await events.listByCorrelationId({
        runId: run.runId,
        correlationId: step.stepId,
      });
      const retrying = stored.data.find((e) => e.eventType === "step_retrying");
      expect(
        (retrying?.eventData as { retryAfter?: unknown })?.retryAfter,
      ).toBeInstanceOf(Date);
    });

    it("revives dates when the payload also contains binary", async () => {
      const run = await createRun({ input: [new Uint8Array([7, 8, 9])] });
      const reread = await runs.get(run.runId);
      expect(reread.createdAt).toBeInstanceOf(Date);
      expect((reread.input as Uint8Array[])[0]).toBeInstanceOf(Uint8Array);
    });
  });

  describe("events.list slot ordering", () => {
    const rapidPairCount = 16;

    /**
     * Race two event types that need a different number of round trips to reach
     * their append. The slot is chosen inside the append, so whichever lands
     * first takes the next free slot and the log stays dense whatever order the
     * writers were issued in.
     */
    async function seedRapidEvents(runId: string) {
      const created = await Promise.all(
        Array.from({ length: rapidPairCount }, (_, index) =>
          events.create(runId, {
            eventType: "step_created",
            correlationId: `step-ordering-${index}`,
            eventData: { stepName: "ordering-step", input: [index] },
          }),
        ),
      );

      const raced = await Promise.all(
        created.flatMap((result, index) => [
          events.create(runId, {
            eventType: "step_started",
            correlationId: result.step!.stepId,
          }),
          events.create(runId, {
            eventType: "wait_created",
            correlationId: `wait-ordering-${index}`,
            eventData: { resumeAt: new Date(Date.now() + 60_000) },
          }),
        ]),
      );

      return [...created, ...raced].map((r) => r.event!.eventId);
    }

    it("numbers concurrent appends densely from 1, with no holes or duplicates", async () => {
      const run = await createRun();
      const seeded = await seedRapidEvents(run.runId);

      const page = await events.list({
        runId: run.runId,
        pagination: { sortOrder: "asc" },
      });

      expect(page.hasMore).toBe(false);
      const eventIds = page.data.map((e) => e.eventId);
      // The seeded events plus the run_created that opened the run.
      expect(eventIds).toHaveLength(seeded.length + 1);
      // Slots 1..N in order: ascending ids are the log order, and none is skipped.
      expect(eventIds).toEqual(
        Array.from({ length: eventIds.length }, (_, i) => slotToEventId(i + 1)),
      );
      // Every id handed back to a writer is one of the log's slots, exactly once.
      expect([...seeded].sort()).toEqual(eventIds.slice(1));
    });

    it("returns the descending log as the exact reverse", async () => {
      const run = await createRun();
      await seedRapidEvents(run.runId);

      const ascending = await events.list({
        runId: run.runId,
        pagination: { sortOrder: "asc" },
      });
      const descending = await events.list({
        runId: run.runId,
        pagination: { sortOrder: "desc" },
      });

      expect(descending.data.map((e) => e.eventId)).toEqual(
        ascending.data.map((e) => e.eventId).reverse(),
      );
    });

    it("pages by slot cursor without gaps or repeats", async () => {
      const run = await createRun();
      await seedRapidEvents(run.runId);
      const all = await events.list({
        runId: run.runId,
        pagination: { sortOrder: "asc" },
      });

      const collected: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const result = await events.list({
          runId: run.runId,
          pagination: {
            sortOrder: "asc",
            limit: 7,
            ...(cursor ? { cursor } : {}),
          },
        });
        collected.push(...result.data.map((e) => e.eventId));
        if (!result.hasMore) break;
        cursor = result.cursor ?? undefined;
      }

      expect(collected).toEqual(all.data.map((e) => e.eventId));
    });

    it("rejects a cursor that is not a slot id", async () => {
      const run = await createRun();
      await expect(
        events.list({
          runId: run.runId,
          pagination: { cursor: "evnt_01JQNOTASLOT" },
        }),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe("bump and report (eventCount)", () => {
    it("commits a stale writer at the next free slot and reports the span it skipped", async () => {
      const run = await createRun();
      const winner = await events.create(
        run.runId,
        {
          eventType: "step_created",
          correlationId: "step-winner",
          eventData: { stepName: "winner", input: [] },
        },
        { eventCount: 1 },
      );

      // Same snapshot (one event), but slot 2 is taken: bump to 3, do not reject.
      const stale = await events.create(
        run.runId,
        {
          eventType: "step_created",
          correlationId: "step-stale",
          eventData: { stepName: "stale", input: [] },
        },
        { eventCount: 1 },
      );

      expect(stale.event?.eventId).toBe(slotToEventId(3));
      expect(stale.step?.stepId).toBe("step-stale");
      expect(stale.events?.map((e) => e.eventId)).toEqual([
        winner.event!.eventId,
      ]);
      expect(stale.events?.[0].correlationId).toBe("step-winner");
      expect(stale.hasMore).toBe(false);
    });
  });

  describe("resolveData: 'none' strips refs, not metadata", () => {
    /** Read `eventData` without pinning a concrete event type. */
    function dataOf(event: Event | undefined): unknown {
      return event && "eventData" in event ? event.eventData : undefined;
    }

    /** Whether the event still carries an `eventData` key at all. */
    function carriesData(event: Event | undefined): boolean {
      return event !== undefined && "eventData" in event;
    }

    it("drops the step_created input ref and keeps the display metadata", async () => {
      const run = await createRun();
      const created = await events.create(
        run.runId,
        {
          eventType: "step_created",
          correlationId: "strip-step",
          eventData: { stepName: "chargeCard", input: [{ amount: 100 }] },
        },
        { resolveData: "none" },
      );

      expect(dataOf(created.event)).toEqual({ stepName: "chargeCard" });

      const full = await events.list({ runId: run.runId });
      const fullEvent = full.data.find(
        (e) => e.eventId === created.event!.eventId,
      );
      expect(dataOf(fullEvent)).toEqual({
        stepName: "chargeCard",
        input: [{ amount: 100 }],
      });
    });

    it("drops the run_created input ref and keeps deploymentId and workflowName", async () => {
      const created = await events.create(
        null,
        {
          eventType: "run_created",
          eventData: {
            deploymentId: "deployment-strip",
            workflowName: "strip-workflow",
            input: [{ big: "payload" }],
          },
        },
        { resolveData: "none" },
      );

      expect(dataOf(created.event)).toEqual({
        deploymentId: "deployment-strip",
        workflowName: "strip-workflow",
      });
    });

    it("omits eventData entirely when the ref was its only field", async () => {
      const run = await createRun();
      await events.create(run.runId, {
        eventType: "run_started",
        eventData: {},
      });
      const created = await events.create(
        run.runId,
        { eventType: "run_completed", eventData: { output: ["done"] } },
        { resolveData: "none" },
      );

      expect(carriesData(created.event)).toBe(false);
    });

    it("leaves wait_created untouched because it declares no ref fields", async () => {
      const run = await createRun();
      const resumeAt = new Date(Date.now() + 60_000);
      await events.create(run.runId, {
        eventType: "wait_created",
        correlationId: "strip-wait",
        eventData: { resumeAt },
      });

      const lean = await events.listByCorrelationId({
        correlationId: "strip-wait",
        runId: run.runId,
        resolveData: "none",
      });

      expect(lean.data).toHaveLength(1);
      expect(dataOf(lean.data[0])).toEqual({ resumeAt });
    });

    it("applies the same stripping to list and listByCorrelationId", async () => {
      const run = await createRun();
      const created = await events.create(run.runId, {
        eventType: "step_created",
        correlationId: "strip-surfaces",
        eventData: { stepName: "sendEmail", input: [{ to: "a@b.c" }] },
      });

      const listed = await events.list({
        runId: run.runId,
        resolveData: "none",
      });
      const fromList = listed.data.find(
        (e) => e.eventId === created.event!.eventId,
      );
      expect(dataOf(fromList)).toEqual({ stepName: "sendEmail" });

      const byCorrelation = await events.listByCorrelationId({
        correlationId: "strip-surfaces",
        runId: run.runId,
        resolveData: "none",
      });
      expect(byCorrelation.data).toHaveLength(1);
      expect(dataOf(byCorrelation.data[0])).toEqual({ stepName: "sendEmail" });
    });
  });
});
