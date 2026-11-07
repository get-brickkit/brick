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
import { describeRedis, redisUrl } from "./helpers.js";

// Storage outcomes a stale or retried write must not change.

let a: Redis;

beforeAll(() => {
  a = new Redis(redisUrl);
});
afterAll(async () => {
  await a.quit();
});

function storages() {
  const keyPrefix = `review2:${randomUUID()}:`;
  const config = { redis: a, keyPrefix };
  return {
    keyPrefix,
    runs: createRunsStorage(config),
    steps: createStepsStorage(config),
    events: createEventsStorage(config),
    hooks: createHooksStorage(config),
  };
}
type S = ReturnType<typeof storages>;

async function createRun(s: S) {
  const created = await s.events.create(null, {
    eventType: "run_created",
    eventData: { deploymentId: "d", workflowName: "w", input: [] },
  });
  const runId = created.run!.runId;
  await s.events.create(runId, { eventType: "run_started" });
  return runId;
}

async function types(s: S, runId: string) {
  const log = await s.events.list({ runId, pagination: { limit: 1000 } });
  return log.data.map(
    (e) => `${e.eventType}${e.correlationId ? `:${e.correlationId}` : ""}`,
  );
}

describeRedis("step status key vs step JSON", () => {
  it("a step that was running before the status key existed can be retried and restarted", async () => {
    const s = storages();
    const runId = await createRun(s);
    const stepId = `step_${randomUUID()}`;
    await s.events.create(runId, {
      eventType: "step_created",
      correlationId: stepId,
      eventData: { stepName: "s", input: [] },
    });
    await s.events.create(runId, {
      eventType: "step_started",
      correlationId: stepId,
    }); // attempt 1
    // A step written by the previous version has no `step:status:` key.
    await a.del(keys(s.keyPrefix).stepStatusKey(runId, stepId));

    // Attempt 1 fails and is retried. The script seeds the key from attempt '0',
    // not from the JSON's attempt 1.
    await s.events.create(runId, {
      eventType: "step_retrying",
      correlationId: stepId,
      eventData: { error: "boom" },
    });
    // (the key now reads 'pending|0' while the JSON says attempt 1)

    // The retry delivery: JSON says attempt 1, the key says 0 -> stepMoved ->
    // EntityConflictError on every redelivery, so the step never runs again.
    const restart = await s.events
      .create(runId, { eventType: "step_started", correlationId: stepId })
      .then(
        (r) => r.step?.attempt,
        (e) => `${e.name}: ${e.message}`,
      );
    expect(restart).toBe(2);
  });
});

describeRedis("hook re-creation after disposal", () => {
  it("refuses a second hook_created for a hook this run already created and disposed", async () => {
    const s = storages();
    const runId = await createRun(s);
    const hookId = `hook_${randomUUID()}`;
    const token = `tok-${randomUUID()}`;
    const create = () =>
      s.events.create(runId, {
        eventType: "hook_created",
        correlationId: hookId,
        eventData: { token },
      });
    await create();
    await s.events.create(runId, {
      eventType: "hook_disposed",
      correlationId: hookId,
    });

    // A stale suspension (it loaded the log before the first hook_created) writes it again.
    const again = await create().then(
      (r) => r.event?.eventType,
      (e) => e.name,
    );

    expect(again).toBe("EntityConflictError");
    const log = (await types(s, runId)).filter((t) => t.endsWith(hookId));
    expect(log).toEqual([`hook_created:${hookId}`, `hook_disposed:${hookId}`]);
    // ...and the token must stay free for other runs.
    await expect(s.hooks.getByToken(token)).rejects.toMatchObject({
      name: "HookNotFoundError",
    });
  });
});

describeRedis("lazy hook resume convergence", () => {
  it("a re-ensure converges on the recorded event even after the hook was disposed", async () => {
    const s = storages();
    const runId = await createRun(s);
    const hookId = `hook_${randomUUID()}`;
    const token = `tok-${randomUUID()}`;
    await s.events.create(runId, {
      eventType: "hook_created",
      correlationId: hookId,
      eventData: { token },
    });
    const resumeId = randomUUID();
    const write = () =>
      s.events.create(
        runId,
        {
          eventType: "hook_received",
          correlationId: hookId,
          eventData: { token, payload: { n: 1 } },
        },
        { resumeId, resumePayloadDigest: "d1" },
      );
    const first = await write();
    await s.events.create(runId, {
      eventType: "hook_disposed",
      correlationId: hookId,
    });

    // world-postgres: "Retry convergence must precede the hook existence/terminal checks".
    const second = await write().then(
      (r) => r.event?.eventId,
      (e) => e.name,
    );
    expect(second).toBe(first.event!.eventId);
  });
});
