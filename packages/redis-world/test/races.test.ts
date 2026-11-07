import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it } from "vitest";
import { keys } from "../src/keys.js";
import {
  createEventsStorage,
  createHooksStorage,
  createRunsStorage,
  createStepsStorage,
} from "../src/storage.js";
import { describeRedis, gate, pauseAfter, redisUrl } from "./helpers.js";

// Check-then-act windows and multi-round-trip writes in events.create. Each
// test drives a deterministic interleaving by pausing one writer's Redis client
// at a chosen point and running a competing writer on a second client in the
// gap, and pins the outcome a single atomic write would give.

let a: Redis; // the "healthy" writer
let b: Redis; // the writer we pause / break

beforeAll(() => {
  a = new Redis(redisUrl);
  b = new Redis(redisUrl);
});
afterAll(async () => {
  await Promise.all([a.quit(), b.quit()]);
});

/** Pause before the next call of a script command defined on `client`. */
function pauseBeforeScript(client: Redis, name: string) {
  const reached = gate();
  const hold = gate();
  const orig = (client as any)[name].bind(client);
  let armed = true;
  (client as any)[name] = async (...args: unknown[]) => {
    if (armed) {
      armed = false;
      reached.release();
      await hold.promise;
    }
    return orig(...args);
  };
  return {
    reached: reached.promise,
    release: hold.release,
    restore: () => {
      (client as any)[name] = orig;
    },
  };
}

/** Make the next call of a script command on `client` fail (a crash / connection loss). */
function failScriptOnce(client: Redis, name: string) {
  const orig = (client as any)[name].bind(client);
  (client as any)[name] = async () => {
    (client as any)[name] = orig;
    throw new Error("simulated crash / connection loss");
  };
}

function storages() {
  const keyPrefix = `review:${randomUUID()}:`;
  const mk = (redis: Redis) => {
    const config = { redis, keyPrefix };
    return {
      runs: createRunsStorage(config),
      steps: createStepsStorage(config),
      events: createEventsStorage(config),
      hooks: createHooksStorage(config),
    };
  };
  return { A: mk(a), B: mk(b), keyPrefix };
}
type S = ReturnType<typeof storages>["A"];

async function createRun(s: S, start = true) {
  const created = await s.events.create(null, {
    eventType: "run_created",
    eventData: { deploymentId: "d", workflowName: "w", input: [] },
  });
  const runId = created.run!.runId;
  if (start) await s.events.create(runId, { eventType: "run_started" });
  return runId;
}

async function types(s: S, runId: string) {
  const log = await s.events.list({ runId, pagination: { limit: 1000 } });
  return log.data.map(
    (e) => `${e.eventType}${e.correlationId ? `:${e.correlationId}` : ""}`,
  );
}

describeRedis("races: hook ordering", () => {
  it("never journals a hook_received behind its hook_disposed", async () => {
    const { A, B, keyPrefix } = storages();
    const runId = await createRun(A);
    const hookId = `hook_${randomUUID()}`;
    await A.events.create(runId, {
      eventType: "hook_created",
      correlationId: hookId,
      eventData: { token: `tok-${randomUUID()}` },
    });

    // B (a resumeHook delivery) passes its hook-existence read, then stalls.
    const pause = pauseAfter(
      b,
      "get",
      (k) => k === keys(keyPrefix).hookKey(hookId),
    );
    const received = B.events
      .create(runId, {
        eventType: "hook_received",
        correlationId: hookId,
        eventData: { payload: { n: 1 } },
      })
      .then(
        () => "ok",
        (e) => e.name,
      );
    await pause.reached;
    // The run's own `using` scope exits and disposes the hook.
    await A.events.create(runId, {
      eventType: "hook_disposed",
      correlationId: hookId,
    });
    pause.release();
    await received;
    pause.restore();

    const log = (await types(A, runId)).filter((t) => t.endsWith(hookId));
    const disposedAt = log.indexOf(`hook_disposed:${hookId}`);
    // Anything after the disposal can never be consumed (CorruptedEventLogError).
    expect(log.slice(disposedAt + 1)).toEqual([]);
  });

  it("never journals a hook_received behind the terminal run event", async () => {
    const { A, B, keyPrefix } = storages();
    const runId = await createRun(A);
    const hookId = `hook_${randomUUID()}`;
    await A.events.create(runId, {
      eventType: "hook_created",
      correlationId: hookId,
      eventData: { token: `tok-${randomUUID()}` },
    });
    const pause = pauseAfter(
      b,
      "get",
      (k) => k === keys(keyPrefix).hookKey(hookId),
    );
    const received = B.events
      .create(runId, {
        eventType: "hook_received",
        correlationId: hookId,
        eventData: { payload: { n: 1 } },
      })
      .then(
        () => "ok",
        (e) => e.name,
      );
    await pause.reached;
    await A.events.create(runId, {
      eventType: "run_completed",
      eventData: { output: 1 },
    });
    pause.release();
    const outcome = await received;
    pause.restore();

    const log = await types(A, runId);
    // world-postgres refuses this with RunExpiredError (FOR UPDATE on the run row).
    expect(log.at(-1)).toBe("run_completed");
    expect(outcome).not.toBe("ok");
  });
});

