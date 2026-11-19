import { afterEach, describe, expect, it } from "bun:test";
import {
  inspectorRpc,
  MAX_RUN_CHARS,
  withoutHookTokens,
} from "../src/dashboard-mcp-workflows";
import { startDevDashboard } from "../src/dev-dashboard";
import { startInspector, type Inspector } from "../src/dev-inspector";
import { DevTelemetryStore } from "../src/dev-telemetry-store";

const token = "0123456789abcdef-secret";
const HOOK_TOKEN = "hook_token_that_resumes_a_hook";

const rpc = (method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

const run = (index: number, extra: Record<string, unknown> = {}) => ({
  runId: `wrun_${index}`,
  status: "completed",
  workflowName: `workflow//./src/orders//ship${index % 2 ? "Order" : "Parcel"}`,
  createdAt: new Date(Date.now() - index * 60_000).toISOString(),
  startedAt: new Date(Date.now() - index * 60_000 + 100).toISOString(),
  completedAt: new Date(Date.now() - index * 60_000 + 900).toISOString(),
  ...extra,
});

const event = (
  eventType: string,
  correlationId: string,
  at: number,
  eventData?: Record<string, unknown>,
) => ({
  eventId: `evt_${at}`,
  runId: "wrun_1",
  eventType,
  correlationId,
  createdAt: new Date(1_700_000_000_000 + at * 1000).toISOString(),
  ...(eventData ? { eventData } : {}),
});

/** A world that records every call that would change something. */
function stubWorld() {
  const world = {
    writes: [] as string[],
    runs: {
      list: async (options: {
        status?: string;
        pagination?: { limit?: number };
      }) => {
        const all = Array.from({ length: 6 }, (_, index) => {
          const failed = index === 2 || index === 3;
          return run(index + 1, {
            status: failed ? "failed" : "completed",
            ...(failed ? { error: { message: `step ${index} blew up` } } : {}),
          });
        }).filter((item) => !options.status || item.status === options.status);
        return { data: all, cursor: null, hasMore: false };
      },
      get: async (runId: string) =>
        run(1, {
          runId,
          status: "failed",
          input: { orderId: "o-1", card: "4242" },
          error: {
            message: "carrier timeout",
            stack: "Error: carrier timeout",
          },
        }),
    },
    events: {
      list: async () => ({
        data: world.events.rows,
        cursor: null,
        hasMore: false,
      }),
      create: async () => {
        world.writes.push("events.create");
      },
      rows: [
        event("run_created", "run", 1),
        event("step_created", "step_a", 2, {
          stepName: "step//./src/orders//charge",
          input: { amount: 12 },
        }),
        event("step_started", "step_a", 3, { attempt: 1 }),
        event("step_retrying", "step_a", 4, {
          error: { message: "card declined" },
          attempt: 1,
        }),
        event("step_started", "step_a", 5, { attempt: 2 }),
        event("step_completed", "step_a", 6, { result: { charged: true } }),
        event("step_created", "step_b", 7, { stepName: "step//./src//ship" }),
        event("step_started", "step_b", 8, { attempt: 1 }),
        event("step_failed", "step_b", 9, { error: { message: "no carrier" } }),
        event("hook_created", "hook_a", 10, { token: HOOK_TOKEN }),
        event("hook_received", "hook_a", 11),
      ] as Record<string, unknown>[],
    },
    hooks: {
      get: async (hookId: string) => ({ hookId, token: HOOK_TOKEN }),
    },
  };
  return world;
}

const schedule = {
  name: "nightly",
  kind: "handler",
  every: 86_400_000,
  enabled: true,
  nextRunAt: "2026-11-20T00:00:00.000Z",
  running: false,
  attempts: 0,
  lastSuccessAt: "2026-11-19T00:00:00.000Z",
  runs: Array.from({ length: 7 }, (_, index) => ({
    slot: `2026-11-1${index}T00:00:00.000Z`,
    trigger: "schedule",
    attempt: 1,
    startedAt: "2026-11-19T00:00:00.000Z",
    finishedAt: "2026-11-19T00:00:01.000Z",
    outcome: index === 1 ? "failed" : "succeeded",
    ...(index === 1 ? { error: "connection refused" } : {}),
  })),
};

const open: { stop(): void }[] = [];
afterEach(() => {
  for (const item of open.splice(0)) item.stop();
});

async function setup(
  options: {
    world?: ReturnType<typeof stubWorld>;
    workflows?: boolean;
    schedules?: boolean;
    inspector?: boolean;
    mode?: "dev" | "production";
  } = {},
) {
  const world = options.world ?? stubWorld();
  const triggered: string[] = [];
  const inspector = (await startInspector({
    events: {
      ...(options.workflows === false ? {} : { workflows: { world } }),
      ...(options.schedules === false
        ? {}
        : {
            schedules: {
              list: async () => [schedule],
              trigger: async (name: string) => triggered.push(name) > 0,
            },
          }),
      describe: () => ({ schedules: [{ name: "nightly" }] }),
    },
  } as never)) as Inspector;
  const store = new DevTelemetryStore();
  if (options.inspector !== false)
    store.setInspector({
      port: inspector.port,
      token: inspector.token,
      workflows: inspector.workflows,
    });
  store.setArchitecture(
    {
      version: "1",
      services: [],
      events: {
        listeners: [],
        dispatch: false,
        recorders: [],
        ...(options.schedules === false
          ? {}
          : {
              schedules: [{ name: "nightly", kind: "handler", enabled: true }],
            }),
      },
    },
    1,
  );
  const production = options.mode === "production";
  const dashboard = await startDevDashboard({
    port: 0,
    store,
    ...(production
      ? {
          mode: "production" as const,
          mcp: true,
          inspector: options.inspector,
          auth: { token },
        }
      : {}),
  });
  open.push({
    stop() {
      dashboard.stop();
      inspector.stop();
    },
  });
  const base = `http://127.0.0.1:${dashboard.port}`;
  const headers = production ? { authorization: `Bearer ${token}` } : {};
  const post = (body: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  return {
    world,
    triggered,
    inspector,
    async names() {
      const { result } = await (await post(rpc("tools/list"))).json();
      return result.tools.map(
        (tool: { name: string }) => tool.name,
      ) as string[];
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const { result, error } = await (
        await post(rpc("tools/call", { name, arguments: args }))
      ).json();
      if (error) return { rpcError: error };
      const body: string = result.content[0].text;
      return result.isError
        ? { isError: true as const, text: body }
        : { isError: false as const, text: body, data: JSON.parse(body) };
    },
  };
}

const WORKFLOW_TOOLS = ["list_schedules", "list_runs", "get_run"];
const has = (names: string[]) =>
  WORKFLOW_TOOLS.filter((name) => names.includes(name));

describe("the workflow and schedule tools", () => {
  it("are listed when the dashboard serves the inspector, and left out when it does not", async () => {
    const both = await setup();
    expect(has(await both.names())).toEqual(WORKFLOW_TOOLS);

    // Schedules only: no workflow runs to list.
    const schedulesOnly = await setup({ workflows: false });
    expect(has(await schedulesOnly.names())).toEqual(["list_schedules"]);

    // Workflows only: no schedules to list.
    const workflowsOnly = await setup({ schedules: false });
    expect(has(await workflowsOnly.names())).toEqual(["list_runs", "get_run"]);

    // No inspector at all.
    const none = await setup({ inspector: false });
    expect(has(await none.names())).toEqual([]);
    expect(await none.call("list_runs")).toMatchObject({ rpcError: {} });
  });

  it("are left out in production unless the app turned the inspector on", async () => {
    const off = await setup({ mode: "production" });
    expect(has(await off.names())).toEqual([]);
    const on = await setup({ mode: "production", inspector: true });
    expect(has(await on.names())).toEqual(WORKFLOW_TOOLS);
  });

  it("list the schedules with their last runs", async () => {
    const { call, triggered } = await setup();
    const { data } = (await call("list_schedules")) as any;
    expect(data.schedules).toHaveLength(1);
    expect(data.schedules[0]).toMatchObject({
      name: "nightly",
      kind: "handler",
      schedule: "every 1d",
      enabled: true,
      running: false,
      nextRunAt: "2026-11-20T00:00:00.000Z",
      lastSuccessAt: "2026-11-19T00:00:00.000Z",
    });
    expect(data.schedules[0].lastRuns).toHaveLength(5);
    expect(data.schedules[0].lastRuns[1]).toMatchObject({
      outcome: "failed",
      error: "connection refused",
    });
    expect(triggered).toEqual([]);
  });

  it("list runs by status, workflow and window", async () => {
    const { call } = await setup();
    const all = (await call("list_runs")) as any;
    expect(all.data.runs).toHaveLength(6);
    expect(all.data.runs[0]).toMatchObject({
      runId: "wrun_1",
      workflow: "shipOrder",
      status: "completed",
      durationMs: 800,
    });

    const failed = (await call("list_runs", { status: "failed" })) as any;
    expect(failed.data.runs.map((item: any) => item.runId)).toEqual([
      "wrun_3",
      "wrun_4",
    ]);
    expect(failed.data.runs[0].error).toBe("step 2 blew up");

    const named = (await call("list_runs", { workflow: "shipParcel" })) as any;
    expect(named.data.runs.map((item: any) => item.runId)).toEqual([
      "wrun_2",
      "wrun_4",
      "wrun_6",
    ]);
    const recent = (await call("list_runs", { from: "150s" })) as any;
    expect(recent.data.runs.map((item: any) => item.runId)).toEqual([
      "wrun_1",
      "wrun_2",
    ]);
    const limited = (await call("list_runs", { limit: 2 })) as any;
    expect(limited.data.runs).toHaveLength(2);
    expect(limited.data.hasMore).toBe(true);
    expect(await call("list_runs", { status: "stuck" })).toMatchObject({
      isError: true,
    });
  });

  it("show one run with its steps, and never a hook token", async () => {
    const { call, world } = await setup();
    const answer = (await call("get_run", { run_id: "wrun_1" })) as any;
    expect(answer.text).not.toContain(HOOK_TOKEN);
    const { data } = answer;
    expect(data).toMatchObject({
      runId: "wrun_1",
      workflow: "shipOrder",
      status: "failed",
      input: { orderId: "o-1", card: "4242" },
      error: { message: "carrier timeout" },
    });
    expect(data.steps).toHaveLength(2);
    expect(data.steps[0]).toMatchObject({
      stepId: "step_a",
      name: "step//./src/orders//charge",
      status: "completed",
      attempts: 2,
      input: { amount: 12 },
      output: { charged: true },
    });
    expect(data.steps[0].retries).toEqual([
      { attempt: 1, error: { message: "card declined" } },
    ]);
    expect(data.steps[1]).toMatchObject({
      stepId: "step_b",
      status: "failed",
      error: { message: "no carrier" },
    });
    // Its hook is there, by id, with what happened to it.
    expect(data.hooks).toEqual([
      {
        hookId: "hook_a",
        createdAt: expect.any(String),
        received: 1,
        disposed: false,
      },
    ]);
    expect(world.writes).toEqual([]);
    expect(await call("get_run")).toMatchObject({ isError: true });
  });

  it("cut a run's long values and many steps to the cap, and say so", async () => {
    const world = stubWorld();
    world.runs.get = async (runId: string) =>
      run(1, { runId, input: "x".repeat(200_000) });
    const many = Array.from({ length: 400 }, (_, index) => [
      event("step_created", `step_${index}`, 100 + index * 2, {
        stepName: `step//./src//work${index}`,
        input: "y".repeat(3000),
      }),
      event("step_completed", `step_${index}`, 101 + index * 2, {
        result: "z".repeat(3000),
      }),
    ]).flat();
    world.events.rows = many;
    const { call } = await setup({ world });
    const answer = (await call("get_run", { run_id: "wrun_1" })) as any;
    expect(answer.text.length).toBeLessThanOrEqual(MAX_RUN_CHARS);
    expect(answer.data.note).toContain("Cut to fit");
    expect(answer.data.note).toContain("steps are left out");
    expect(answer.data.input.chars).toBe(200_002);
    expect(answer.data.steps.length).toBeLessThan(400);
  });

  it("only read: no write method can be asked for, and none reaches the world", async () => {
    const { call, world, inspector } = await setup();
    for (const name of WORKFLOW_TOOLS)
      await call(name, { run_id: "wrun_1", status: "failed" });
    await call("get_run", { run_id: "wrun_1" });
    expect(world.writes).toEqual([]);

    const target = { port: inspector.port, token: inspector.token };
    for (const method of [
      "cancelRun",
      "bulkCancelRuns",
      "recreateRun",
      "reenqueueRun",
      "wakeUpRun",
      "resumeHook",
      "fetchHookToken",
    ])
      await expect(
        inspectorRpc(target, method as never, { runId: "wrun_1" }),
      ).rejects.toThrow("does not call");
    expect(world.writes).toEqual([]);
  });
});

describe("withoutHookTokens", () => {
  it("takes the token out of a hook, wherever it sits, and leaves other tokens alone", () => {
    const row = {
      data: [
        { hookId: "h1", token: "secret", runId: "r" },
        {
          eventType: "hook_created",
          eventData: { token: "secret", isWebhook: true },
        },
        {
          eventType: "step_completed",
          eventData: { result: { token: "mine" } },
        },
      ],
      nested: [{ deeper: { hookId: "h2", token: "secret" } }],
    };
    expect(withoutHookTokens(row)).toEqual({
      data: [
        { hookId: "h1", runId: "r" },
        { eventType: "hook_created", eventData: { isWebhook: true } },
        {
          eventType: "step_completed",
          eventData: { result: { token: "mine" } },
        },
      ],
      nested: [{ deeper: { hookId: "h2" } }],
    });
  });
});
