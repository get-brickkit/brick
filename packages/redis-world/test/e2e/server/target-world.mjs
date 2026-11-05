/**
 * WORKFLOW_TARGET_WORLD module for e2e workers that need tunables the
 * package's env-var configuration does not expose (heartbeatTtlMs, lockDuration,
 * maxAttempts, backoffDelayMs, ...).
 *
 * It wraps the BUILT package under test (E2E_WORLD_ENTRY, its dist/), never
 * src/, and takes its tunables from E2E_WORLD_CONFIG (JSON). Connection and
 * prefixes come from the WORKFLOW_REDIS_* variables, which createWorld reads
 * under the config it is passed.
 *
 * With E2E_TRACE_WORLD=1 it also logs every events.create / events.list call
 * the SDK makes against the world (diagnosis aid; off by default).
 */
const { createWorld: createRedisWorld } = await import(
  process.env.E2E_WORLD_ENTRY
);

const short = (id) => (typeof id === "string" ? id.slice(-6) : id);

function trace(world) {
  const log = (...args) => console.log("[trace]", Date.now() % 100000, ...args);
  const create = world.events.create.bind(world.events);
  world.events.create = async (runId, data, params) => {
    const label = `create ${short(runId)} ${data?.eventType} corr=${short(data?.correlationId)}${params ? ` params=${JSON.stringify(params)}` : ""}`;
    try {
      const result = await create(runId, data, params);
      log(
        label,
        "->",
        result?.event
          ? `${result.event.eventType}@${result.event.eventId?.slice(-3)}`
          : "no-event",
        result?.step
          ? `step=${result.step.status}/a${result.step.attempt}`
          : "",
      );
      return result;
    } catch (error) {
      log(label, "-> THROW", error?.name, String(error?.message).slice(0, 120));
      throw error;
    }
  };
  const list = world.events.list.bind(world.events);
  world.events.list = async (params) => {
    const page = await list(params);
    log(
      `list ${short(params?.runId)} ->`,
      page.data.length,
      "events",
      page.data.map((e) => `${e.eventId.slice(-3)}:${e.eventType}`).join(","),
      `hasMore=${page.hasMore}`,
    );
    return page;
  };
  return world;
}

export function createWorld() {
  const tuning = JSON.parse(process.env.E2E_WORLD_CONFIG || "{}");
  const world = createRedisWorld(tuning);
  return process.env.E2E_TRACE_WORLD === "1" ? trace(world) : world;
}