describeRedis("races: terminal transition is atomic", () => {
  it("a failed terminal write leaves nothing behind, so the retry completes the run and frees its hooks", async () => {
    const { A, B } = storages();
    const runId = await createRun(A);
    const token = `tok-${randomUUID()}`;
    await A.events.create(runId, {
      eventType: "hook_created",
      correlationId: `hook_${randomUUID()}`,
      eventData: { token },
    });

    // The write fails at the script boundary. Status, hook release and the event are
    // one script, so nothing is half applied.
    failScriptOnce(b, "wfTransitionRun");
    await expect(
      B.events.create(runId, {
        eventType: "run_completed",
        eventData: { output: 1 },
      }),
    ).rejects.toThrow("simulated");

    // The queue redelivers; the runtime retries the same terminal write.
    const retry = await A.events
      .create(runId, { eventType: "run_completed", eventData: { output: 1 } })
      .then(
        () => "ok",
        (e) => e.name,
      );

    const run = await A.runs.get(runId);
    const log = await types(A, runId);
    expect({
      status: run.status,
      retry,
      hasTerminalEvent: log.includes("run_completed"),
    }).toEqual({
      status: "completed",
      retry: "ok",
      hasTerminalEvent: true,
    });
    // And the run's hook token must be released.
    await expect(A.hooks.getByToken(token)).rejects.toMatchObject({
      name: "HookNotFoundError",
    });
  });

  it("run_started cannot land after run_cancelled", async () => {
    const { A, B } = storages();
    const runId = await createRun(A, false); // pending

    const pause = pauseBeforeScript(b, "wfTransitionRun");
    const started = B.events.create(runId, { eventType: "run_started" }).then(
      () => "ok",
      (e) => e.name,
    );
    await pause.reached; // B read the run as pending and is about to start it
    await A.events.create(runId, { eventType: "run_cancelled" });
    pause.release();
    // The cancel won: the start is refused, not journaled behind it.
    expect(await started).toBe("RunExpiredError");
    pause.restore();

    const log = await types(A, runId);
    expect(log).toEqual(["run_created", "run_cancelled"]);
  });

  it("a failed start is retried by the redelivery, which appends run_started", async () => {
    const { A, B } = storages();
    const runId = await createRun(A, false);
    failScriptOnce(b, "wfTransitionRun");
    await expect(
      B.events.create(runId, { eventType: "run_started" }),
    ).rejects.toThrow("simulated");
    // Redelivery: the run is still pending, so the start is applied now.
    await A.events.create(runId, { eventType: "run_started" });
    expect(await types(A, runId)).toContain("run_started");
  });
});

describeRedis("races: entity creation racing a terminal transition", () => {
  it("hook_created racing run_cancelled leaves a live hook (and its token) on a cancelled run", async () => {
    const { A, B, keyPrefix } = storages();
    const runId = await createRun(A);
    const token = `tok-${randomUUID()}`;

    // B (the orchestrator) reads run meta = running, then stalls.
    const pause = pauseAfter(
      b,
      "get",
      (k) => k === keys(keyPrefix).runMetaKey(runId),
    );
    const created = B.events
      .create(runId, {
        eventType: "hook_created",
        correlationId: `hook_${randomUUID()}`,
        eventData: { token },
      })
      .then(
        () => "ok",
        (e) => e.name,
      );
    await pause.reached;
    await A.events.create(runId, { eventType: "run_cancelled" }); // runs cleanupHooks
    pause.release();
    await created;
    pause.restore();

    // A later run that uses the same token must be able to claim it.
    const other = await createRun(A);
    const res = await A.events.create(other, {
      eventType: "hook_created",
      correlationId: `hook_${randomUUID()}`,
      eventData: { token },
    });
    expect(res.event?.eventType).toBe("hook_created");
  });
});

