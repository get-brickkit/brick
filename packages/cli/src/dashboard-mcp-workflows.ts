import {
  compactJson,
  cut,
  DEFAULT_LIST_LIMIT,
  integer,
  MAX_LIST_LIMIT,
  READ_ONLY,
  text,
  TIME_HELP,
  time,
  type Args,
  type BuiltInTool,
  type McpSources,
} from "./dashboard-mcp-args";
import {
  describeSchedule,
  INSPECTOR_READ_ONLY_HEADER,
  INSPECTOR_TOKEN_HEADER,
  ROUTES,
} from "./dashboard-protocol";

/*
 * The workflow runs and schedules the dashboard's Workflows and Schedules views
 * show, read from the workflow inspector the dashboard proxies. Every call is
 * marked read-only, so the inspector refuses whatever would change a run, and
 * only the reads below can be asked for.
 */

/** The inspector's RPC methods these tools may call. All of them read. */
const READ_RPC = ["fetchRuns", "fetchRun", "fetchEvents"] as const;
type ReadRpc = (typeof READ_RPC)[number];

const RPC_PATH = `${ROUTES.workflows.path}/api/rpc`;
const INSPECTOR_TIMEOUT_MS = 10_000;
const RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
const RUNS_PER_PAGE = 100;
/** A run list reads at most this many pages of runs to fill its limit. */
const MAX_RUN_PAGES = 10;
const EVENTS_PER_PAGE = 1000;
const MAX_EVENT_PAGES = 5;
const LAST_SCHEDULE_RUNS = 5;
const MAX_ERROR_CHARS = 500;
/** A `get_run` answer is cut to about this many characters of JSON. */
export const MAX_RUN_CHARS = 50_000;
/** From mildest to harshest: the first that fits the cap is the answer. */
const RUN_LEVELS_MILDEST_FIRST = [
  { value: 2000, steps: 200 },
  { value: 500, steps: 100 },
  { value: 100, steps: 50 },
  { value: 0, steps: 20 },
] as const;

interface InspectorTarget {
  port: number;
  token: string;
}

async function askInspector(
  target: InspectorTarget,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${target.port}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      [INSPECTOR_TOKEN_HEADER]: target.token,
      // The inspector refuses every call that changes something from this caller.
      [INSPECTOR_READ_ONLY_HEADER]: "1",
    },
    signal: AbortSignal.timeout(INSPECTOR_TIMEOUT_MS),
  });
}

/**
 * A hook's token resumes it from outside the dashboard, and only a signed-in
 * user may have it. The inspector sends none to a read-only caller; this takes
 * out any that is left, wherever it sits.
 */
export function withoutHookTokens<T>(value: T): T {
  if (Array.isArray(value)) return value.map(withoutHookTokens) as T;
  if (value === null || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  const isHook =
    "hookId" in row || String(row.eventType ?? "").startsWith("hook_");
  const kept: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(row)) {
    if (isHook && key === "token") continue;
    kept[key] =
      isHook && key === "eventData" && entry && typeof entry === "object"
        ? withoutHookTokens(
            Object.fromEntries(
              Object.entries(entry).filter(([name]) => name !== "token"),
            ),
          )
        : withoutHookTokens(entry);
  }
  return kept as T;
}

/** One read of the inspector's RPC: its `data`, or the error it answered. */
export async function inspectorRpc(
  target: InspectorTarget,
  method: ReadRpc,
  params: Record<string, unknown>,
): Promise<any> {
  if (!READ_RPC.includes(method))
    throw new Error(`The dashboard's MCP does not call ${method}.`);
  const response = await askInspector(target, RPC_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ method, params }),
  });
  const answer = (await response.json().catch(() => undefined)) as
    | { success: boolean; data?: unknown; error?: { message?: string } }
    | undefined;
  if (!response.ok || !answer?.success)
    throw new Error(
      answer?.error?.message ??
        `The workflow inspector answered ${response.status}.`,
    );
  return withoutHookTokens(answer.data);
}

