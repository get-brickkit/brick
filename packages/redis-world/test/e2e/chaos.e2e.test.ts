import { getQueueTopicPrefix } from "@workflow/world";
import { describe, expect, test } from "vitest";
import { Env } from "./harness/env.js";
import { world } from "./harness/world.js";
import { W } from "./harness/workflows.js";

const FAST_RECOVERY = world.fastRecovery;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until every run has an event of `type` in its log. */
async function waitForEvent(
  env: Env,
  runIds: string[],
  type: string,
  timeoutMs = 60_000,
) {
  await env.until(
    `every run to log ${type}`,
    async () => {
      const seen = await Promise.all(
        runIds.map((id) => env.hasEvent(id, type)),
      );
      return seen.every(Boolean) ? true : undefined;
    },
    timeoutMs,
  );
}

describe("chaos", () => {
  test(
    "11. SIGKILL a worker inside a slow step: a surviving worker finishes the run",
    { timeout: 180_000 },
    async () => {
      const env = await Env.create({ workers: 2, tuning: FAST_RECOVERY });
      const key = env.counterKey("slow");
      const runId = await env.invoke(W.slowStep, [6000, key]);

      // Wait until a step body is executing, then crash the worker running it.
      await env.until(
        "slow step to start",
        async () => ((await env.counts(key)).slow ?? 0) >= 1 || undefined,
      );
      const victimName = (await env.executions(key))["slow#1"]!;
      const victim = env.workers.find((w) => w.name === victimName)!;
      expect(victim, "the worker that is inside the slow step").toBeDefined();
      await sleep(500); // well inside the 6s step
      expect(await env.status(runId)).toBe("running");
      const killedAt = Date.now();
      await victim.kill("SIGKILL");

      await env.waitForRuns([runId], "completed", 120_000);
      console.log(
        `[11] killed ${victimName}; run completed ${Date.now() - killedAt}ms later; executions=${JSON.stringify(await env.executions(key))}`,
      );

      // At-least-once: the step body ran again (the kill hit it mid-flight) but
      // on a surviving worker.
      const counts = await env.counts(key);
      expect(
        counts.slow,
        "slow step body executions (kill was mid-step, so >= 2)",
      ).toBeGreaterThanOrEqual(2);
      const executions = await env.executions(key);
      expect(executions["slow#2"]).not.toBe(victimName);

      const events = await env.expectDenseLog(runId);
      const byType = Env.countByType(events);
      expect(byType.run_completed, "run_completed").toBe(1);
      expect(byType.run_failed ?? 0, "run_failed").toBe(0);
      expect(byType.step_created, "step_created").toBe(3);
      expect(byType.step_completed, "step_completed (one per step)").toBe(3);
      const completedIds = events
        .filter((e) => e.eventType === "step_completed")
        .map((e) => e.correlationId);
      expect(
        new Set(completedIds).size,
        "step_completed correlation ids are distinct",
      ).toBe(3);
      expect(events.at(-1)?.eventType).toBe("run_completed");
      expect(await env.output(runId)).toEqual({ executions: counts.slow });
    },
  );

  // Not one of the 15 requested scenarios: a stricter reading of 11. Scenario 11
  // tolerates the *in-flight* step running twice. This asks that a step whose
  // step_completed was already persisted is not executed again by the recovery.
  test(
    "11b. after a mid-step crash, steps that already completed are not executed again",
    { timeout: 180_000 },
    async () => {
      const env = await Env.create({ workers: 2, tuning: FAST_RECOVERY });
      const key = env.counterKey("slow");
      const runId = await env.invoke(W.slowStep, [6000, key]);
      await env.until(
        "slow step to start",
        async () => ((await env.counts(key)).slow ?? 0) >= 1 || undefined,
      );
      const victimName = (await env.executions(key))["slow#1"]!;
      await sleep(500);
      await env.workers.find((w) => w.name === victimName)!.kill("SIGKILL");
      await env.waitForRuns([runId], "completed", 120_000);

      const events = await env.expectDenseLog(runId);
      const firstStepId = events.find(
        (e) => e.eventType === "step_completed",
      )!.correlationId;
      expect(
        events
          .filter((e) => e.correlationId === firstStepId)
          .map((e) => e.eventType),
        "the first step has exactly one lifecycle in the log",
      ).toEqual(["step_created", "step_started", "step_completed"]);

      const delivered = await Promise.all(
        env.liveWorkers().map(async (w) => ({
          worker: w.name,
          ...(await w.fetchJson<object>("/_ping")),
        })),
      );
      const counts = await env.counts(key);
      expect(
        counts.before,
        `step 'before' had a persisted step_completed before the crash but its body ran ${counts.before}x; ` +
          `executions=${JSON.stringify(await env.executions(key))}; redeliveries seen by survivors=${JSON.stringify(delivered)}`,
      ).toBe(1);
    },
  );

  test(
    "12. SIGKILL every worker while 10 runs sleep: a new worker completes them all",
    { timeout: 240_000 },
    async () => {
      const env = await Env.create({ workers: 2, tuning: FAST_RECOVERY });
      const total = 10;
      const keys = Array.from({ length: total }, (_, i) =>
        env.counterKey(`run${i}`),
      );
      const runIds = await env.invokeMany(total, W.sleepyRun, (i) => [
        "4s",
        keys[i],
      ]);
      await waitForEvent(env, runIds, "wait_created");

      // Every run is now suspended in its first sleep('4s'). Crash everything.
      await Promise.all(env.workers.map((w) => w.kill("SIGKILL")));
      expect(env.liveWorkers()).toHaveLength(0);

      // Outlast the 4s sleeps with nobody alive to wake the runs.
      await sleep(5_000);
      const statuses = await Promise.all(runIds.map((id) => env.status(id)));
      expect(
        statuses.every((s) => s === "running"),
        `nothing can advance without workers; got ${statuses.join(",")}`,
      ).toBe(true);

      await env.startWorker("revived");
      await env.waitForRuns(runIds, "completed", 150_000);

      for (const [i, runId] of runIds.entries()) {
        expect(await env.output(runId), `run ${i} output`).toBe("done");
        const counts = await env.counts(keys[i]!);
        // The first step was durably completed before the crash: never re-run.
        expect(counts.first, `run ${i}: step 'first' executions`).toBe(1);
        expect(counts.second, `run ${i}: step 'second' executions`).toBe(1);
        expect(counts.third, `run ${i}: step 'third' executions`).toBe(1);
        const byType = Env.countByType(await env.expectDenseLog(runId));
        expect(byType.run_completed, `run ${i} run_completed`).toBe(1);
        expect(byType.wait_created, `run ${i} wait_created`).toBe(2);
        expect(byType.wait_completed, `run ${i} wait_completed`).toBe(2);
        expect(byType.step_completed, `run ${i} step_completed`).toBe(3);
      }
    },
  );

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    test(
      `13${signal === "SIGTERM" ? "a" : "b"}. Redis restart with AOF (${signal}): in-flight runs complete afterwards`,
      { timeout: 300_000 },
      async () => {
        const env = await Env.create({
          ownRedis: true,
          workers: 2,
          tuning: FAST_RECOVERY,
        });
        const total = 10;
        const keys = Array.from({ length: total }, (_, i) =>
          env.counterKey(`run${i}`),
        );
        const runIds = await env.invokeMany(total, W.sleepyRun, (i) => [
          "3s",
          keys[i],
        ]);
        // Mid-flight: every run is past its first step.
        await env.until(
          "every run's first step",
          async () => {
            const firsts = await Promise.all(
              keys.map(async (k) => (await env.counts(k)).first ?? 0),
            );
            return firsts.every((c) => c >= 1) ? true : undefined;
          },
          60_000,
        );

        // Which runs already had their first step_completed on disk when Redis went away.
        const completedBeforeOutage = new Set<number>();
        await Promise.all(
          runIds.map(async (id, i) => {
            if (
              (await env.events(id)).some(
                (e) => e.eventType === "step_completed",
              )
            )
              completedBeforeOutage.add(i);
          }),
        );

        const server = env.redisServer!;
        await server.stop(signal);
        await sleep(2_500); // an outage long enough for locks to expire and sleeps to come due
        await server.startAgain();

        await env.waitForRuns(runIds, "completed", 200_000);

        const multiplicity: Record<string, number> = {};
        let rerunDespitePersistedCompletion = 0;
        for (const [i, runId] of runIds.entries()) {
          expect(await env.output(runId), `run ${i} output`).toBe("done");
          const counts = await env.counts(keys[i]!);
          if (completedBeforeOutage.has(i) && (counts.first ?? 0) > 1)
            rerunDespitePersistedCompletion++;
          for (const field of ["first", "second", "third"]) {
            expect(
              counts[field],
              `run ${i}: step '${field}' ran at least once`,
            ).toBeGreaterThanOrEqual(1);
            multiplicity[`${field}x${counts[field]}`] =
              (multiplicity[`${field}x${counts[field]}`] ?? 0) + 1;
          }
          const events = await env.expectDenseLog(runId);
          const byType = Env.countByType(events);
          expect(byType.run_completed, `run ${i} run_completed`).toBe(1);
          expect(byType.run_failed ?? 0, `run ${i} run_failed`).toBe(0);
          expect(byType.step_created, `run ${i} step_created`).toBe(3);
          expect(byType.step_completed, `run ${i} step_completed`).toBe(3);
          expect(events.at(-1)?.eventType, `run ${i} last event`).toBe(
            "run_completed",
          );
        }
        console.log(
          `[13${signal}] step execution multiplicity over ${total} runs: ${JSON.stringify(multiplicity)}; ` +
            `first step re-run although its step_completed was already persisted before the outage: ${rerunDespitePersistedCompletion} ` +
            `(of ${completedBeforeOutage.size} runs that had one)`,
        );
      },
    );
  }

  test(
    "14. lost queue: queue keys deleted, storage kept; a restarted worker re-enqueues the active runs",
    { timeout: 240_000 },
    async () => {
      const env = await Env.create({ workers: 1, tuning: FAST_RECOVERY });
      const total = 8;
      const keys = Array.from({ length: total }, (_, i) =>
        env.counterKey(`run${i}`),
      );
      const runIds = await env.invokeMany(total, W.sleepyRun, (i) => [
        "4s",
        keys[i],
      ]);
      await waitForEvent(env, runIds, "wait_created");

      // Lose the whole queue (delayed wake-ups included) but keep every storage key.
      await env.workers[0]!.kill("SIGKILL");
      const bullKeys = await env.scan(env.queueKeyPattern());
      expect(bullKeys.length, "there are queue keys to delete").toBeGreaterThan(
        0,
      );
      for (const k of bullKeys) await env.redis.unlink(k);
      expect(await env.scan(env.queueKeyPattern())).toEqual([]);
      expect(
        (await env.scan(`${env.keyPrefix}*`)).length,
        "storage keys are kept",
      ).toBeGreaterThan(0);

      const stats = await env.world.getQueueStats();
      expect(stats).toMatchObject({ waiting: 0, active: 0, delayed: 0 });

      // Past the original wake-up time, with no job left to deliver it.
      await sleep(5_000);
      const statuses = await Promise.all(runIds.map((id) => env.status(id)));
      expect(
        statuses.every((s) => s === "running"),
        `runs are stranded without a queue; got ${statuses.join(",")}`,
      ).toBe(true);

      await env.startWorker("restarted"); // start() re-enqueues the active runs
      await env.waitForRuns(runIds, "completed", 150_000);

      for (const [i, runId] of runIds.entries()) {
        expect(await env.output(runId), `run ${i} output`).toBe("done");
        const counts = await env.counts(keys[i]!);
        expect(counts, `run ${i}: each step body ran exactly once`).toEqual({
          first: 1,
          second: 1,
          third: 1,
        });
        const byType = Env.countByType(await env.expectDenseLog(runId));
        expect(byType.run_completed, `run ${i} run_completed`).toBe(1);
        expect(byType.step_completed, `run ${i} step_completed`).toBe(3);
      }
    },
  );

  for (const crashes of [2, 3]) {
    test(
      `16${crashes === 2 ? "a" : "b"}. ${crashes} worker crashes in a row during the same step`,
      { timeout: 240_000 },
      async () => {
        const env = await Env.create({
          workers: crashes + 1,
          tuning: FAST_RECOVERY,
        });
        const key = env.counterKey("slow");
        const runId = await env.invoke(W.slowStep, [6000, key]);

        // Crash the worker running the step, then the one that takes over, and so on.
        const killed: string[] = [];
        for (let n = 1; n <= crashes; n++) {
          await env.until(
            `slow step execution #${n}`,
            async () => ((await env.counts(key)).slow ?? 0) >= n || undefined,
            60_000,
          );
          const name = (await env.executions(key))[`slow#${n}`]!;
          await sleep(500);
          await env.workers.find((w) => w.name === name)!.kill("SIGKILL");
          killed.push(name);
        }
        console.log(`[16] killed ${killed.join(" then ")}`);

        await env.waitForRuns([runId], "completed", 90_000);
        const events = await env.expectDenseLog(runId);
        const byType = Env.countByType(events);
        expect(byType.run_completed).toBe(1);
        expect(byType.step_completed).toBe(3);
        expect((await env.counts(key)).slow).toBeGreaterThanOrEqual(
          crashes + 1,
        );
      },
    );
  }

  test(
    `16c. liveness: ${world.spentBudget.title}`,
    { timeout: 240_000 },
    async () => {
      const env = await Env.create({
        workers: 3,
        tuning: { ...FAST_RECOVERY, ...world.spentBudget.tuning },
      });
      const key = env.counterKey("slow");
      const runId = await env.invoke(W.slowStep, [6000, key]);
      for (let n = 1; n <= 2; n++) {
        await env.until(
          `slow step execution #${n}`,
          async () => ((await env.counts(key)).slow ?? 0) >= n || undefined,
          60_000,
        );
        const name = (await env.executions(key))[`slow#${n}`]!;
        await sleep(500);
        await env.workers.find((w) => w.name === name)!.kill("SIGKILL");
      }

      // A survivor is alive and the budget is spent. Whatever the world decides
      // (finish the run, fail the run) it must not leave the run
      // 'running' with nothing left in the queue to ever advance it.
      const outcome = await env
        .until(
          'the run to leave "running"',
          async () => {
            const status = await env.status(runId);
            return status === "running" ? undefined : status;
          },
          45_000,
        )
        .catch(async (error) => {
          const stats = await env.world.getQueueStats();
          throw new Error(
            `run ${runId} is stranded: status=running with queue ${JSON.stringify(stats)} and a live worker; ` +
              `slow step executions=${(await env.counts(key)).slow}. ${String(error)}`,
          );
        });
      expect(["completed", "failed"]).toContain(outcome);
    },
  );

  test(
    "17. chaos monkey: workers are SIGKILLed and replaced for 25s under a mixed workload",
    { timeout: 420_000 },
    async () => {
      // A generous budget, so the test measures correctness under churn rather
      // than the default budget (scenario 16 covers that).
      const env = await Env.create({
        workers: 3,
        tuning: { ...FAST_RECOVERY, ...world.churnBudget },
      });
      type Kind = {
        wf: typeof W.fanOut;
        args: (key: string) => unknown[];
        steps: number;
        output: (r: unknown) => void;
      };
      const kinds: Kind[] = [
        {
          wf: W.fanOut,
          args: (k) => [15, k],
          steps: 15,
          output: (r) => expect(r).toBe(15 * 14),
        },
        {
          wf: W.sleepyRun,
          args: (k) => ["1s", k],
          steps: 3,
          output: (r) => expect(r).toBe("done"),
        },
        {
          wf: W.chain,
          args: () => [8],
          steps: 8,
          output: (r) => expect(r).toBe(8),
        },
        // Long enough for the monkey to land inside the step body now and then.
        {
          wf: W.slowStep,
          args: (k) => [2_000, k],
          steps: 3,
          output: (r) =>
            expect(
              (r as { executions: number }).executions,
            ).toBeGreaterThanOrEqual(1),
        },
      ];
      const total = 48;
      const plan = Array.from({ length: total }, (_, i) => ({
        kind: kinds[i % kinds.length]!,
        key: env.counterKey(`run${i}`),
      }));

      const monkey = env.startChaosMonkey({
        intervalMs: 2_500,
        restartAfterMs: 1_000,
        seed: 42,
      });
      const runIds: string[] = [];
      // Trickle the runs in so work keeps arriving while workers die.
      for (const [i, p] of plan.entries()) {
        runIds.push(await env.invoke(p.kind.wf, p.kind.args(p.key)));
        if (i % 5 === 4) await sleep(1_500);
      }
      const kills = await monkey.stop();
      console.log(
        `[17] ${kills} workers killed while ${total} runs were started`,
      );
      expect(
        kills,
        "the monkey actually killed workers",
      ).toBeGreaterThanOrEqual(3);
      expect(env.liveWorkers().length).toBeGreaterThanOrEqual(1);

      await env.waitForRuns(runIds, "completed", 300_000);

      let reExecuted = 0;
      for (const [i, runId] of runIds.entries()) {
        const p = plan[i]!;
        p.kind.output(await env.output(runId));
        const events = await env.expectDenseLog(runId);
        const byType = Env.countByType(events);
        expect(byType.run_completed, `run ${i} run_completed`).toBe(1);
        expect(byType.run_failed ?? 0, `run ${i} run_failed`).toBe(0);
        expect(byType.step_created, `run ${i} step_created`).toBe(p.kind.steps);
        expect(
          byType.step_completed,
          `run ${i} step_completed (one per step)`,
        ).toBe(p.kind.steps);
        expect(events.at(-1)?.eventType, `run ${i} last event`).toBe(
          "run_completed",
        );
        const distinct = new Set(
          events
            .filter((e) => e.eventType === "step_completed")
            .map((e) => e.correlationId),
        );
        expect(distinct.size, `run ${i} distinct completed steps`).toBe(
          p.kind.steps,
        );
        for (const c of Object.values(await env.counts(p.key)))
          if (c > 1) reExecuted++;
      }
      console.log(
        `[17] step bodies that ran more than once (at-least-once): ${reExecuted}`,
      );
    },
  );

  describe("15. duplicate delivery", () => {
    const queueNameOf = (workflowName: string) =>
      `${getQueueTopicPrefix("workflow")}${workflowName}` as never;

    test(
      "15a. the same run message enqueued several times while it executes",
      { timeout: 180_000 },
      async () => {
        const env = await Env.create({ workers: 3 });
        const n = 30;
        const controlKey = env.counterKey("control");
        const control = await env.invoke(W.fanOut, [n, controlKey]);
        await env.waitForRuns([control]);

        const dupKey = env.counterKey("dup");
        const dup = await env.invoke(W.fanOut, [n, dupKey]);
        const { workflowName } = await env.getRun(dup);
        for (let i = 0; i < 5; i++)
          await env.world.queue(queueNameOf(workflowName), {
            runId: dup,
          } as never);
        await env.waitForRuns([dup]);
        await env.waitForQueueIdle();

        expect(await env.output(dup)).toBe(await env.output(control));
        const controlEvents = await env.expectDenseLog(control);
        const dupEvents = await env.expectDenseLog(dup);
        const controlCounts = Env.countByType(controlEvents);
        const dupCounts = Env.countByType(dupEvents);
        expect(dupCounts.run_completed, "run_completed").toBe(1);
        expect(dupCounts).toEqual(controlCounts);
        expect(dupEvents.length, "event count equals the control run").toBe(
          controlEvents.length,
        );
        const steps = await env.counts(dupKey);
        expect(Object.keys(steps)).toHaveLength(n);
        console.log(
          `[15a] step bodies executed more than once: ${JSON.stringify(Object.entries(steps).filter(([, c]) => c !== 1))}`,
        );
        env.expectCleanWorkerLogs();
      },
    );

    test(
      "15b. duplicates enqueued while the run sleeps (they all wake together)",
      { timeout: 180_000 },
      async () => {
        const env = await Env.create({ workers: 3 });
        const controlKey = env.counterKey("control");
        const control = await env.invoke(W.sleepyRun, ["3s", controlKey]);
        await env.waitForRuns([control]);

        const dupKey = env.counterKey("dup");
        const dup = await env.invoke(W.sleepyRun, ["3s", dupKey]);
        await waitForEvent(env, [dup], "wait_created");
        const { workflowName } = await env.getRun(dup);
        for (let i = 0; i < 6; i++)
          await env.world.queue(queueNameOf(workflowName), {
            runId: dup,
          } as never);
        await env.waitForRuns([dup]);
        await env.waitForQueueIdle();

        expect(await env.output(dup)).toBe("done");
        const controlEvents = await env.expectDenseLog(control);
        const dupEvents = await env.expectDenseLog(dup);
        const dupCounts = Env.countByType(dupEvents);
        expect(dupCounts.run_completed, "run_completed").toBe(1);
        expect(dupCounts.wait_completed, "wait_completed").toBe(2);
        expect(dupCounts).toEqual(Env.countByType(controlEvents));
        expect(dupEvents.length, "event count equals the control run").toBe(
          controlEvents.length,
        );
        expect(
          await env.counts(dupKey),
          "each step body ran exactly once",
        ).toEqual({
          first: 1,
          second: 1,
          third: 1,
        });
        env.expectCleanWorkerLogs();
      },
    );

    test(
      "15c. duplicates enqueued after the run completed change nothing",
      { timeout: 120_000 },
      async () => {
        const env = await Env.create({ workers: 2 });
        const runId = await env.invoke(W.chain, [5]);
        await env.waitForRuns([runId]);
        await env.waitForQueueIdle();
        const before = await env.expectDenseLog(runId);

        const { workflowName } = await env.getRun(runId);
        for (let i = 0; i < 4; i++)
          await env.world.queue(queueNameOf(workflowName), { runId } as never);
        await env.waitForQueueIdle();
        await sleep(1_000);

        const after = await env.expectDenseLog(runId);
        expect(after.map((e) => e.eventId)).toEqual(
          before.map((e) => e.eventId),
        );
        expect(await env.status(runId)).toBe("completed");
        expect(Env.countByType(after).run_completed).toBe(1);
        env.expectCleanWorkerLogs();
      },
    );
  });
});