describeRedis("races: hook token ownership", () => {
  it("takes over a token whose owner is gone, without a window to wipe a live claim", async () => {
    const { A, keyPrefix } = storages();
    const token = `tok-${randomUUID()}`;
    const r1 = await createRun(A);
    const h1 = `hook_${randomUUID()}`;
    await A.events.create(r1, {
      eventType: "hook_created",
      correlationId: h1,
      eventData: { token },
    });

    // A crash during cleanup left the token behind its deleted hook.
    await a.del(keys(keyPrefix).hookKey(h1));

    const r2 = await createRun(A);
    const h2 = `hook_${randomUUID()}`;
    const res2 = await A.events.create(r2, {
      eventType: "hook_created",
      correlationId: h2,
      eventData: { token },
    });
    expect(res2.event?.eventType).toBe("hook_created");
    expect((await A.hooks.getByToken(token)).hookId).toBe(h2);
  });

  it("never gives a live claim to a second run", async () => {
    const { A } = storages();
    const token = `tok-${randomUUID()}`;
    const r1 = await createRun(A);
    const h1 = `hook_${randomUUID()}`;
    await A.events.create(r1, {
      eventType: "hook_created",
      correlationId: h1,
      eventData: { token },
    });

    const r2 = await createRun(A);
    const res2 = await A.events.create(r2, {
      eventType: "hook_created",
      correlationId: `hook_${randomUUID()}`,
      eventData: { token },
    });
    expect(res2.event?.eventType).toBe("hook_conflict");
    expect((await A.hooks.getByToken(token)).hookId).toBe(h1);
  });

  it("does not wipe a claim when a stale hook is disposed after the token moved on", async () => {
    const { A, keyPrefix } = storages();
    const token = `tok-${randomUUID()}`;
    const r1 = await createRun(A);
    const h1 = `hook_${randomUUID()}`;
    await A.events.create(r1, {
      eventType: "hook_created",
      correlationId: h1,
      eventData: { token },
    });

    // The token now belongs to another hook (a takeover after a crash), while h1's
    // record is still around and is disposed late.
    const r2 = await createRun(A);
    const h2 = `hook_${randomUUID()}`;
    await a.set(keys(keyPrefix).hooksByTokenKey(token), h2);
    await A.events.create(r2, {
      eventType: "hook_created",
      correlationId: h2,
      eventData: { token },
    });
    await A.events.create(r1, {
      eventType: "hook_disposed",
      correlationId: h1,
    });

    expect(await a.get(keys(keyPrefix).hooksByTokenKey(token))).toBe(h2);
  });
});

describeRedis(
  "races: step_retrying from a stale read keeps the attempt",
  () => {
    it("keeps the attempt counter monotonic", async () => {
      const { A, B, keyPrefix } = storages();
      const runId = await createRun(A);
      const stepId = `step_${randomUUID()}`;
      await A.events.create(runId, {
        eventType: "step_created",
        correlationId: stepId,
        eventData: { stepName: "s", input: [] },
      });
      await A.events.create(runId, {
        eventType: "step_started",
        correlationId: stepId,
      }); // attempt 1

      // Attempt 1's body fails; its step_retrying reads the step, then stalls.
      const pause = pauseAfter(
        b,
        "get",
        (k) => k === keys(keyPrefix).stepKey(runId, stepId),
      );
      const retrying = B.events.create(runId, {
        eventType: "step_retrying",
        correlationId: stepId,
        eventData: { error: "boom" },
      });
      await pause.reached;
      // Meanwhile a redelivery starts attempt 2.
      const s2 = await A.events.create(runId, {
        eventType: "step_started",
        correlationId: stepId,
      });
      expect(s2.step?.attempt).toBe(2);
      pause.release();
      await retrying;
      pause.restore();

      const step = await A.steps.get(runId, stepId);
      expect(step.attempt).toBe(2);
      const s3 = await A.events.create(runId, {
        eventType: "step_started",
        correlationId: stepId,
      });
      expect(s3.step?.attempt).toBe(3);
    });
  },
);

describeRedis("races: duplicates the reference worlds refuse", () => {
  it("refuses a second wait_completed for the same wait", async () => {
    const { A } = storages();
    const runId = await createRun(A);
    const waitId = `wait_${randomUUID()}`;
    await A.events.create(runId, {
      eventType: "wait_created",
      correlationId: waitId,
      eventData: { resumeAt: new Date(Date.now() - 1000) },
    });
    const first = A.events.create(runId, {
      eventType: "wait_completed",
      correlationId: waitId,
    });
    const second = A.events.create(runId, {
      eventType: "wait_completed",
      correlationId: waitId,
    });
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

describeRedis("races: runs.list pagination under churn", () => {
  it("a status-filtered cursor survives the cursor run changing status", async () => {
    const { A } = storages();
    // Fresh prefix, so the pending index holds exactly these runs.
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await createRun(A, false));
    const page1 = await A.runs.list({
      status: "pending",
      pagination: { limit: 1 },
    });
    expect(page1.hasMore).toBe(true);
    // The run on the cursor starts.
    await A.events.create(page1.data[0].runId, { eventType: "run_started" });
    const page2 = await A.runs
      .list({
        status: "pending",
        pagination: { limit: 1, cursor: page1.cursor! },
      })
      .then(
        (r) => r.data.length,
        (e) => `${e.name}: ${e.message}`,
      );
    expect(page2).toBe(1);
  });
});