/** The last part of a workflow's machine name, `workflow//./src/orders//ship`: `ship`. */
const shortName = (workflowName: string) =>
  workflowName.split("//").pop() || workflowName;

const dateOf = (value: unknown): number | undefined => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
};

const durationMs = (from: unknown, to: unknown) => {
  const start = dateOf(from);
  const end = dateOf(to);
  return start === undefined || end === undefined ? undefined : end - start;
};

function runRow(run: any) {
  return {
    runId: run.runId,
    workflow: shortName(String(run.workflowName)),
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: durationMs(run.startedAt ?? run.createdAt, run.completedAt),
    error: run.error?.message ? cut(String(run.error.message), 300) : undefined,
  };
}

async function listRuns(target: InspectorTarget, args: Args) {
  const status = text(args, "status");
  if (status && !RUN_STATUSES.includes(status as never))
    throw new Error(`status must be one of: ${RUN_STATUSES.join(", ")}.`);
  const workflow = text(args, "workflow");
  const now = Date.now();
  const from = time(args.from, "from", now);
  const to = time(args.to, "to", now) ?? now;
  const limit = integer(args, "limit", 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT)!;
  const found: any[] = [];
  let cursor: string | undefined;
  let more = false;
  // Newest first: stop at a run older than the window, or when there is enough.
  for (let page = 0; page < MAX_RUN_PAGES && found.length <= limit; page++) {
    const answer = await inspectorRpc(target, "fetchRuns", {
      limit: RUNS_PER_PAGE,
      sortOrder: "desc",
      cursor,
      ...(status ? { status } : {}),
    });
    let passedWindow = false;
    for (const run of answer.data as any[]) {
      const created = dateOf(run.createdAt) ?? 0;
      if (from !== undefined && created < from) {
        passedWindow = true;
        break;
      }
      if (created > to) continue;
      if (
        workflow &&
        run.workflowName !== workflow &&
        shortName(String(run.workflowName)) !== workflow
      )
        continue;
      found.push(run);
    }
    more = Boolean(answer.hasMore) && !passedWindow;
    cursor = answer.cursor ?? undefined;
    if (!more || !cursor) break;
  }
  return compactJson({
    runs: found.slice(0, limit).map(runRow),
    ...(found.length > limit ? { hasMore: true } : {}),
  });
}

interface Level {
  value: number;
  steps: number;
}

/** A value as it is, or a preview of its JSON when that is longer than `limit`. */
function bounded(value: unknown, limit: number): unknown {
  if (value === undefined) return undefined;
  const json = JSON.stringify(value) ?? "";
  if (json.length <= limit) return value;
  return limit === 0
    ? { left: "out", chars: json.length }
    : { preview: cut(json, limit), chars: json.length };
}

/** A run's steps, from the events that record them: a step's events share a correlation id. */
function stepsOf(events: any[]) {
  const steps = new Map<string, any>();
  for (const event of events) {
    if (!String(event.eventType).startsWith("step_") || !event.correlationId)
      continue;
    const step = steps.get(event.correlationId) ?? {
      stepId: event.correlationId,
      status: "pending",
      attempts: 0,
      retries: [] as unknown[],
    };
    steps.set(event.correlationId, step);
    const data = event.eventData ?? {};
    step.name ??= data.stepName;
    step.createdAt ??= event.createdAt;
    switch (event.eventType) {
      case "step_started":
        step.status = "running";
        step.attempts += 1;
        step.startedAt ??= event.createdAt;
        step.completedAt = undefined;
        if (data.input !== undefined) step.input ??= data.input;
        break;
      case "step_created":
        if (data.input !== undefined) step.input ??= data.input;
        break;
      case "step_retrying":
        step.status = "pending";
        step.retries.push({
          attempt: data.attempt,
          error: data.error,
          retryAfter: data.retryAfter,
        });
        break;
      case "step_completed":
        step.status = "completed";
        step.completedAt = event.createdAt;
        step.output = data.result;
        break;
      case "step_failed":
        step.status = "failed";
        step.completedAt = event.createdAt;
        step.error = data.error;
        break;
    }
  }
  return [...steps.values()];
}

