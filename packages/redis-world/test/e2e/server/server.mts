/**
 * One e2e worker: a small HTTP server that mounts the generated workflow flow
 * route (so the world's queue worker can deliver jobs back to it), plus the
 * control endpoints the tests drive. Modeled on world-testing's src/server.mts.
 *
 * Run with node (type stripping), from the package root:
 *   WORKFLOW_TARGET_WORLD=... WORKFLOW_REDIS_URL=... node test/e2e/server/server.mts
 *
 * It prints one machine-readable line once it is serving AND the world's
 * background tasks are started:
 *   E2E_READY {"port":1234,"pid":5678}
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Redis } from "ioredis";
import { WorkflowRunFailedError } from "workflow/errors";
import { getHookByToken, getRun, resumeHook, start } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.WORKFLOW_TARGET_WORLD) {
  console.error("WORKFLOW_TARGET_WORLD is not set");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const wellKnown = join(here, "..", ".well-known", "workflow", "v1");
// Dynamic so that neither tsc nor vitest needs the generated bundle to exist.
const { POST: flowPOST } = (await import(
  pathToFileURL(join(wellKnown, "flow.mjs")).href
)) as {
  POST: (req: Request) => Response | Promise<Response>;
};
const manifest = createRequire(import.meta.url)(
  join(wellKnown, "manifest.json"),
) as {
  workflows: Record<string, Record<string, { workflowId: string }>>;
};

// Evidence channel for step bodies (see workflows/support.ts). Steps run in
// this process, so a Redis client here lets them count their own executions.
const evidenceRedis = new Redis(
  process.env.WORKFLOW_REDIS_URL ?? "redis://localhost:6379",
  {
    maxRetriesPerRequest: null,
  },
);
evidenceRedis.on("error", () => {});
const workerName = process.env.E2E_WORKER_NAME ?? `w${process.pid}`;
(globalThis as Record<string, unknown>).__e2e = {
  // Counts one execution of a step body: `key[field] += 1`, and which worker
  // process ran it in `key:exec['<field>#<n>'] = worker`.
  count: async (key: string, field: string) => {
    const n = await evidenceRedis.hincrby(key, field, 1);
    await Promise.all([
      evidenceRedis.hset(`${key}:exec`, `${field}#${n}`, workerName),
      evidenceRedis.hset(`${key}:exec-at`, `${field}#${n}`, String(Date.now())),
    ]);
    return n;
  },
};

/** Deliveries of a workflow job this process has accepted (the flow route hits). */
let flowHits = 0;
/** Deliveries that the queue says are not a message's first (delivery-count > 1) or retry (attempt > 1). */
const redeliveries: Array<{
  messageId: string | null;
  attempt: string | null;
  deliveryCount: string | null;
  at: number;
}> = [];

function jsonError(error: unknown, status = 500) {
  const e = error as { name?: string; message?: string; stack?: string };
  return Response.json(
    { error: { name: e?.name, message: e?.message, stack: e?.stack } },
    { status },
  );
}