function hooksOf(events: any[]) {
  const hooks = new Map<string, any>();
  for (const event of events) {
    if (!String(event.eventType).startsWith("hook_") || !event.correlationId)
      continue;
    const hook = hooks.get(event.correlationId) ?? {
      hookId: event.correlationId,
      received: 0,
      disposed: false,
    };
    hooks.set(event.correlationId, hook);
    if (event.eventType === "hook_created") hook.createdAt = event.createdAt;
    if (event.eventType === "hook_received") hook.received += 1;
    if (event.eventType === "hook_disposed") hook.disposed = true;
  }
  return [...hooks.values()];
}

function runAnswer(
  run: any,
  steps: any[],
  hooks: any[],
  eventsRead: number,
  moreEvents: boolean,
  level: Level,
) {
  const shown = steps.slice(0, level.steps);
  return {
    runId: run.runId,
    workflow: shortName(String(run.workflowName)),
    workflowName: run.workflowName,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    durationMs: durationMs(run.startedAt ?? run.createdAt, run.completedAt),
    input: bounded(run.input, level.value),
    output: bounded(run.output, level.value),
    error: run.error && {
      message: cut(String(run.error.message ?? ""), MAX_ERROR_CHARS),
      stack: cut(run.error.stack, Math.max(level.value, 0)),
    },
    steps: shown.map((step) => ({
      stepId: step.stepId,
      name: step.name,
      status: step.status,
      attempts: step.attempts,
      createdAt: step.createdAt,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      durationMs: durationMs(step.startedAt, step.completedAt),
      input: bounded(step.input, level.value),
      output: bounded(step.output, level.value),
      error: bounded(step.error, level.value),
      retries: bounded(
        step.retries.length ? step.retries : undefined,
        level.value,
      ),
    })),
    hooks,
    note:
      shown.length < steps.length ||
      moreEvents ||
      level !== RUN_LEVELS_MILDEST_FIRST[0]
        ? `Cut to fit about ${MAX_RUN_CHARS / 1000} KB.${shown.length < steps.length ? ` ${steps.length - shown.length} steps are left out.` : ""}${level !== RUN_LEVELS_MILDEST_FIRST[0] ? " Long inputs, outputs and errors are shortened or left out." : ""}${moreEvents ? ` Only the first ${eventsRead} events were read, so later steps may be missing.` : ""}`
        : undefined,
  };
}

async function getRun(target: InspectorTarget, args: Args) {
  const runId = text(args, "run_id");
  if (!runId) throw new Error("run_id is required.");
  const run = await inspectorRpc(target, "fetchRun", { runId });
  const events: any[] = [];
  let cursor: string | undefined;
  let moreEvents = false;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const answer = await inspectorRpc(target, "fetchEvents", {
      runId,
      withData: true,
      sortOrder: "asc",
      limit: EVENTS_PER_PAGE,
      cursor,
    });
    events.push(...answer.data);
    cursor = answer.cursor ?? undefined;
    moreEvents = Boolean(answer.hasMore);
    if (!moreEvents || !cursor) break;
  }
  const steps = stepsOf(events);
  const hooks = hooksOf(events);
  let answer = "";
  for (const level of RUN_LEVELS_MILDEST_FIRST) {
    answer = compactJson(
      runAnswer(run, steps, hooks, events.length, moreEvents, level),
    );
    if (answer.length <= MAX_RUN_CHARS) break;
  }
  return answer;
}