const app = new Hono()
  .post("/.well-known/workflow/v1/flow", (ctx) => {
    flowHits++;
    const h = ctx.req.raw.headers;
    const attempt = h.get("x-vqs-message-attempt");
    const deliveryCount = h.get("x-vqs-message-delivery-count");
    if (
      (deliveryCount && deliveryCount !== "1") ||
      (attempt && attempt !== "1")
    ) {
      if (redeliveries.length < 200) {
        redeliveries.push({
          messageId: h.get("x-vqs-message-id"),
          attempt,
          deliveryCount,
          at: Date.now(),
        });
      }
    }
    if (
      process.env.E2E_ATTEMPT_FROM_DELIVERY === "1" &&
      deliveryCount &&
      Number(deliveryCount) > Number(attempt ?? 1)
    ) {
      // Diagnosis knob (off by default): report a crash/stall redelivery to the
      // SDK as attempt >= 2, i.e. what a queue's crash redelivery would give it.
      const headers = new Headers(h);
      headers.set("x-vqs-message-attempt", deliveryCount);
      return (async () =>
        flowPOST(
          new Request(ctx.req.raw.url, {
            method: "POST",
            headers,
            body: await ctx.req.raw.arrayBuffer(),
          }),
        ))();
    }
    return flowPOST(ctx.req.raw);
  })
  .get("/_ping", (ctx) =>
    ctx.json({ worker: workerName, pid: process.pid, flowHits, redeliveries }),
  )
  .get("/_stats", async (ctx) => {
    const world = (await getWorld()) as unknown as {
      getQueueStats?: () => Promise<unknown>;
    };
    return ctx.json({
      worker: workerName,
      queue: await world.getQueueStats?.(),
    });
  })
  .post("/invoke", async (ctx) => {
    try {
      const body = (await ctx.req.json()) as {
        file: string;
        workflow: string;
        args?: unknown[];
        options?: Record<string, unknown>;
      };
      const entry = manifest.workflows[body.file]?.[body.workflow];
      if (!entry)
        return Response.json(
          {
            error: {
              message: `unknown workflow ${body.file}#${body.workflow}`,
            },
          },
          { status: 400 },
        );
      const run = await start(
        { workflowId: entry.workflowId } as never,
        body.args ?? [],
        body.options as never,
      );
      return ctx.json({ runId: run.runId });
    } catch (error) {
      return jsonError(error);
    }
  })
  .post("/hooks/:token", async (ctx) => {
    const token = ctx.req.param("token");
    try {
      const hook = await getHookByToken(token);
      const result = await resumeHook(hook.token, await ctx.req.json());
      return ctx.json({ runId: result.runId, hookId: hook.hookId });
    } catch (error) {
      return jsonError(
        error,
        (error as { name?: string })?.name === "HookNotFoundError" ? 404 : 500,
      );
    }
  })
  // Block (up to ?timeoutMs) for the run's terminal state, as the SDK's
  // `run.returnValue` reports it. Failure details are hydrated by the SDK.
  .get("/runs/:runId/result", async (ctx) => {
    const timeoutMs = Number(ctx.req.query("timeoutMs") ?? 60_000);
    const run = getRun(ctx.req.param("runId"));
    const timeout = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        run.returnValue,
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => resolve(timeout), timeoutMs);
        }),
      ]);
      if (outcome === timeout) return ctx.json({ status: "timeout" });
      return ctx.json({ status: "completed", value: outcome });
    } catch (error) {
      if (WorkflowRunFailedError.is(error)) {
        const cause = (error as { cause?: unknown }).cause as
          | { name?: string; message?: string }
          | undefined;
        return ctx.json({
          status: "failed",
          errorCode: (error as { errorCode?: string }).errorCode ?? null,
          message: error.message,
          cause:
            cause && typeof cause === "object"
              ? { name: cause.name, message: cause.message }
              : (cause ?? null),
        });
      }
      return jsonError(error);
    } finally {
      clearTimeout(timer);
    }
  })
  // Drain the run's default stream chunk by chunk, until it closes.
  .get("/runs/:runId/chunks", async (ctx) => {
    const timeoutMs = Number(ctx.req.query("timeoutMs") ?? 60_000);
    const readable = getRun(
      ctx.req.param("runId"),
    ).getReadable() as ReadableStream<unknown>;
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return ctx.json({ closed: false, chunks });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const next = await Promise.race([
          reader.read(),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), remaining);
          }),
        ]);
        clearTimeout(timer);
        if (next === "timeout") return ctx.json({ closed: false, chunks });
        if (next.done) return ctx.json({ closed: true, chunks });
        const value = next.value;
        chunks.push(
          typeof value === "string"
            ? value
            : value instanceof Uint8Array
              ? decoder.decode(value)
              : JSON.stringify(value),
        );
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  });

serve(
  { fetch: app.fetch, port: Number(process.env.E2E_PORT) || 0 },
  async (info) => {
    // The world delivers jobs back to http://localhost:$PORT (src/queue.ts
    // resolveBaseUrl), so publish the real port before starting its worker.
    process.env.PORT = String(info.port);
    const world = await getWorld();
    if (world.start) await world.start();
    console.log(
      `E2E_READY ${JSON.stringify({ port: info.port, pid: process.pid, worker: workerName })}`,
    );
  },
);

// Graceful stop for tests that want one (SIGTERM); chaos tests use SIGKILL.
process.on("SIGTERM", async () => {
  const forced = setTimeout(() => process.exit(0), 3000);
  forced.unref();
  try {
    const world = await getWorld();
    await world.close?.();
  } finally {
    process.exit(0);
  }
});