async function listSchedules(target: InspectorTarget) {
  const response = await askInspector(target, ROUTES.schedules.path);
  if (!response.ok)
    throw new Error(`The schedules answered ${response.status}.`);
  const schedules = withoutHookTokens(await response.json()) as any[];
  return compactJson({
    schedules: schedules.map((schedule) => ({
      name: schedule.name,
      kind: schedule.kind,
      schedule: describeSchedule(schedule),
      enabled: schedule.enabled,
      running: schedule.running,
      nextRunAt: schedule.nextRunAt,
      attempts: schedule.attempts,
      lastSuccessAt: schedule.lastSuccessAt,
      lastRuns: (schedule.runs ?? [])
        .slice(0, LAST_SCHEDULE_RUNS)
        .map((run: any) => ({
          slot: run.slot,
          trigger: run.trigger,
          attempt: run.attempt,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          outcome: run.outcome,
          error: cut(run.error, MAX_ERROR_CHARS),
        })),
    })),
  });
}

/** The Schedules and Workflows views, while the dashboard serves the inspector. */
export function workflowTools(sources: McpSources): BuiltInTool[] {
  const { store } = sources;
  const served = () =>
    sources.inspector ? store.inspectorTarget() : undefined;
  const hasSchedules = () =>
    Boolean(served() && store.architecture()?.schema.events?.schedules?.length);
  const hasWorkflows = () => Boolean(served() && store.servesWorkflows());
  const target = () => {
    const found = served();
    if (!found) throw new Error("The workflow inspector is not being served.");
    return found;
  };
  return [
    {
      definition: {
        name: "list_schedules",
        description:
          "The app's schedules, as the Schedules view shows them: each one's name, kind (handler or workflow), cron or interval, whether it is enabled and running, when it is next due, when it last succeeded, and its last five runs with their outcome (succeeded, failed or skipped) and error. Look here when something that should run on a timer did not.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: READ_ONLY,
      },
      available: hasSchedules,
      run: () => listSchedules(target()),
    },
    {
      definition: {
        name: "list_runs",
        description: `Workflow runs, newest first, as the Workflows view lists them: run id, workflow, status, when it was created and finished, how long it took, and its error. Filter by status (pending, running, completed, failed or cancelled), workflow name and time window. Start with status "failed", then open one with get_run. It reads up to ${MAX_RUN_PAGES * RUNS_PER_PAGE} runs to fill the limit.`,
        inputSchema: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: [...RUN_STATUSES],
              description: "Only runs in this state.",
            },
            workflow: {
              type: "string",
              description:
                "Only runs of this workflow, by the name list_runs shows.",
            },
            from: {
              type: "string",
              description: `Only runs created after this. ${TIME_HELP}`,
            },
            to: {
              type: "string",
              description: `Only runs created before this. ${TIME_HELP} Default: now.`,
            },
            limit: {
              type: "integer",
              minimum: 1,
              maximum: MAX_LIST_LIMIT,
              description: `Default ${DEFAULT_LIST_LIMIT}.`,
            },
          },
          additionalProperties: false,
        },
        annotations: READ_ONLY,
      },
      available: hasWorkflows,
      run: (args) => listRuns(target(), args),
    },
    {
      definition: {
        name: "get_run",
        description: `One workflow run in full, by run id: its input, output and error, and each step with its status, attempts, timing, input, output, error and retries, and its hooks (by id, never their tokens). Long values are shortened and the answer is cut to about ${MAX_RUN_CHARS / 1000} KB, and says what was left out.`,
        inputSchema: {
          type: "object",
          properties: {
            run_id: { type: "string", description: "From list_runs." },
          },
          required: ["run_id"],
          additionalProperties: false,
        },
        annotations: READ_ONLY,
      },
      available: hasWorkflows,
      run: (args) => getRun(target(), args),
    },
  ];
}

export const WORKFLOW_TOOL_NAMES = [
  "list_schedules",
  "list_runs",
  "get_run",
] as const;
