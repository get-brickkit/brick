import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  RunNotSupportedError,
  TooEarlyError,
  WorkflowRunNotFoundError,
  WorkflowWorldError,
} from "@workflow/errors";
import type {
  AttributeChange,
  CreateEventParams,
  CreateEventRequest,
  Event,
  EventListResponse,
  EventResult,
  EventsResolveData,
  GetEventParams,
  GetHookParams,
  GetStepParams,
  GetWorkflowRunParams,
  Hook,
  ListEventsByCorrelationIdParams,
  ListEventsParams,
  ListHooksParams,
  ListWorkflowRunStepsParams,
  ListWorkflowRunsParams,
  PaginatedResponse,
  ResolveData,
  RunCreatedEventRequest,
  Step,
  StepWithoutData,
  Storage,
  WorkflowRun,
  WorkflowRunWithoutData,
} from "@workflow/world";
import {
  entityResolveData,
  EventSchema,
  eventIdToSlot,
  FIRST_EVENT_SLOT,
  HookSchema,
  isLegacySpecVersion,
  mintedSpecVersion,
  requiresNewerWorld,
  slotToEventId,
  StepSchema,
  stripEventDataRefs,
  validateAttributeChanges,
  WorkflowRunSchema,
} from "@workflow/world";
import { globalSingleton } from "@workflow/utils";
import type { Redis } from "ioredis";
import { monotonicFactory } from "ulid";
import { keys } from "./keys.js";
import { compact, parse, stringify } from "./util.js";

interface RedisStorageConfig {
  redis: Redis;
  keyPrefix: string;
  /** See `RedisWorldConfig.maxEventsPerRun`. */
  maxEventsPerRun?: number;
}

/** Per-run event ceiling reported to core, mirroring the Vercel World. */
const DEFAULT_MAX_EVENTS_PER_RUN = 25_000;

/** Resolve the per-run event ceiling surfaced as `EventResult.maxEvents`:
 * explicit config, then `WORKFLOW_MAX_EVENTS`, then the default. A
 * non-positive configured value throws rather than being ignored. */
function resolveMaxEventsPerRun(configured: number | undefined): number {
  if (configured !== undefined) {
    if (!Number.isInteger(configured) || configured <= 0) {
      throw new TypeError(
        `maxEventsPerRun must be a positive integer, received ${String(configured)}`,
      );
    }
    return configured;
  }
  const raw = process.env.WORKFLOW_MAX_EVENTS;
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_EVENTS_PER_RUN;
}

/** Events that mutate the run, so validation needs its full body. Everything
 * else only reads status/specVersion and is served from the run meta key. */
const RUN_LIFECYCLE_EVENT_TYPES = new Set([
  "run_started",
  "run_completed",
  "run_failed",
  "run_cancelled",
]);

/** Sentinel from the event scripts when a creation-dedup check rejects. */
const LUA_DUPLICATE_CREATION = -8;

/**
 * Stand-in for the event id inside the event JSON the caller hands to a script.
 * The id is a log position (`evnt_` + the 1-based slot), and a position may only
 * be chosen at the commit (see `LUA_APPEND_EVENT`), so the script writes it into
 * the JSON itself. `serializeEvent` always emits `eventId` as the first key, so
 * the first match is ours whatever the payload holds. A constant, not a random
 * value: two bundled copies of this module can share one connection's scripts.
 */
const EVENT_ID_PLACEHOLDER = "__brick_event_id__";

/**
 * Lua helper shared by every script that appends to a run's event log.
 *
 * A run's events live in one hash, `eventId -> JSON`. The log is dense and
 * 1-based, and a script runs atomically, so the next slot is the hash length
 * plus one and no other writer can interleave between reading it and writing the
 * event. That is the whole race story: the slot is chosen at the commit, in the
 * same operation that appends, and a writer that is behind simply lands on the
 * next free slot (the caller reports what it skipped).
 *
 * `appendEvent(eventsKey, correlationKey, json)` returns the new event id.
 * `correlationKey` may be nil. The id is written into `json` in place of the
 * placeholder, so what is stored is exactly what the reader parses.
 */
const LUA_APPEND_EVENT = `
local function appendEvent(eventsKey, correlationKey, json)
  local slot = redis.call('HLEN', eventsKey) + 1
  local digits = string.format('%d', slot)
  local eventId = 'evnt_' .. string.rep('0', 26 - #digits) .. digits
  local from, to = string.find(json, '${EVENT_ID_PLACEHOLDER}', 1, true)
  json = string.sub(json, 1, from - 1) .. eventId .. string.sub(json, to + 1)
  redis.call('HSET', eventsKey, eventId, json)
  if correlationKey then
    redis.call('ZADD', correlationKey, slot, eventId)
  end
  return eventId
end

-- A run's status from its meta key ('<status>|<specVersion>'), or false when absent.
local function runStatus(metaKey)
  local meta = redis.call('GET', metaKey)
  if not meta then
    return false
  end
  return string.match(meta, '^([^|]*)')
end

local function isTerminal(status)
  return status == 'completed' or status == 'failed' or status == 'cancelled'
end
`;

/** Stringify an object with Uint8Array support. Delegates to the shared
 * helper, which tags binary as base64; the previous number-array encoding
 * cost ~450x more CPU to re-parse and ~2.7x more storage at 2MB. */
function stringifyWithUint8Array(obj: any): string {
  return stringify(obj);
}

/** Parse JSON with Uint8Array and Date support. The shared reviver decodes
 * both the base64 tag and the legacy number-array tag, so rows already in
 * Redis keep reading back correctly. */
function parseWithUint8Array<T>(json: string): T {
  return parse<T>(json);
}

/**
 * Filter hook data based on resolveData parameter
 */
function filterHookData(hook: Hook, resolveData: ResolveData): Hook {
  if (resolveData === "none" && "metadata" in hook) {
    const { metadata: _, ...rest } = hook;
    return { metadata: undefined, ...rest };
  }
  return hook;
}

function filterStepData(step: Step, resolveData: "none"): StepWithoutData;
function filterStepData(step: Step, resolveData: "all"): Step;
function filterStepData(
  step: Step,
  resolveData: ResolveData,
): Step | StepWithoutData;
function filterStepData(
  step: Step,
  resolveData: ResolveData,
): Step | StepWithoutData {
  if (resolveData === "none") {
    const { input: _, output: __, ...rest } = step;
    return { input: undefined, output: undefined, ...rest };
  }
  return step;
}

function filterRunData(
  run: WorkflowRun,
  resolveData: "none",
): WorkflowRunWithoutData;
function filterRunData(run: WorkflowRun, resolveData: "all"): WorkflowRun;
function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData,
): WorkflowRun | WorkflowRunWithoutData;
function filterRunData(
  run: WorkflowRun,
  resolveData: ResolveData,
): WorkflowRun | WorkflowRunWithoutData {
  if (resolveData === "none") {
    const { input: _, output: __, ...rest } = run;
    return { input: undefined, output: undefined, ...rest };
  }
  return run;
}

// ============================================================
// Lua Scripts for Atomic Multi-Key Writes
// ============================================================
// Each script encapsulates a multi-key write operation to ensure
// atomicity. Lua scripts execute as a single atomic operation in
// Redis, preventing partial writes on connection failures AND
// check-then-write races between concurrent replays: every
// entity-creating event writes its entity and its creation event in ONE
// script, so no probe-then-append window exists (same design as
// world-redis).

/** One member of an index page, with the cursor that resumes after it. */
interface IndexEntry {
  id: string;
  score: number;
  cursor: string;
}

/**
 * Read up to `want` members of one or more sorted-set indexes, in score order,
 * resuming after `cursor`. With several indexes the members are merged into one
 * ordering, which is how a listing across statuses avoids scanning an index of
 * every run there has ever been.
 *
 * A cursor is the last member's `<score>|<id>`, not its rank: a rank means
 * nothing once that member has left the index (a run that changed status, a
 * hook that was disposed), and paging would fail halfway through a listing. A
 * position by score and id stays valid wherever the member went. Members that
 * share a score are ordered by id, as Redis orders them.
 */
async function pageIndex(
  redis: Redis,
  indexKeys: string | string[],
  cursor: string | undefined,
  want: number,
  order: "asc" | "desc" = "desc",
): Promise<IndexEntry[]> {
  let after: { score: number; id: string } | undefined;
  if (cursor) {
    const sep = cursor.indexOf("|");
    const score = sep > 0 ? Number(cursor.slice(0, sep)) : Number.NaN;
    if (Number.isNaN(score)) {
      throw new WorkflowWorldError(`Invalid pagination cursor "${cursor}"`, {
        status: 400,
      });
    }
    after = { score, id: cursor.slice(sep + 1) };
  }
  const bound = after
    ? String(after.score)
    : order === "desc"
      ? "+inf"
      : "-inf";

  const readOne = async (indexKey: string): Promise<IndexEntry[]> => {
    const out: IndexEntry[] = [];
    const batch = Math.max(want, 50);
    let offset = 0;
    while (out.length < want) {
      const raw =
        order === "desc"
          ? await redis.zrevrangebyscore(
              indexKey,
              bound,
              "-inf",
              "WITHSCORES",
              "LIMIT",
              offset,
              batch,
            )
          : await redis.zrangebyscore(
              indexKey,
              bound,
              "+inf",
              "WITHSCORES",
              "LIMIT",
              offset,
              batch,
            );
      for (let i = 0; i < raw.length && out.length < want; i += 2) {
        const id = raw[i];
        const score = Number(raw[i + 1]);
        // Entries that share the cursor's score and come at or before its id were
        // on an earlier page.
        if (
          after &&
          score === after.score &&
          (order === "desc" ? id >= after.id : id <= after.id)
        ) {
          continue;
        }
        out.push({ id, score, cursor: `${raw[i + 1]}|${id}` });
      }
      offset += raw.length / 2;
      if (raw.length / 2 < batch) break;
    }
    return out;
  };

  const keys = Array.isArray(indexKeys) ? indexKeys : [indexKeys];
  if (keys.length === 1) return readOne(keys[0]);

  const merged = (await Promise.all(keys.map(readOne))).flat();
  const direction = order === "desc" ? -1 : 1;
  merged.sort(
    (x, y) =>
      direction *
      (x.score - y.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
  );
  return merged.slice(0, want);
}

/**
 * Atomically create a run entity with all its indexes AND its creation
 * event. SETNX arbitrates duplicates: when the run already exists, NO
 * index, meta, or event write happens (a replayed run_created must not
 * reset index scores, re-insert a terminal run into the pending status
 * index, or append a second creation event).
 *
 * KEYS[1] = run key
 * KEYS[2] = runs index key
 * KEYS[3] = runs by name key
 * KEYS[4] = runs by status key (pending)
 * KEYS[5] = run meta key
 * KEYS[6] = events key (the run's log)
 * KEYS[7] = run attributes key
 * ARGV[1] = run JSON
 * ARGV[2] = run ID
 * ARGV[3] = score (timestamp)
 * ARGV[4] = run meta value (`<status>|<specVersion>`)
 * ARGV[5] = event JSON (event id left as the placeholder)
 * ARGV[6..] = attribute key, value pairs to seed
 * Returns: [1, eventId] when created, [0, runJson] on replay.
 */
const LUA_CREATE_RUN_WITH_EVENT = `${LUA_APPEND_EVENT}
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1])}
  end
  local score = tonumber(ARGV[3])
  redis.call('ZADD', KEYS[2], score, ARGV[2])
  redis.call('ZADD', KEYS[3], score, ARGV[2])
  redis.call('ZADD', KEYS[4], score, ARGV[2])
  redis.call('SET', KEYS[5], ARGV[4])
  for i = 6, #ARGV, 2 do
    redis.call('HSET', KEYS[7], ARGV[i], ARGV[i + 1])
  end
  return {1, appendEvent(KEYS[6], nil, ARGV[5])}
`;

/**
 * Move a run to a new status, release its hooks when it finishes, and append the
 * lifecycle event, all in one execution. They are one script because a crash
 * between them would leave a terminal run with no terminal event (every retry is
 * then refused as terminal) or a started run with no `run_started` (the redelivery
 * takes the resume path and appends nothing).
 *
 * KEYS[1] = run key
 * KEYS[2] = old status index key
 * KEYS[3] = new status index key
 * KEYS[4] = run meta key
 * KEYS[5] = events key
 * KEYS[6] = hooks index key
 * KEYS[7] = hooks token-map key
 * ARGV[1] = updated run JSON
 * ARGV[2] = run ID
 * ARGV[3] = score (timestamp)
 * ARGV[4] = run meta value (`<status>|<specVersion>`)
 * ARGV[5] = the status the caller read the run in
 * ARGV[6] = event JSON
 * ARGV[7] = "1" to release the run's hooks (a terminal transition)
 * ARGV[8] = hook key prefix
 * ARGV[9] = hooks-by-token key prefix
 * Returns: [1, eventId] on success, [0, ''] if the run is absent, [-2, status] if
 *          the run is no longer in the status the caller read (another writer
 *          moved it first; nothing is written)
 */
const LUA_TRANSITION_RUN = `${LUA_APPEND_EVENT}
  if redis.call('EXISTS', KEYS[1]) == 0 then
    return {0, ''}
  end

  local current = runStatus(KEYS[4])
  if current and current ~= ARGV[5] then
    return {-2, current}
  end

  redis.call('SET', KEYS[1], ARGV[1])
  redis.call('SET', KEYS[4], ARGV[4])
  redis.call('ZREM', KEYS[2], ARGV[2])
  redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[2])

  if ARGV[7] == '1' then
    local pairsFlat = redis.call('HGETALL', KEYS[7])
    for i = 1, #pairsFlat, 2 do
      local hookId = pairsFlat[i]
      local tokenKey = ARGV[9] .. pairsFlat[i + 1]
      redis.call('DEL', ARGV[8] .. hookId)
      -- Only a token this hook still owns: a stale entry must not wipe a claim
      -- another run has taken since.
      if redis.call('GET', tokenKey) == hookId then
        redis.call('DEL', tokenKey)
      end
    end
    redis.call('DEL', KEYS[7])
    redis.call('DEL', KEYS[6])
  end

  return {1, appendEvent(KEYS[5], nil, ARGV[6])}
`;

/**
 * Atomically create a step entity with its index AND its creation event.
 * SETNX arbitrates duplicates: a replayed step_created writes nothing. A step is
 * never created on a finished run.
 *
 * KEYS[1] = step key
 * KEYS[2] = steps index key
 * KEYS[3] = events key
 * KEYS[4] = events by correlation key
 * KEYS[5] = step status key (see `LUA_STORE_EVENT`)
 * KEYS[6] = run meta key
 * ARGV[1] = step JSON
 * ARGV[2] = step ID (correlationId)
 * ARGV[3] = score (timestamp)
 * ARGV[4] = event JSON
 * ARGV[5] = step status value (`<status>|<attempt>`)
 * Returns: [1, eventId] when created, [0, stepJson] on replay, [-6, status] when
 *          the run is terminal
 */
const LUA_CREATE_STEP_WITH_EVENT = `${LUA_APPEND_EVENT}
  local status = runStatus(KEYS[6])
  if status and isTerminal(status) then
    return {-6, status}
  end
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1])}
  end
  redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[2])
  redis.call('SET', KEYS[5], ARGV[5])
  return {1, appendEvent(KEYS[3], KEYS[4], ARGV[4])}
`;

/**
 * Lazy step start: a `step_started` that carries the step's input also creates
 * the step. The step entity (already running, attempt 1), the synthetic
 * `step_created` and the `step_started` land together, so replay still sees the
 * creation, and exactly one concurrent caller wins the SETNX and runs the body.
 *
 * KEYS[1] = step key
 * KEYS[2] = steps index key
 * KEYS[3] = events key
 * KEYS[4] = events by correlation key
 * KEYS[5] = step status key (see `LUA_STORE_EVENT`)
 * KEYS[6] = run meta key
 * ARGV[1] = step JSON (running)
 * ARGV[2] = step ID (correlationId)
 * ARGV[3] = score (timestamp)
 * ARGV[4] = step_created event JSON
 * ARGV[5] = step_started event JSON
 * ARGV[6] = step status value (`running|1`)
 * Returns: [1, createdEventId, startedEventId] when created, [0, stepJson] when
 *          the step already exists (the caller lost the claim), [-6, status]
 *          when the run is terminal
 */
const LUA_CREATE_STEP_STARTED = `${LUA_APPEND_EVENT}
  local status = runStatus(KEYS[6])
  if status and isTerminal(status) then
    return {-6, status}
  end
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1])}
  end
  redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[2])
  redis.call('SET', KEYS[5], ARGV[6])
  local createdId = appendEvent(KEYS[3], KEYS[4], ARGV[4])
  local startedId = appendEvent(KEYS[3], KEYS[4], ARGV[5])
  return {1, createdId, startedId}
`;

/**
 * Atomically claim a hook token and create the hook entity, its indexes,
 * token-map entry, AND its creation event. The by-token key is the claim
 * arbiter (SETNX):
 * - A DIFFERENT hookId already owning the token -> cross-run conflict; the
 *   rightful owner's token mapping is left untouched. If that owner's hook no
 *   longer exists (a crash during cleanup left the token behind), the token is
 *   free and is taken over here, in the same execution, so a concurrent claim
 *   can never be wiped.
 * - The SAME hookId owning the token with the entity present -> duplicate.
 * Entity + event are written in the same atomic script, so a crash can
 * never leave a hook entity without its hook_created event (or vice versa). A
 * hook is never created on a finished run, which would hold its token forever.
 *
 * KEYS[1] = hook key
 * KEYS[2] = hooks by token key
 * KEYS[3] = hooks index key
 * KEYS[4] = hooks token-map key (hash of hookId -> token, per run)
 * KEYS[5] = events key
 * KEYS[6] = events by correlation key
 * KEYS[7] = run meta key
 * ARGV[1] = hook JSON
 * ARGV[2] = hook ID (correlationId)
 * ARGV[3] = score (timestamp)
 * ARGV[4] = the token, recorded in the token map so terminal-run cleanup can
 *           drop token lookups without reading every hook body
 * ARGV[5] = event JSON
 * ARGV[6] = hook key prefix
 * Returns: [2, owningHookId] on token conflict,
 *          [0, hookJson] when the hook already exists, or has existed (created
 *          and since disposed),
 *          [1, eventId] on success,
 *          [-6, status] when the run is terminal
 */
const LUA_CREATE_HOOK_WITH_EVENT = `${LUA_APPEND_EVENT}
  local status = runStatus(KEYS[7])
  if status and isTerminal(status) then
    return {-6, status}
  end
  -- Disposal removes the hook and its token, so a stale writer that loaded the log
  -- before the hook existed would otherwise create it again behind its disposal.
  -- The creation event is the record that it already happened.
  if redis.call('ZCARD', KEYS[6]) > 0 then
    return {0, ''}
  end
  local claimed = redis.call('SETNX', KEYS[2], ARGV[2])
  if claimed == 0 then
    local owner = redis.call('GET', KEYS[2])
    if owner ~= ARGV[2] then
      if redis.call('EXISTS', ARGV[6] .. owner) == 1 then
        return {2, owner}
      end
      redis.call('SET', KEYS[2], ARGV[2])
    end
  end
  local wasCreated = redis.call('SETNX', KEYS[1], ARGV[1])
  if wasCreated == 0 then
    return {0, redis.call('GET', KEYS[1])}
  end
  redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[2])
  redis.call('HSET', KEYS[4], ARGV[2], ARGV[4])
  return {1, appendEvent(KEYS[5], KEYS[6], ARGV[5])}
`;

/**
 * Atomically dispose a hook: delete the hook key, its token lookup (only while
 * it still points at this hook), its index entry and its token-map entry, and
 * append `hook_disposed`. One script, because a crash between the delete and the
 * append would lose the event, and a delete racing a `hook_received` must not
 * leave the received event behind the disposal in the log.
 *
 * KEYS[1] = hook key
 * KEYS[2] = hooks by token key
 * KEYS[3] = hooks index key
 * KEYS[4] = hooks token-map key
 * KEYS[5] = events key
 * KEYS[6] = events by correlation key
 * ARGV[1] = hook ID (correlationId)
 * ARGV[2] = event JSON
 * Returns: [1, eventId] if disposed, [0, ''] if the hook was not found
 */
const LUA_DISPOSE_HOOK = `${LUA_APPEND_EVENT}
  if redis.call('DEL', KEYS[1]) == 0 then
    return {0, ''}
  end
  if redis.call('GET', KEYS[2]) == ARGV[1] then
    redis.call('DEL', KEYS[2])
  end
  redis.call('ZREM', KEYS[3], ARGV[1])
  redis.call('HDEL', KEYS[4], ARGV[1])
  return {1, appendEvent(KEYS[5], KEYS[6], ARGV[2])}
`;

/**
 * Atomically append an event to the run's log and its correlation index,
 * optionally writing an entity first so the mutation and its event commit
 * together.
 *
 * KEYS[1] = events key
 * KEYS[2] = events by correlation key (or unused placeholder)
 * KEYS[3] = entity key (or unused placeholder)
 * KEYS[4] = hook resume claim key (or unused placeholder)
 * KEYS[5] = step status key (or unused placeholder)
 * KEYS[6] = run meta key (or unused placeholder)
 * KEYS[7] = hook key (or unused placeholder)
 * ARGV[1] = event JSON
 * ARGV[2] = has correlation ("1" or "0")
 * ARGV[3] = creation dedup: "1" rejects when the correlation index already holds
 *           an event (a wait or hook conflict recorded once), "2" rejects when it
 *           already holds two (a wait completed once)
 * ARGV[4] = entity JSON to write to KEYS[3] ('' to write nothing)
 * ARGV[5] = resume claim payload ('' when the event is not a lazy hook resume)
 * ARGV[6] = the step's new status ('' when the event writes no step)
 * ARGV[7] = the attempt the caller read ('' to skip the check)
 * ARGV[8] = the step's new attempt ('' to keep the current one)
 * ARGV[9] = "1" to refuse when the run is terminal
 * ARGV[10] = "1" to refuse when the hook (KEYS[7]) does not exist
 *
 * A lazy hook resume is claimed per (run, resumeId): the first writer appends and
 * records `<eventId>|<claim payload>`, a later one appends nothing and gets the
 * recorded claim back, so both writers converge on one event.
 *
 * A step write is a transition out of the state the caller read, so it is checked
 * where the state lives: a terminal step takes no further write, and a write that
 * read an older attempt than the step now has lost to another writer. Without
 * this two deliveries could both record an outcome, and the log would hold both.
 * The attempt counter is kept here, not taken from the caller's possibly stale
 * copy of the step, so it only moves forward.
 *
 * The run and hook guards live here because the checks the caller makes before
 * calling are stale by the time the event is appended: a `hook_received` must not
 * land behind the hook's disposal or the run's end, which no replay can consume.
 *
 * Returns: [1, eventId] on success, [-8, ''] when creation dedup rejects,
 *          [-7, ''] when completion dedup rejects, [3, claim] when a resume claim
 *          already exists, [-3, status] when the step is already terminal,
 *          [-4, attempt] when the step has moved past the attempt the caller
 *          read, [-6, status] when the run is terminal, [-5, ''] when the hook
 *          is gone
 */
const LUA_STORE_EVENT = `${LUA_APPEND_EVENT}
  if ARGV[5] ~= '' then
    local claim = redis.call('GET', KEYS[4])
    if claim then
      return {3, claim}
    end
  end

  if ARGV[10] == '1' and redis.call('EXISTS', KEYS[7]) == 0 then
    return {-5, ''}
  end

  if ARGV[9] == '1' then
    local status = runStatus(KEYS[6])
    if status and isTerminal(status) then
      return {-6, status}
    end
  end

  if ARGV[3] == '1' and redis.call('ZCARD', KEYS[2]) > 0 then
    return {${LUA_DUPLICATE_CREATION}, ''}
  end
  if ARGV[3] == '2' and redis.call('ZCARD', KEYS[2]) > 1 then
    return {-7, ''}
  end

  if ARGV[6] ~= '' then
    local current = redis.call('GET', KEYS[5])
    -- No key (a step written before it existed): the caller's read is the best
    -- attempt there is. Assuming 0 would make every later start look stale.
    local attempt = '0'
    if ARGV[7] ~= '' then
      attempt = ARGV[7]
    end
    if current then
      local status
      status, attempt = string.match(current, '^([^|]*)|?(.*)$')
      if status == 'completed' or status == 'failed' or status == 'cancelled' then
        return {-3, status}
      end
      if ARGV[7] ~= '' and attempt ~= ARGV[7] then
        return {-4, attempt}
      end
    end
    if ARGV[8] ~= '' then
      attempt = ARGV[8]
    end
    redis.call('SET', KEYS[5], ARGV[6] .. '|' .. attempt)
  end

  if ARGV[4] ~= '' then
    redis.call('SET', KEYS[3], ARGV[4])
  end

  local correlationKey = nil
  if ARGV[2] == '1' then
    correlationKey = KEYS[2]
  end
  local eventId = appendEvent(KEYS[1], correlationKey, ARGV[1])
  if ARGV[5] ~= '' then
    redis.call('SET', KEYS[4], eventId .. '|' .. ARGV[5])
  end
  return {1, eventId}
`;

/**
 * Atomically apply a batch of attribute changes and append the `attr_set` event.
 * Attributes live in a hash of their own, not in the run JSON, so two writers
 * changing different keys never overwrite each other.
 *
 * KEYS[1] = run attributes key
 * KEYS[2] = events key
 * KEYS[3] = events by correlation key (or unused placeholder)
 * KEYS[4] = run meta key
 * ARGV[1] = event JSON
 * ARGV[2] = has correlation ("1" or "0")
 * ARGV[3] = "1" to refuse a repeat for this correlation id (a replayed write)
 * ARGV[4..] = triples: attribute key, value, op ("set" or "del")
 * Returns: [1, eventId], [-6, status] when the run is terminal, [-8, ''] when
 *          this correlation id already set attributes
 */
const LUA_SET_ATTRIBUTES = `${LUA_APPEND_EVENT}
  local status = runStatus(KEYS[4])
  if status and isTerminal(status) then
    return {-6, status}
  end
  if ARGV[3] == '1' and ARGV[2] == '1' and redis.call('ZCARD', KEYS[3]) > 0 then
    return {${LUA_DUPLICATE_CREATION}, ''}
  end
  for i = 4, #ARGV, 3 do
    if ARGV[i + 2] == 'del' then
      redis.call('HDEL', KEYS[1], ARGV[i])
    else
      redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 1])
    end
  end
  local correlationKey = nil
  if ARGV[2] == '1' then
    correlationKey = KEYS[3]
  end
  return {1, appendEvent(KEYS[2], correlationKey, ARGV[1])}
`;

// ============================================================
// Script registration (EVALSHA)
// ============================================================

/** Registered via `defineCommand` so ioredis dispatches with `EVALSHA` rather
 * than shipping the script body every call. `LUA_STORE_EVENT` is ~1 KB and
 * runs once per workflow event. */
const SCRIPTS = {
  wfCreateRunWithEvent: { numberOfKeys: 7, lua: LUA_CREATE_RUN_WITH_EVENT },
  wfSetAttributes: { numberOfKeys: 4, lua: LUA_SET_ATTRIBUTES },
  wfTransitionRun: { numberOfKeys: 7, lua: LUA_TRANSITION_RUN },
  wfCreateStepWithEvent: { numberOfKeys: 6, lua: LUA_CREATE_STEP_WITH_EVENT },
  wfCreateStepStarted: { numberOfKeys: 6, lua: LUA_CREATE_STEP_STARTED },
  wfCreateHookWithEvent: { numberOfKeys: 7, lua: LUA_CREATE_HOOK_WITH_EVENT },
  wfDisposeHook: { numberOfKeys: 6, lua: LUA_DISPOSE_HOOK },
  wfStoreEvent: { numberOfKeys: 7, lua: LUA_STORE_EVENT },
} as const;

type ScriptName = keyof typeof SCRIPTS;
type ScriptFn = (...args: string[]) => Promise<unknown>;
type RedisWithScripts = Redis & Record<ScriptName, ScriptFn>;

/** Clients that already have the scripts attached; every storage factory
 * calls this with the same shared connection, so it must be idempotent. */
// Process-wide, not module-scoped: a bundled copy of this module must see the
// connections another copy already attached the scripts to.
const scriptState = globalSingleton(
  "@brickkit/redis-world//scripts",
  1,
  () => ({
    clients: new WeakSet<Redis>(),
  }),
);

function withScripts(redis: Redis): RedisWithScripts {
  if (!scriptState.clients.has(redis)) {
    for (const [name, def] of Object.entries(SCRIPTS)) {
      redis.defineCommand(name, {
        numberOfKeys: def.numberOfKeys,
        lua: def.lua,
      });
    }
    scriptState.clients.add(redis);
  }
  return redis as RedisWithScripts;
}

/** Compact `<status>|<specVersion>` marker beside the run blob, so validation
 * reads those two fields without transferring the run's input/output. */
function runMetaValue(status: string, specVersion: number | undefined): string {
  return `${status}|${specVersion ?? ""}`;
}

function parseRunMeta(value: string): { status: string; specVersion?: number } {
  const sep = value.indexOf("|");
  if (sep === -1) {
    return { status: value };
  }
  const version = value.slice(sep + 1);
  return {
    status: value.slice(0, sep),
    specVersion: version === "" ? undefined : Number(version),
  };
}

/**
 * Create storage for workflow runs using Redis hashes and sorted sets
 */
export function createRunsStorage(config: RedisStorageConfig): Storage["runs"] {
  const { redis, keyPrefix } = config;

  const {
    runKey,
    runAttributesKey,
    runsIndexKey,
    runsByNameKey,
    runsByStatusKey,
  } = keys(keyPrefix);

  /** The statuses a list filter allows, or undefined for any. `status` takes one
   * status or an array; an empty array matches nothing, unlike omitting it. */
  function allowedStatuses(
    params?: ListWorkflowRunsParams,
  ): string[] | undefined {
    const status = params?.status;
    if (status === undefined) return undefined;
    return Array.isArray(status) ? status : [status];
  }

  // Helper: Select the index (or indexes) to scan, based on filters
  function selectIndexKeys(params?: ListWorkflowRunsParams): string[] {
    if (params?.workflowName) {
      // Use the workflowName index and filter by status in memory
      return [runsByNameKey(params.workflowName)];
    }
    const statuses = allowedStatuses(params);
    if (statuses) {
      // One index per status, merged: never the index of every run there is.
      return statuses.map(runsByStatusKey);
    }
    return [runsIndexKey()];
  }

  // Helper: Fetch and parse runs from pipeline results
  function parseRunsFromPipeline(
    results: any[] | null,
    params?: ListWorkflowRunsParams,
  ): (WorkflowRun | WorkflowRunWithoutData)[] {
    const runs: (WorkflowRun | WorkflowRunWithoutData)[] = [];

    // Each run contributed two replies: its body, then its attributes.
    for (let i = 0; i + 1 < (results?.length ?? 0); i += 2) {
      const result = results![i];
      if (!result?.[1]) {
        continue;
      }

      const run: WorkflowRun = parseWithUint8Array<WorkflowRun>(
        result[1] as string,
      );
      run.attributes =
        (results![i + 1]?.[1] as Record<string, string> | undefined) ?? {};

      // Apply filters
      const statuses = allowedStatuses(params);
      const statusMatches = !statuses || statuses.includes(run.status);
      const nameMatches =
        !params?.workflowName || run.workflowName === params.workflowName;

      if (statusMatches && nameMatches) {
        const resolveData = params?.resolveData ?? "all";
        const parsed = WorkflowRunSchema.parse(compact(run));
        runs.push(filterRunData(parsed, resolveData));
      }
    }

    return runs;
  }

  return {
    get: (async (id: string, params?: GetWorkflowRunParams) => {
      const replies = await redis
        .pipeline()
        .get(runKey(id))
        .hgetall(runAttributesKey(id))
        .exec();
      const data = replies?.[0]?.[1] as string | null | undefined;
      if (!data) {
        throw new WorkflowRunNotFoundError(id);
      }
      const run = parseWithUint8Array<WorkflowRun>(data);
      run.attributes =
        (replies?.[1]?.[1] as Record<string, string> | undefined) ?? {};
      const parsed = WorkflowRunSchema.parse(compact(run));
      const resolveData = params?.resolveData ?? "all";
      return filterRunData(parsed, resolveData);
    }) as Storage["runs"]["get"],

    list: (async (params?: ListWorkflowRunsParams) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      // `status: []` matches nothing, like SQL `IN ()`.
      if (allowedStatuses(params)?.length === 0) {
        return { data: [], hasMore: false, cursor: null };
      }

      const indexKeys = selectIndexKeys(params);
      const order = params?.pagination?.sortOrder ?? "desc";

      // Keep scanning the index until limit+1 matches are collected (needed
      // to compute hasMore) or the index is exhausted. A single fetch is not
      // enough when combined workflowName+status filtering happens in memory
      // after the index scan; it would produce premature empty pages and
      // hasMore=false while matches remain further down the index.
      const runs: {
        run: WorkflowRun | WorkflowRunWithoutData;
        cursor: string;
      }[] = [];
      let scanFrom = fromCursor;
      while (runs.length <= limit) {
        const entries = await pageIndex(
          redis,
          indexKeys,
          scanFrom,
          limit + 1,
          order,
        );
        if (entries.length === 0) {
          break;
        }

        // Fetch this batch of runs via pipeline
        const pipeline = redis.pipeline();
        for (const { id } of entries) {
          pipeline.get(runKey(id));
          pipeline.hgetall(runAttributesKey(id));
        }
        const results = await pipeline.exec();
        const cursorOf = new Map(
          entries.map((entry) => [entry.id, entry.cursor]),
        );
        for (const run of parseRunsFromPipeline(results, params)) {
          runs.push({ run, cursor: cursorOf.get(run.runId)! });
        }

        if (entries.length < limit + 1) {
          break;
        }
        scanFrom = entries.at(-1)!.cursor;
      }

      const values = runs.slice(0, limit);
      const hasMore = runs.length > limit;

      return {
        data: values.map((entry) => entry.run),
        hasMore,
        cursor: values.at(-1)?.cursor ?? null,
      };
    }) as Storage["runs"]["list"],
  };
}

/**
 * Create storage for workflow events using Redis hashes and sorted sets.
 *
 * A run's log is one hash (`eventId -> JSON`). Event ids are log positions, so
 * the log is dense and 1-based, and every script that appends to it picks the
 * next position itself, atomically with the write (see `LUA_APPEND_EVENT`).
 */
export function createEventsStorage(
  config: RedisStorageConfig,
): Storage["events"] {
  const { redis, keyPrefix } = config;
  const scripts = withScripts(redis);
  const ulid = monotonicFactory();
  const maxEventsPerRun = resolveMaxEventsPerRun(config.maxEventsPerRun);

  const {
    eventsKey,
    eventsByCorrelationKey,
    resumeClaimKey,
    runKey,
    runAttributesKey,
    runMetaKey,
    runsIndexKey,
    runsByNameKey,
    runsByStatusKey,
    stepKey,
    stepsIndexKey,
    stepStatusKey,
    hookKey,
    hooksByTokenKey,
    hooksIndexKey,
    hooksTokenMapKey,
  } = keys(keyPrefix);

  /** Events per `HMGET`; keeps a long log from building one huge command. */
  const READ_CHUNK = 500;
  /** The most events an inline delta or skipped-slot report carries; the
   * caller continues from the cursor (or reloads) when `hasMore` is set. */
  const MAX_INLINE_EVENTS = 200;

  /** A run with its current attributes, which live apart from the run body. */
  async function withAttributes<T extends WorkflowRun | WorkflowRunWithoutData>(
    run: T,
  ): Promise<T> {
    const attributes = await redis.hgetall(runAttributesKey(run.runId));
    return { ...run, attributes };
  }

  /** `[key, value, ...]` for a script, from an attribute record. */
  const flattenAttributes = (
    attributes: Record<string, string> | undefined,
  ): string[] => Object.entries(attributes ?? {}).flat();

  /** Serialize an event for a script: `eventId` first, holding the placeholder. */
  function serializeEvent(event: Record<string, unknown>): string {
    const { eventId: _eventId, ...rest } = event;
    return stringifyWithUint8Array({ eventId: EVENT_ID_PLACEHOLDER, ...rest });
  }

  /** Read events by id out of one run's log, skipping any that are absent. */
  async function readEvents(
    runId: string,
    eventIds: string[],
  ): Promise<Event[]> {
    const events: Event[] = [];
    for (let i = 0; i < eventIds.length; i += READ_CHUNK) {
      const values = await redis.hmget(
        eventsKey(runId),
        ...eventIds.slice(i, i + READ_CHUNK),
      );
      for (const value of values) {
        if (value) {
          events.push(
            EventSchema.parse(compact(parseWithUint8Array<Event>(value))),
          );
        }
      }
    }
    return events;
  }

  /** Events at slots `from..to` inclusive, in slot order. */
  async function readSlots(
    runId: string,
    from: number,
    to: number,
  ): Promise<Event[]> {
    const ids: string[] = [];
    for (let slot = Math.max(from, FIRST_EVENT_SLOT); slot <= to; slot++) {
      ids.push(slotToEventId(slot));
    }
    return readEvents(runId, ids);
  }

  type TransitionResult =
    | { kind: "ok"; eventId: string }
    | { kind: "absent" }
    | { kind: "moved"; status: string };

  /**
   * Move a run from `oldStatus` to `newStatus`, release its hooks when it
   * finishes, and append the lifecycle event: one script, so a crash or a racing
   * writer can never leave the status and the log disagreeing. `moved` means the
   * run was no longer in `oldStatus` by the time the script ran, and nothing was
   * written.
   */
  async function transitionRun(
    runId: string,
    oldStatus: string,
    newStatus: string,
    updatedRun: { specVersion?: number },
    at: Date,
    event: Record<string, unknown>,
    releaseHooks: boolean,
  ): Promise<TransitionResult> {
    const result = (await scripts.wfTransitionRun(
      runKey(runId),
      runsByStatusKey(oldStatus),
      runsByStatusKey(newStatus),
      runMetaKey(runId),
      eventsKey(runId),
      hooksIndexKey(runId),
      hooksTokenMapKey(runId),
      stringifyWithUint8Array(updatedRun),
      runId,
      at.getTime().toString(),
      runMetaValue(newStatus, updatedRun.specVersion),
      oldStatus,
      serializeEvent(event),
      releaseHooks ? "1" : "0",
      hookKey(""),
      hooksByTokenKey(""),
    )) as [number, string];
    if (result[0] === 1) return { kind: "ok", eventId: result[1] };
    if (result[0] === -2) return { kind: "moved", status: result[1] };
    return { kind: "absent" };
  }

  /** What an append can come back as besides the stored event. */
  type AppendOutcome =
    | { kind: "stored"; event: Event }
    | { kind: "duplicate" }
    | { kind: "alreadyCompleted" }
    | { kind: "claimed"; claim: string }
    | { kind: "stepTerminal"; status: string }
    | { kind: "stepMoved"; attempt: string }
    | { kind: "runTerminal"; status: string }
    | { kind: "hookGone" };

  /** Append an event whose id the script picks. Returns the stored event. */
  async function appendEvent(
    runId: string,
    event: Record<string, unknown>,
    options: {
      entityKey?: string;
      entityJson?: string;
      /** `creation`: refuse when the correlation id already has an event.
       * `completion`: refuse when it already has two (created, then completed). */
      dedup?: "creation" | "completion";
      resume?: { id: string; claim: string };
      /**
       * The step this write moves. `expectedAttempt` makes the write lose to any
       * other writer that moved the step past the attempt the caller read.
       * `newAttempt` sets the attempt (a start); otherwise it is kept.
       */
      step?: {
        key: string;
        status: string;
        expectedAttempt?: number;
        newAttempt?: number;
      };
      /** Refuse when the run is terminal. */
      runMustBeLive?: boolean;
      /** Refuse when the hook the event is about no longer exists. */
      hookMustExist?: boolean;
    } = {},
  ): Promise<AppendOutcome> {
    const correlationId = event.correlationId as string | undefined;
    const result = (await scripts.wfStoreEvent(
      eventsKey(runId),
      correlationId
        ? eventsByCorrelationKey(runId, correlationId)
        : "__unused__",
      options.entityKey ?? "__unused__",
      options.resume ? resumeClaimKey(runId, options.resume.id) : "__unused__",
      options.step?.key ?? "__unused__",
      options.runMustBeLive ? runMetaKey(runId) : "__unused__",
      options.hookMustExist && correlationId
        ? hookKey(correlationId)
        : "__unused__",
      serializeEvent(event),
      correlationId ? "1" : "0",
      options.dedup === "creation"
        ? "1"
        : options.dedup === "completion"
          ? "2"
          : "0",
      options.entityJson ?? "",
      options.resume?.claim ?? "",
      options.step?.status ?? "",
      options.step?.expectedAttempt === undefined
        ? ""
        : String(options.step.expectedAttempt),
      options.step?.newAttempt === undefined
        ? ""
        : String(options.step.newAttempt),
      options.runMustBeLive ? "1" : "0",
      options.hookMustExist ? "1" : "0",
    )) as [number, string];
    switch (result[0]) {
      case LUA_DUPLICATE_CREATION:
        return { kind: "duplicate" };
      case -7:
        return { kind: "alreadyCompleted" };
      case -3:
        return { kind: "stepTerminal", status: result[1] };
      case -4:
        return { kind: "stepMoved", attempt: result[1] };
      case -5:
        return { kind: "hookGone" };
      case -6:
        return { kind: "runTerminal", status: result[1] };
      case 3:
        return { kind: "claimed", claim: result[1] };
      default:
        return {
          kind: "stored",
          event: EventSchema.parse({ ...event, eventId: result[1] }),
        };
    }
  }

  /** The events a bumped write skipped over: those between the slot the writer
   * asked for (`eventCount + 1`) and the one it landed on. */
  async function reportSkippedSlots(
    result: EventResult,
    askedFor: number,
    resolveData: EventsResolveData,
  ): Promise<EventResult> {
    if (!result.event) return result;
    const committedSlot = eventIdToSlot(result.event.eventId);
    if (
      committedSlot === null ||
      askedFor < 0 ||
      committedSlot <= askedFor + 1
    ) {
      return result;
    }
    const span = committedSlot - askedFor - 1;
    const upto = Math.min(committedSlot - 1, askedFor + MAX_INLINE_EVENTS);
    const skipped = await readSlots(result.event.runId, askedFor + 1, upto);
    return {
      ...result,
      events: skipped.map((event) => stripEventDataRefs(event, resolveData)),
      // The report is a lower bound on what the write skipped, not a page the
      // caller has now read to the end of, so it must not move its read position.
      cursor: null,
      hasMore: skipped.length < span,
    };
  }

  /** The inline delta: everything after `sinceCursor`, as `events.list` would
   * return it right after the write. */
  async function deltaSince(
    result: EventResult,
    sinceCursor: string,
    resolveData: EventsResolveData,
  ): Promise<EventResult> {
    if (!result.event) return result;
    const sinceSlot = eventIdToSlot(sinceCursor);
    if (sinceSlot === null) return result;
    const total = await redis.hlen(eventsKey(result.event.runId));
    const upto = Math.min(total, sinceSlot + MAX_INLINE_EVENTS);
    const page = await readSlots(result.event.runId, sinceSlot + 1, upto);
    return {
      ...result,
      events: page.map((event) => stripEventDataRefs(event, resolveData)),
      cursor: page.at(-1)?.eventId ?? sinceCursor,
      hasMore: upto < total,
    };
  }

  const isTerminal = (status: string) =>
    ["completed", "failed", "cancelled"].includes(status);

  /** How many times a step write recomputes after losing a race for the step. */
  const MAX_STALE_RETRIES = 5;

  async function createEvent(
    runId: string | null,
    data: CreateEventRequest | RunCreatedEventRequest,
    params?: CreateEventParams,
    staleRetries = 0,
  ): Promise<EventResult> {
    const now = new Date();
    const resolveData = params?.resolveData ?? "all";
    // The created event and the entities are never trimmed to the page option.
    const entityData = entityResolveData(resolveData);

    // For run_created events, generate runId server-side if null or empty
    let effectiveRunId: string;
    if (data.eventType === "run_created" && (!runId || runId === "")) {
      effectiveRunId = `wrun_${ulid()}`;
    } else if (!runId) {
      throw new Error("runId is required for non-run_created events");
    } else {
      effectiveRunId = runId;
    }

    const effectiveSpecVersion = data.specVersion ?? mintedSpecVersion();

    // Build the event this call appends; the script fills in `eventId`.
    const buildEvent = (
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      ...data,
      runId: effectiveRunId,
      createdAt: new Date(),
      specVersion: effectiveSpecVersion,
      ...overrides,
    });

    // Track entity created/updated for EventResult
    let run: WorkflowRun | undefined;
    let step: Step | undefined;
    let hook: Hook | undefined;

    // Set when a lifecycle transition already committed its own event.
    let lifecycleEvent: Event | undefined;

    // Written alongside the event append below instead of in its own round
    // trip, which also makes the mutation and its event atomic.
    let pendingEntityKey: string | undefined;
    let pendingEntityJson: string | undefined;
    let pendingStep:
      | {
          key: string;
          status: string;
          expectedAttempt?: number;
          newAttempt?: number;
        }
      | undefined;

    // ============================================================
    // VALIDATION: Terminal state and event ordering checks
    // ============================================================

    let currentRun: { status: string; specVersion?: number } | null = null;
    // Read at most once per call; every mutation branch below reuses it
    // rather than re-fetching and re-parsing the whole payload.
    let existingRun: WorkflowRun | null = null;

    async function loadRunBody(): Promise<void> {
      const runData = await redis.get(runKey(effectiveRunId));
      if (runData) {
        existingRun = parseWithUint8Array<WorkflowRun>(runData);
        currentRun = {
          status: existingRun.status,
          specVersion: existingRun.specVersion,
        };
      }
    }

    const skipRunValidationEvents = ["step_completed", "step_retrying"];
    if (
      data.eventType !== "run_created" &&
      !skipRunValidationEvents.includes(data.eventType)
    ) {
      if (RUN_LIFECYCLE_EVENT_TYPES.has(data.eventType)) {
        // These mutate the run, so its body is needed either way.
        await loadRunBody();
      } else {
        // Only status/specVersion are consulted, and the meta key holds
        // both in ~20 bytes. No meta means no such run.
        const meta = await redis.get(runMetaKey(effectiveRunId));
        if (meta) {
          currentRun = parseRunMeta(meta);
        }
      }
    }

    // ============================================================
    // RESILIENT START: Bootstrap run from run_started eventData
    // ============================================================
    if (
      data.eventType === "run_started" &&
      !currentRun &&
      "eventData" in data &&
      data.eventData
    ) {
      const runInputData = (data as any).eventData as {
        deploymentId?: string;
        workflowName?: string;
        input?: any;
        executionContext?: any;
        attributes?: Record<string, string>;
        allowReservedAttributes?: true;
        encryptionPublicKey?: string;
        dynamicWorkflowCode?: any;
      };
      if (
        runInputData.deploymentId &&
        runInputData.workflowName &&
        runInputData.input !== undefined
      ) {
        const seeds = runInputData.attributes ?? {};
        validateAttributeChanges(
          Object.entries(seeds).map(([key, value]) => ({ key, value })),
          {
            allowReservedAttributes:
              runInputData.allowReservedAttributes === true,
          },
        );
        const newRun = {
          runId: effectiveRunId,
          deploymentId: runInputData.deploymentId,
          workflowName: runInputData.workflowName,
          specVersion: effectiveSpecVersion,
          input: runInputData.input,
          executionContext: runInputData.executionContext,
          ...(runInputData.encryptionPublicKey && {
            encryptionPublicKey: runInputData.encryptionPublicKey,
          }),
          ...(runInputData.dynamicWorkflowCode !== undefined && {
            dynamicWorkflowCode: runInputData.dynamicWorkflowCode,
          }),
          status: "pending" as const,
          output: undefined,
          error: undefined,
          completedAt: undefined,
          startedAt: undefined,
          createdAt: now,
          updatedAt: now,
        };
        // Fused script: run entity + synthetic run_created event in one
        // atomic execution, so a crash cannot leave one without the other
        // and concurrent bootstraps cannot double-append the event.
        const result = (await scripts.wfCreateRunWithEvent(
          runKey(effectiveRunId),
          runsIndexKey(),
          runsByNameKey(runInputData.workflowName),
          runsByStatusKey("pending"),
          runMetaKey(effectiveRunId),
          eventsKey(effectiveRunId),
          runAttributesKey(effectiveRunId),
          stringifyWithUint8Array(newRun),
          effectiveRunId,
          now.getTime().toString(),
          runMetaValue("pending", effectiveSpecVersion),
          serializeEvent({
            eventType: "run_created",
            eventData: {
              deploymentId: runInputData.deploymentId,
              workflowName: runInputData.workflowName,
              input: runInputData.input,
              executionContext: runInputData.executionContext,
              ...(runInputData.attributes && {
                attributes: runInputData.attributes,
              }),
              ...(runInputData.allowReservedAttributes && {
                allowReservedAttributes: true,
              }),
              ...(runInputData.encryptionPublicKey && {
                encryptionPublicKey: runInputData.encryptionPublicKey,
              }),
            },
            runId: effectiveRunId,
            createdAt: now,
            specVersion: effectiveSpecVersion,
          }),
          ...flattenAttributes(seeds),
        )) as [number, string];
        if (result[0] === 1) {
          currentRun = { status: "pending", specVersion: effectiveSpecVersion };
          existingRun = newRun as WorkflowRun;
        } else {
          // Run already exists (the resilient re-start path, which must
          // tolerate losing the race): read the state the other writer left.
          const parsed = parseWithUint8Array<WorkflowRun>(result[1]);
          currentRun = {
            status: parsed.status,
            specVersion: parsed.specVersion,
          };
          existingRun = parsed;
        }
      }
    }

    // ============================================================
    // VERSION COMPATIBILITY: Check run spec version
    // ============================================================
    if (currentRun) {
      if (requiresNewerWorld(currentRun.specVersion)) {
        throw new RunNotSupportedError(
          currentRun.specVersion!,
          mintedSpecVersion(),
        );
      }
      if (isLegacySpecVersion(currentRun.specVersion)) {
        // Event ids are log positions; a run from before the event-sourced spec
        // has none.
        throw new RunNotSupportedError(
          currentRun.specVersion!,
          mintedSpecVersion(),
        );
      }
    }

    // Run terminal state validation
    if (currentRun && isTerminal((currentRun as { status: string }).status)) {
      const terminalStatus = (currentRun as { status: string }).status;
      const runTerminalEvents = ["run_started", "run_completed", "run_failed"];

      // Idempotent operation: run_cancelled on already cancelled run is allowed
      if (
        data.eventType === "run_cancelled" &&
        terminalStatus === "cancelled"
      ) {
        const stored = await appendEvent(effectiveRunId, buildEvent());
        if (stored.kind !== "stored") {
          throw new EntityConflictError("Duplicate run_cancelled");
        }
        return {
          event: stripEventDataRefs(stored.event, entityData),
          // Lifecycle event: validation already loaded the body.
          run: existingRun
            ? await withAttributes(
                WorkflowRunSchema.parse(compact(existingRun)),
              )
            : undefined,
        };
      }

      // For run_started on terminal runs, use RunExpiredError so the
      // runtime knows to exit without retrying.
      if (data.eventType === "run_started") {
        throw new RunExpiredError(
          `Workflow run "${effectiveRunId}" is already in terminal state "${terminalStatus}"`,
        );
      }

      // No work begins on a finished run. A step_started is rejected even when
      // the step still reads `running`: that is a redelivery of a start an
      // earlier delivery already claimed, and accepting it would execute a
      // body whose outcome nothing will read. step_completed and step_failed
      // stay accepted so a step already in flight can record its outcome.
      if (data.eventType === "step_started") {
        throw new RunExpiredError(
          `Cannot start step on run in terminal state "${terminalStatus}"`,
        );
      }

      // Other run state transitions are not allowed on terminal runs
      if (
        runTerminalEvents.includes(data.eventType) ||
        data.eventType === "run_cancelled"
      ) {
        throw new EntityConflictError(
          `Cannot transition run from terminal state "${terminalStatus}"`,
        );
      }

      // Creating new entities on terminal runs is not allowed
      if (
        data.eventType === "step_created" ||
        data.eventType === "hook_created" ||
        data.eventType === "wait_created"
      ) {
        throw new EntityConflictError(
          `Cannot create new entities on run in terminal state "${terminalStatus}"`,
        );
      }
    }

    // Step-related event validation
    // Held whole so `step_started`/`step_retrying` can mutate it below
    // without re-fetching and re-parsing the step (including its input).
    let validatedStep: Step | null = null;
    // A step_started that carries the step's name and input also creates it.
    const lazyStepStart =
      data.eventType === "step_started" &&
      typeof (data as any).eventData?.stepName === "string" &&
      (data as any).eventData?.input !== undefined;
    const stepEventsNeedingValidation = ["step_started", "step_retrying"];
    if (
      stepEventsNeedingValidation.includes(data.eventType) &&
      data.correlationId
    ) {
      const stepData = await redis.get(
        stepKey(effectiveRunId, data.correlationId),
      );
      if (stepData) {
        validatedStep = parseWithUint8Array<Step>(stepData);
      }

      if (!validatedStep && !lazyStepStart) {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, {
          status: 404,
        });
      }

      // The lazy start exactly-once gate: a lazy step_started always CREATES the
      // step, so an existing one means a concurrent handler won the claim.
      // EntityConflictError makes the runtime skip it; without this a loser
      // would re-start a running step and run the body a second time.
      if (lazyStepStart && validatedStep) {
        throw new EntityConflictError(
          `Step "${data.correlationId}" already created`,
        );
      }

      if (validatedStep) {
        // EntityConflictError so core's step handler skips the duplicate
        // delivery and re-enqueues the workflow (crash-recovery nudge).
        if (isTerminal(validatedStep.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${validatedStep.status}"`,
          );
        }

        if (
          currentRun &&
          isTerminal((currentRun as { status: string }).status)
        ) {
          if (validatedStep.status !== "running") {
            throw new RunExpiredError(
              `Cannot modify non-running step on run in terminal state "${(currentRun as { status: string }).status}"`,
            );
          }
        }
      }
    }

    // Hook validation; the body is kept so `hook_disposed` below need not
    // re-read it just to recover the token.
    let validatedHook: Hook | null = null;
    // A hook_received that carries a resume id may be a retry of one already
    // recorded: the script checks the claim first, then the hook, so the retry
    // gets its event back rather than "not found".
    const hookEventsRequiringExistence = ["hook_disposed", "hook_received"];
    const isResumeRetryCandidate =
      data.eventType === "hook_received" && params?.resumeId;
    if (
      hookEventsRequiringExistence.includes(data.eventType) &&
      data.correlationId &&
      !isResumeRetryCandidate
    ) {
      const existingHook = await redis.get(hookKey(data.correlationId));
      if (!existingHook) {
        throw new HookNotFoundError(data.correlationId);
      }
      validatedHook = parseWithUint8Array<Hook>(existingHook);
    }

    // ============================================================
    // Entity creation/updates based on event type
    // ============================================================

    // Handle run_created event: create the run entity atomically
    if (data.eventType === "run_created") {
      const eventData = (data as any).eventData as {
        deploymentId: string;
        workflowName: string;
        input: any[];
        executionContext?: Record<string, any>;
        attributes?: Record<string, string>;
        allowReservedAttributes?: true;
        encryptionPublicKey?: string;
        dynamicWorkflowCode?: any;
        dynamicWorkflowCodeRef?: string;
      };

      if (eventData.dynamicWorkflowCodeRef !== undefined) {
        throw new WorkflowWorldError(
          "dynamicWorkflowCodeRef is not supported by this world",
          {
            status: 501,
          },
        );
      }
      const seeds = eventData.attributes ?? {};
      validateAttributeChanges(
        Object.entries(seeds).map(([key, value]) => ({ key, value })),
        { allowReservedAttributes: eventData.allowReservedAttributes === true },
      );

      const newRun = {
        runId: effectiveRunId,
        deploymentId: eventData.deploymentId,
        workflowName: eventData.workflowName,
        specVersion: effectiveSpecVersion,
        input: eventData.input,
        executionContext: eventData.executionContext,
        ...(eventData.encryptionPublicKey && {
          encryptionPublicKey: eventData.encryptionPublicKey,
        }),
        ...(eventData.dynamicWorkflowCode !== undefined && {
          dynamicWorkflowCode: eventData.dynamicWorkflowCode,
        }),
        status: "pending" as const,
        output: undefined,
        error: undefined,
        completedAt: undefined,
        startedAt: undefined,
        createdAt: now,
        updatedAt: now,
      };

      // Fused script: run entity + run_created event in one atomic
      // execution. A duplicate rejects with EntityConflictError (which the
      // runtime treats as benign) instead of returning the existing run
      // AND appending a second creation event that would poison replay.
      const event = buildEvent({ createdAt: now });
      const result = (await scripts.wfCreateRunWithEvent(
        runKey(effectiveRunId),
        runsIndexKey(),
        runsByNameKey(eventData.workflowName),
        runsByStatusKey("pending"),
        runMetaKey(effectiveRunId),
        eventsKey(effectiveRunId),
        runAttributesKey(effectiveRunId),
        stringifyWithUint8Array(newRun),
        effectiveRunId,
        now.getTime().toString(),
        runMetaValue("pending", effectiveSpecVersion),
        serializeEvent(event),
        ...flattenAttributes(seeds),
      )) as [number, string];

      if (result[0] === 0) {
        throw new EntityConflictError(
          `Workflow run "${effectiveRunId}" already exists`,
        );
      }

      run = WorkflowRunSchema.parse({ ...compact(newRun), attributes: seeds });
      const parsed = EventSchema.parse({ ...event, eventId: result[1] });
      return {
        event: stripEventDataRefs(parsed, entityData),
        run,
        maxEvents: maxEventsPerRun,
      };
    }

    // Handle run_started event: update run status atomically via Lua
    if (data.eventType === "run_started") {
      // Core reads the per-run event ceiling only from the run_started response, so
      // omitting it here would drop the limit on every replay after the first.
      const resumeResponse = async (
        current: WorkflowRun | null,
      ): Promise<EventResult> => {
        const resumed = current
          ? await withAttributes(WorkflowRunSchema.parse(compact(current)))
          : undefined;
        return {
          run: resumed
            ? (filterRunData(resumed, entityData) as WorkflowRun)
            : undefined,
          ...(resumed ? { maxEvents: maxEventsPerRun } : {}),
        };
      };

      if ((currentRun as { status: string } | null)?.status === "running") {
        // Resume path, hit on every re-invocation of a running workflow.
        return resumeResponse(existingRun);
      }

      if (!existingRun) {
        // No run and no resilient-start bootstrap data; logging a
        // run_started event against a nonexistent run would corrupt the
        // event log, so fail loudly instead.
        throw new WorkflowRunNotFoundError(effectiveRunId);
      }
      const existing = existingRun as WorkflowRun;
      const updatedRun = {
        ...existing,
        status: "running" as const,
        startedAt: now,
        updatedAt: now,
      };

      // The event carries no data: the run's input was the creation event's.
      const { eventData: _startData, ...startEvent } = buildEvent({
        createdAt: now,
      });
      const moved = await transitionRun(
        effectiveRunId,
        existing.status,
        "running",
        updatedRun,
        now,
        startEvent,
        false,
      );
      if (moved.kind === "absent") {
        throw new WorkflowRunNotFoundError(effectiveRunId);
      }
      if (moved.kind === "moved") {
        // Another invocation got there first. If it started the run, this one is
        // a resume and must not append a second run_started; if the run ended in
        // the meantime, there is nothing left to start.
        if (isTerminal(moved.status)) {
          throw new RunExpiredError(
            `Workflow run "${effectiveRunId}" is already in terminal state "${moved.status}"`,
          );
        }
        await loadRunBody();
        return resumeResponse(existingRun);
      }

      run = WorkflowRunSchema.parse(compact(updatedRun));
      lifecycleEvent = EventSchema.parse({
        ...startEvent,
        eventId: moved.eventId,
      });
    }

    // Handle run_completed / run_failed / run_cancelled: update the run status
    // atomically, then clean up the run's hooks.
    if (
      data.eventType === "run_completed" ||
      data.eventType === "run_failed" ||
      data.eventType === "run_cancelled"
    ) {
      if (!existingRun) {
        throw new WorkflowRunNotFoundError(effectiveRunId);
      }
      const existing = existingRun as WorkflowRun;
      let updatedRun: WorkflowRun;
      let newStatus: "completed" | "failed" | "cancelled";

      if (data.eventType === "run_completed") {
        const eventData = (data as any).eventData as { output?: any };
        newStatus = "completed";
        updatedRun = {
          ...existing,
          status: "completed",
          output: eventData.output,
          completedAt: now,
          updatedAt: now,
        } as WorkflowRun;
      } else if (data.eventType === "run_failed") {
        const eventData = (data as any).eventData as {
          error: any;
          errorCode?: string;
        };
        newStatus = "failed";
        updatedRun = {
          ...existing,
          status: "failed",
          // Kept as the serialized thrown value; consumers hydrate it.
          error: eventData.error,
          errorCode: eventData.errorCode,
          completedAt: now,
          updatedAt: now,
        } as WorkflowRun;
      } else {
        newStatus = "cancelled";
        updatedRun = {
          ...existing,
          status: "cancelled",
          completedAt: now,
          updatedAt: now,
        } as WorkflowRun;
      }

      // Status, hook release and event commit together (see `transitionRun`).
      const terminalEvent = buildEvent({ createdAt: now });
      const moved = await transitionRun(
        effectiveRunId,
        existing.status,
        newStatus,
        updatedRun,
        now,
        terminalEvent,
        true,
      );
      if (moved.kind === "absent") {
        throw new WorkflowRunNotFoundError(effectiveRunId);
      }
      if (moved.kind === "moved") {
        throw new EntityConflictError(
          `Cannot transition run "${effectiveRunId}" to "${newStatus}": it already left "${existing.status}" for "${moved.status}"`,
        );
      }

      run = WorkflowRunSchema.parse(compact(updatedRun));
      lifecycleEvent = EventSchema.parse({
        ...terminalEvent,
        eventId: moved.eventId,
      });
    }

    // Handle step_created event: create step entity
    if (data.eventType === "step_created") {
      const eventData = (data as any).eventData as {
        stepName: string;
        input: any;
      };

      const newStep = {
        runId: effectiveRunId,
        stepId: data.correlationId!,
        stepName: eventData.stepName,
        input: eventData.input,
        status: "pending" as const,
        attempt: 0,
        specVersion: effectiveSpecVersion,
        createdAt: now,
        updatedAt: now,
      };

      // Fused script: step entity + step_created event in one atomic
      // execution, closing the check-then-write race between concurrent
      // redeliveries. An existing entity means the creation event is
      // already in the log (they are written together), so a duplicate
      // rejects with EntityConflictError, the runtime's dedup signal;
      // returning success would append a second step_created row and
      // poison replay with ReplayDivergenceError.
      const event = buildEvent({ createdAt: now });
      const result = (await scripts.wfCreateStepWithEvent(
        stepKey(effectiveRunId, data.correlationId!),
        stepsIndexKey(effectiveRunId),
        eventsKey(effectiveRunId),
        eventsByCorrelationKey(effectiveRunId, data.correlationId!),
        stepStatusKey(effectiveRunId, data.correlationId!),
        runMetaKey(effectiveRunId),
        stringifyWithUint8Array(newStep),
        data.correlationId!,
        now.getTime().toString(),
        serializeEvent(event),
        "pending|0",
      )) as [number, string];

      if (result[0] === -6) {
        throw new EntityConflictError(
          `Cannot create new entities on run in terminal state "${result[1]}"`,
        );
      }
      if (result[0] === 0) {
        throw new EntityConflictError(
          `Step "${data.correlationId}" already exists`,
        );
      }

      step = StepSchema.parse(compact(newStep));
      const parsed = EventSchema.parse({ ...event, eventId: result[1] });
      return { event: stripEventDataRefs(parsed, entityData), step };
    }

    // wait_created has no entity in this world; the event log is the only
    // dedup surface. Throw on a duplicate so the contract matches the
    // runtime's dedup catch path.
    //
    // Checked inside the event-store script: a wait's correlation index only
    // holds wait_created and the wait_completed that follows it, so a
    // non-empty index means "already recorded". O(1) and atomic with the
    // write, vs scanning every event on every wait.
    const dedup: "creation" | "completion" | undefined =
      data.eventType === "wait_created"
        ? "creation"
        : data.eventType === "wait_completed"
          ? "completion"
          : undefined;

    // Handle step_started event: increment attempt, set status to 'running'
    if (data.eventType === "step_started") {
      // Retried steps may be scheduled for later. TooEarlyError tells core
      // to re-deliver after the remaining backoff instead of starting the
      // step before its retryAfter timestamp.
      if (
        validatedStep?.retryAfter &&
        validatedStep.retryAfter.getTime() > Date.now()
      ) {
        throw new TooEarlyError(
          `Cannot start step "${data.correlationId}": retryAfter timestamp has not been reached yet`,
          {
            retryAfter: Math.ceil(
              (validatedStep.retryAfter.getTime() - Date.now()) / 1000,
            ),
          },
        );
      }

      if (lazyStepStart) {
        // Lazy start: create the step (already running), a synthetic
        // step_created so replay still observes the creation, and the
        // step_started, in one script. The SETNX is the exactly-once claim.
        const lazyData = (data as any).eventData as {
          stepName: string;
          input: any;
          [key: string]: unknown;
        };
        const startedStep = {
          runId: effectiveRunId,
          stepId: data.correlationId!,
          stepName: lazyData.stepName,
          input: lazyData.input,
          status: "running" as const,
          attempt: 1,
          startedAt: now,
          specVersion: effectiveSpecVersion,
          createdAt: now,
          updatedAt: now,
        };
        // The input belongs on the synthetic step_created; the step_started row
        // keeps the rest (stepName is read by the replay's name-divergence check).
        const { input: _input, ...startedEventData } = lazyData;
        const createdEvent = {
          eventType: "step_created" as const,
          correlationId: data.correlationId,
          runId: effectiveRunId,
          createdAt: now,
          specVersion: effectiveSpecVersion,
          eventData: {
            stepName: lazyData.stepName,
            ...(lazyData.workflowName !== undefined && {
              workflowName: lazyData.workflowName,
            }),
            input: lazyData.input,
          },
        };
        const startedEvent = buildEvent({
          createdAt: now,
          eventData: startedEventData,
        });
        const result = (await scripts.wfCreateStepStarted(
          stepKey(effectiveRunId, data.correlationId!),
          stepsIndexKey(effectiveRunId),
          eventsKey(effectiveRunId),
          eventsByCorrelationKey(effectiveRunId, data.correlationId!),
          stepStatusKey(effectiveRunId, data.correlationId!),
          runMetaKey(effectiveRunId),
          stringifyWithUint8Array(startedStep),
          data.correlationId!,
          now.getTime().toString(),
          serializeEvent(createdEvent),
          serializeEvent(startedEvent),
          "running|1",
        )) as [number, string, string];
        if (result[0] === -6) {
          throw new RunExpiredError(
            `Cannot start step on run in terminal state "${result[1]}"`,
          );
        }
        if (result[0] === 0) {
          throw new EntityConflictError(
            `Step "${data.correlationId}" already created`,
          );
        }
        step = StepSchema.parse(compact(startedStep));
        const parsed = EventSchema.parse({
          ...startedEvent,
          eventId: result[2],
        });
        return {
          event: stripEventDataRefs(parsed, entityData),
          step,
          stepCreated: true,
        };
      }

      const isFirstStart = !validatedStep?.startedAt;
      // Reuses the step loaded during validation above.
      const existing = validatedStep;
      if (existing) {
        const updatedStep = {
          ...existing,
          status: "running" as const,
          attempt: existing.attempt + 1,
          ...(isFirstStart ? { startedAt: now } : {}),
          // The step has left the backoff window; always clear retryAfter.
          retryAfter: undefined,
          updatedAt: now,
        };
        pendingEntityKey = stepKey(effectiveRunId, data.correlationId!);
        pendingEntityJson = stringifyWithUint8Array(updatedStep);
        pendingStep = {
          key: stepStatusKey(effectiveRunId, data.correlationId!),
          status: "running",
          // Two starts that both read this attempt cannot both win.
          expectedAttempt: existing.attempt,
          newAttempt: updatedStep.attempt,
        };
        step = StepSchema.parse(compact(updatedStep));
      }
    }

    // Handle step_completed event: update step status
    if (data.eventType === "step_completed") {
      const eventData = (data as any).eventData as { result?: any };
      const existingData = await redis.get(
        stepKey(effectiveRunId, data.correlationId!),
      );
      if (existingData) {
        const existing = parseWithUint8Array<Step>(existingData);
        if (isTerminal(existing.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${existing.status}"`,
          );
        }
        const updatedStep = {
          ...existing,
          status: "completed" as const,
          output: eventData.result,
          completedAt: now,
          updatedAt: now,
        };
        pendingEntityKey = stepKey(effectiveRunId, data.correlationId!);
        pendingEntityJson = stringifyWithUint8Array(updatedStep);
        pendingStep = {
          key: stepStatusKey(effectiveRunId, data.correlationId!),
          status: "completed",
          // Lost the race for the step: the caller recomputes from a fresh read.
          expectedAttempt: existing.attempt,
        };
        step = StepSchema.parse(compact(updatedStep));
      } else {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, {
          status: 404,
        });
      }
    }

    // Handle step_failed event: terminal state with error
    if (data.eventType === "step_failed") {
      const eventData = (data as any).eventData as { error?: any };

      const existingData = await redis.get(
        stepKey(effectiveRunId, data.correlationId!),
      );
      if (existingData) {
        const existing = parseWithUint8Array<Step>(existingData);
        if (isTerminal(existing.status)) {
          throw new EntityConflictError(
            `Cannot modify step in terminal state "${existing.status}"`,
          );
        }
        const updatedStep = {
          ...existing,
          status: "failed" as const,
          // Kept as the serialized thrown value; consumers hydrate it.
          error: eventData.error,
          completedAt: now,
          updatedAt: now,
        };
        pendingEntityKey = stepKey(effectiveRunId, data.correlationId!);
        pendingEntityJson = stringifyWithUint8Array(updatedStep);
        pendingStep = {
          key: stepStatusKey(effectiveRunId, data.correlationId!),
          status: "failed",
          // Lost the race for the step: the caller recomputes from a fresh read.
          expectedAttempt: existing.attempt,
        };
        step = StepSchema.parse(compact(updatedStep));
      } else {
        throw new WorkflowWorldError(`Step "${data.correlationId}" not found`, {
          status: 404,
        });
      }
    }

    // Handle step_retrying event: sets status back to 'pending', records error
    if (data.eventType === "step_retrying") {
      const eventData = (data as any).eventData as {
        error?: any;
        retryAfter?: Date;
      };

      // Reuses the step loaded during validation above.
      const existing = validatedStep;
      if (existing) {
        const updatedStep = {
          ...existing,
          status: "pending" as const,
          error: eventData.error,
          retryAfter: eventData.retryAfter,
          updatedAt: now,
        };
        pendingEntityKey = stepKey(effectiveRunId, data.correlationId!);
        pendingEntityJson = stringifyWithUint8Array(updatedStep);
        pendingStep = {
          key: stepStatusKey(effectiveRunId, data.correlationId!),
          status: "pending",
          // Lost the race for the step: the caller recomputes from a fresh read.
          expectedAttempt: existing.attempt,
        };
        step = StepSchema.parse(compact(updatedStep));
      }
    }

    // Handle hook_created event: create hook entity atomically via Lua
    if (data.eventType === "hook_created") {
      const eventData = (data as any).eventData as {
        token: string;
        metadata?: any;
        isWebhook?: boolean;
        isSystem?: boolean;
      };

      const newHook: Hook = {
        runId: effectiveRunId,
        hookId: data.correlationId!,
        token: eventData.token,
        ownerId: "",
        projectId: "",
        environment: "",
        metadata: eventData.metadata,
        specVersion: effectiveSpecVersion,
        createdAt: now,
        ...(eventData.isWebhook !== undefined && {
          isWebhook: eventData.isWebhook,
        }),
        ...(eventData.isSystem !== undefined && {
          isSystem: eventData.isSystem,
        }),
      };
      const event = buildEvent({ createdAt: now });

      // Fused script: token claim + hook entity + hook_created event in
      // one atomic execution. The SETNX on the by-token key arbitrates
      // ownership, closing the check-then-write race between concurrent
      // deliveries. A token whose owner is gone (a crash during cleanup left it
      // behind) is taken over inside the script, and a hook is never created on
      // a finished run, which would hold its token forever.
      const result = (await scripts.wfCreateHookWithEvent(
        hookKey(data.correlationId!),
        hooksByTokenKey(eventData.token),
        hooksIndexKey(effectiveRunId),
        hooksTokenMapKey(effectiveRunId),
        eventsKey(effectiveRunId),
        eventsByCorrelationKey(effectiveRunId, data.correlationId!),
        runMetaKey(effectiveRunId),
        stringifyWithUint8Array(newHook),
        data.correlationId!,
        now.getTime().toString(),
        eventData.token,
        serializeEvent(event),
        hookKey(""),
      )) as [number, string];

      if (result[0] === -6) {
        throw new EntityConflictError(
          `Cannot create new entities on run in terminal state "${result[1]}"`,
        );
      }

      if (result[0] === 2) {
        // A different (runId, hookId) holds this token. Create a
        // hook_conflict event instead of throwing 409; this lets the
        // workflow continue and fail gracefully when the hook is awaited.
        // The rightful owner's token mapping is left untouched.
        const owningHookId = result[1];
        let conflictingRunId: string | undefined;
        const owningHookData = await redis.get(hookKey(owningHookId));
        if (owningHookData) {
          conflictingRunId = parseWithUint8Array<Hook>(owningHookData).runId;
        }

        // Recorded once: a redelivered hook_created must not journal a second
        // conflict, which replay would read as a second event for one hook.
        const stored = await appendEvent(
          effectiveRunId,
          {
            eventType: "hook_conflict" as const,
            correlationId: data.correlationId,
            eventData: {
              token: eventData.token,
              ...(conflictingRunId ? { conflictingRunId } : {}),
            },
            runId: effectiveRunId,
            createdAt: now,
            specVersion: effectiveSpecVersion,
          },
          { dedup: "creation", runMustBeLive: true },
        );
        if (stored.kind === "runTerminal") {
          throw new EntityConflictError(
            `Cannot create new entities on run in terminal state "${stored.status}"`,
          );
        }
        if (stored.kind !== "stored") {
          throw new EntityConflictError(
            `Hook "${data.correlationId}" conflict already recorded`,
          );
        }
        return {
          event: stripEventDataRefs(stored.event, entityData),
          run,
          step,
          hook: undefined,
        };
      }

      if (result[0] === 0) {
        // Same (runId, hookId, token) already fully created: entity and
        // event are written atomically, so the event is guaranteed to be
        // in the log. EntityConflictError is the runtime's dedup signal
        // (a self hook_conflict would later replay as HookConflictError).
        throw new EntityConflictError(
          `Hook "${data.correlationId}" already created`,
        );
      }

      hook = HookSchema.parse(compact(newHook));
      const parsed = EventSchema.parse({ ...event, eventId: result[1] });
      return { event: stripEventDataRefs(parsed, entityData), hook };
    }

    // Handle hook_disposed: delete the hook and append the event in one script, so
    // a racing hook_received cannot land behind the disposal and a crash cannot
    // lose the event.
    if (data.eventType === "hook_disposed" && data.correlationId) {
      if (!validatedHook) {
        throw new EntityConflictError(
          `Hook "${data.correlationId}" already disposed`,
        );
      }
      const event = buildEvent();
      const result = (await scripts.wfDisposeHook(
        hookKey(data.correlationId),
        hooksByTokenKey(validatedHook.token),
        hooksIndexKey(effectiveRunId),
        hooksTokenMapKey(effectiveRunId),
        eventsKey(effectiveRunId),
        eventsByCorrelationKey(effectiveRunId, data.correlationId),
        data.correlationId,
        serializeEvent(event),
      )) as [number, string];
      if (result[0] === 0) {
        throw new EntityConflictError(
          `Hook "${data.correlationId}" already disposed`,
        );
      }
      const parsed = EventSchema.parse({ ...event, eventId: result[1] });
      return { event: stripEventDataRefs(parsed, entityData) };
    }

    // Handle attr_set: merge the changes into the run's attributes and append the
    // event in one script.
    if (data.eventType === "attr_set") {
      if (!currentRun) {
        throw new WorkflowRunNotFoundError(effectiveRunId);
      }
      const eventData = (data as any).eventData as {
        changes: AttributeChange[];
        allowReservedAttributes?: true;
      };
      validateAttributeChanges(eventData.changes, {
        existingKeys: await redis.hkeys(runAttributesKey(effectiveRunId)),
        allowReservedAttributes: eventData.allowReservedAttributes === true,
      });
      const event = buildEvent();
      const correlationId = data.correlationId;
      const result = (await scripts.wfSetAttributes(
        runAttributesKey(effectiveRunId),
        eventsKey(effectiveRunId),
        correlationId
          ? eventsByCorrelationKey(effectiveRunId, correlationId)
          : "__unused__",
        runMetaKey(effectiveRunId),
        serializeEvent(event),
        correlationId ? "1" : "0",
        // A workflow replays its writes, so one correlation id sets attributes once.
        (data as { eventData?: { writer?: { type?: string } } }).eventData
          ?.writer?.type === "workflow"
          ? "1"
          : "0",
        ...eventData.changes.flatMap((change) => [
          change.key,
          change.value ?? "",
          change.value === null ? "del" : "set",
        ]),
      )) as [number, string];
      if (result[0] === -6) {
        throw new EntityConflictError(
          `Cannot set attributes on run in terminal state "${result[1]}"`,
        );
      }
      if (result[0] === LUA_DUPLICATE_CREATION) {
        throw new EntityConflictError(
          `attr_set for correlationId "${correlationId}" already exists in run "${effectiveRunId}"`,
        );
      }
      await loadRunBody();
      return {
        event: stripEventDataRefs(
          EventSchema.parse({ ...event, eventId: result[1] }),
          entityData,
        ),
        run: existingRun
          ? await withAttributes(WorkflowRunSchema.parse(compact(existingRun)))
          : undefined,
      };
    }

    // A lazy hook resume is deduplicated per (run, resumeId): the queue consumer
    // re-ensures the same hook_received the producer may already have written.
    const resume =
      data.eventType === "hook_received" && params?.resumeId
        ? {
            id: params.resumeId,
            claim: `${params.resumePayloadDigest ?? ""}|${data.correlationId}`,
          }
        : undefined;

    // A lifecycle transition committed its own event with the status change.
    // Everything else is appended here, and guards the run and hook it is about
    // inside the script that appends: a check made before the call is stale by the
    // time the event lands.
    const stored: AppendOutcome = lifecycleEvent
      ? { kind: "stored", event: lifecycleEvent }
      : await appendEvent(effectiveRunId, buildEvent(), {
          entityKey: pendingEntityKey,
          entityJson: pendingEntityJson,
          dedup,
          resume,
          step: pendingStep,
          runMustBeLive:
            data.eventType === "hook_received" ||
            data.eventType === "wait_created" ||
            data.eventType === "step_started",
          hookMustExist: data.eventType === "hook_received",
        });
    if (stored.kind === "duplicate") {
      throw new EntityConflictError(`"${data.correlationId}" already exists`);
    }
    if (stored.kind === "alreadyCompleted") {
      throw new EntityConflictError(
        `Wait "${data.correlationId}" already completed`,
      );
    }
    if (stored.kind === "stepTerminal") {
      // EntityConflictError so core's step handler skips the duplicate delivery.
      throw new EntityConflictError(
        `Cannot modify step in terminal state "${stored.status}"`,
      );
    }
    if (stored.kind === "stepMoved") {
      // A start that lost to another start is the claim working. Any other write
      // was computed from a stale copy of the step: redo it from a fresh read.
      if (
        data.eventType !== "step_started" &&
        staleRetries < MAX_STALE_RETRIES
      ) {
        return createEvent(runId, data, params, staleRetries + 1);
      }
      throw new EntityConflictError(
        `Step "${data.correlationId}" was moved by another delivery (attempt ${stored.attempt})`,
      );
    }
    if (stored.kind === "runTerminal") {
      if (data.eventType === "step_started") {
        throw new RunExpiredError(
          `Cannot start step on run in terminal state "${stored.status}"`,
        );
      }
      throw new EntityConflictError(
        `Cannot add ${data.eventType} to run in terminal state "${stored.status}"`,
      );
    }
    if (stored.kind === "hookGone") {
      throw new HookNotFoundError(data.correlationId!);
    }
    if (stored.kind === "claimed") {
      // Another writer already recorded this resume; converge on its event.
      const [claimedEventId, claimedDigest, claimedHookId] =
        stored.claim.split("|");
      if (claimedHookId !== data.correlationId) {
        throw new EntityConflictError(
          `hook_received resumeId "${params!.resumeId}" already recorded for a different hook`,
        );
      }
      if (
        params?.resumePayloadDigest &&
        claimedDigest &&
        claimedDigest !== params.resumePayloadDigest
      ) {
        throw new EntityConflictError(
          `hook_received resumeId "${params!.resumeId}" already recorded with a different payload`,
        );
      }
      const [existingEvent] = await readEvents(effectiveRunId, [
        claimedEventId,
      ]);
      if (!existingEvent) {
        throw new WorkflowWorldError(`Event not found: ${claimedEventId}`, {
          status: 404,
        });
      }
      return { event: stripEventDataRefs(existingEvent, entityData) };
    }

    // Preload the run's log on run_started to save the caller a list.
    let preloaded:
      | { events: Event[]; cursor: string | null; hasMore: boolean }
      | undefined;
    if (
      data.eventType === "run_started" &&
      run &&
      params?.skipPreload !== true
    ) {
      const total = await redis.hlen(eventsKey(effectiveRunId));
      const all = await readSlots(effectiveRunId, FIRST_EVENT_SLOT, total);
      preloaded = {
        events: all.map((e) => stripEventDataRefs(e, resolveData)),
        cursor: all.at(-1)?.eventId ?? null,
        hasMore: false,
      };
    }

    return {
      event: stripEventDataRefs(stored.event, entityData),
      run: run ? await withAttributes(run) : undefined,
      step,
      hook,
      ...preloaded,
      // Server-owned per-run event ceiling; the runtime enforces it. Only
      // meaningful when a run entity is attached (run-lifecycle responses).
      ...(run ? { maxEvents: maxEventsPerRun } : {}),
    } as EventResult;
  }

  return {
    // Wrapped rather than folded into `createEvent`, which has a dozen commit
    // points: the delta and the skipped-slot report are the same at every one
    // of them (read the committed id, read back what is around it).
    create: (async (
      runId: string | null,
      data: CreateEventRequest | RunCreatedEventRequest,
      params?: CreateEventParams,
    ): Promise<EventResult> => {
      const result = await createEvent(runId, data, params);
      // A preload (run_started) already owns events/cursor/hasMore.
      if (!result.event || result.events !== undefined) return result;
      const resolveData = params?.resolveData ?? "all";
      // The delta wins when both were asked for: the skipped slots all sit above
      // the cursor, so it is a strict superset, and it is the only one of the two
      // that advances `cursor`.
      if (typeof params?.sinceCursor === "string") {
        return deltaSince(result, params.sinceCursor, resolveData);
      }
      if (params?.eventCount !== undefined) {
        return reportSkippedSlots(result, params.eventCount, resolveData);
      }
      return result;
    }) as Storage["events"]["create"],

    async get(
      runId: string,
      eventId: string,
      params?: GetEventParams,
    ): Promise<Event> {
      const data = await redis.hget(eventsKey(runId), eventId);
      if (!data) {
        throw new WorkflowWorldError(`Event not found: ${eventId}`, {
          status: 404,
        });
      }
      const event = EventSchema.parse(
        compact(parseWithUint8Array<Event>(data)),
      );
      return stripEventDataRefs(event, params?.resolveData ?? "all");
    },

    async list(params: ListEventsParams): Promise<EventListResponse> {
      const sortOrder = params.pagination?.sortOrder || "asc";
      const fromCursor = params.pagination?.cursor;
      const total = await redis.hlen(eventsKey(params.runId));
      // The log is dense, so a page is a run of consecutive slots.
      const limit = params.pagination?.limit ?? Math.max(total, 1);

      let cursorSlot: number | null = null;
      if (fromCursor) {
        cursorSlot = eventIdToSlot(fromCursor);
        if (cursorSlot === null) {
          throw new WorkflowWorldError(
            `Invalid pagination cursor "${fromCursor}"`,
            {
              status: 400,
            },
          );
        }
      }

      let events: Event[];
      let hasMore: boolean;
      if (sortOrder === "desc") {
        const last =
          cursorSlot === null ? total : Math.min(cursorSlot - 1, total);
        const first = Math.max(FIRST_EVENT_SLOT, last - limit + 1);
        events = (await readSlots(params.runId, first, last)).reverse();
        hasMore = first > FIRST_EVENT_SLOT;
      } else {
        const first = (cursorSlot ?? 0) + 1;
        const last = Math.min(total, first + limit - 1);
        events = await readSlots(params.runId, first, last);
        hasMore = last < total;
      }

      const resolveData = params.resolveData ?? "all";
      return {
        data: events.map((event) => stripEventDataRefs(event, resolveData)),
        // Echo the cursor back on an empty page so a poller keeps its place.
        cursor: events.at(-1)?.eventId ?? fromCursor ?? null,
        hasMore,
      };
    },

    async listByCorrelationId(
      params: ListEventsByCorrelationIdParams,
    ): Promise<PaginatedResponse<Event>> {
      const limit = params.pagination?.limit ?? 100;
      const sortOrder = params.pagination?.sortOrder || "asc";
      const fromCursor = params.pagination?.cursor;
      const indexKey = eventsByCorrelationKey(
        params.runId,
        params.correlationId,
      );

      // Members are event ids scored by slot, so a cursor is a score bound.
      let ids: string[];
      if (sortOrder === "desc") {
        const cursorSlot = fromCursor ? eventIdToSlot(fromCursor) : null;
        const max = cursorSlot === null ? "+inf" : `(${cursorSlot}`;
        ids = await redis.zrevrangebyscore(
          indexKey,
          max,
          "-inf",
          "LIMIT",
          0,
          limit + 1,
        );
      } else {
        const cursorSlot = fromCursor ? eventIdToSlot(fromCursor) : null;
        const min = cursorSlot === null ? "-inf" : `(${cursorSlot}`;
        ids = await redis.zrangebyscore(
          indexKey,
          min,
          "+inf",
          "LIMIT",
          0,
          limit + 1,
        );
      }

      const page = ids.slice(0, limit);
      const events = await readEvents(params.runId, page);
      const resolveData = params.resolveData ?? "all";
      return {
        data: events.map((event) => stripEventDataRefs(event, resolveData)),
        cursor: events.at(-1)?.eventId ?? fromCursor ?? null,
        hasMore: ids.length > limit,
      };
    },
  };
}

/**
 * Create storage for workflow steps using Redis hashes and sorted sets
 */
export function createStepsStorage(
  config: RedisStorageConfig,
): Storage["steps"] {
  const { redis, keyPrefix } = config;

  const { stepKey, stepsIndexKey } = keys(keyPrefix);

  // Helper: Get step data from Redis key
  async function getStepData(
    key: string,
    stepId: string,
    params?: GetStepParams,
  ): Promise<Step | StepWithoutData> {
    const data = await redis.get(key);

    if (!data) {
      throw new WorkflowWorldError(`Step not found: ${stepId}`, {
        status: 404,
      });
    }

    const step = parseWithUint8Array<Step>(data);
    const parsed = StepSchema.parse(compact(step));
    const resolveData = params?.resolveData ?? "all";
    return filterStepData(parsed, resolveData);
  }

  return {
    // A step id only identifies a step within its run, so the run is part of the key.
    get: (async (runId: string, stepId: string, params?: GetStepParams) =>
      getStepData(
        stepKey(runId, stepId),
        stepId,
        params,
      )) as Storage["steps"]["get"],

    list: (async (params: ListWorkflowRunStepsParams) => {
      const limit = params?.pagination?.limit ?? 20;
      const fromCursor = params?.pagination?.cursor;

      const entries = await pageIndex(
        redis,
        stepsIndexKey(params.runId),
        fromCursor,
        limit + 1,
        params?.pagination?.sortOrder ?? "desc",
      );

      // Fetch all steps
      const pipeline = redis.pipeline();
      for (const { id } of entries) {
        pipeline.get(stepKey(params.runId, id));
      }
      const results = await pipeline.exec();

      const resolveData = params?.resolveData ?? "all";
      const steps: { step: Step | StepWithoutData; cursor: string }[] = [];
      for (const [i, result] of (results ?? []).entries()) {
        if (result?.[1]) {
          const step = parseWithUint8Array<Step>(result[1] as string);
          const parsed = StepSchema.parse(compact(step));
          steps.push({
            step: filterStepData(parsed, resolveData),
            cursor: entries[i].cursor,
          });
        }
      }

      const values = steps.slice(0, limit);
      const hasMore = steps.length > limit;

      return {
        data: values.map((entry) => entry.step),
        hasMore,
        cursor: values.at(-1)?.cursor ?? null,
      };
    }) as Storage["steps"]["list"],
  };
}

/**
 * Create storage for hooks using Redis hashes and sorted sets
 */
export function createHooksStorage(
  config: RedisStorageConfig,
): Storage["hooks"] {
  const { redis, keyPrefix } = config;

  const {
    hookKey: hookKeyFn,
    hooksByTokenKey,
    hooksIndexKey,
    runsByStatusKey,
  } = keys(keyPrefix);

  // A finished run holds no hooks, so every hook is in the index of a live run.
  // shortcut: one index read per live run on each page, upgrade to a global hooks
  // index (kept in the create/dispose/finish scripts) if that count gets large.
  async function liveHooksIndexKeys(): Promise<string[]> {
    const live = await Promise.all(
      ["pending", "running"].map((status) =>
        redis.zrange(runsByStatusKey(status), "0", "-1"),
      ),
    );
    return live.flat().map(hooksIndexKey);
  }

  return {
    async get(hookId: string, params?: GetHookParams): Promise<Hook> {
      const data = await redis.get(hookKeyFn(hookId));
      if (!data) {
        throw new HookNotFoundError(hookId);
      }
      const hook = parseWithUint8Array<Hook>(data);
      const parsed = HookSchema.parse(compact(hook));
      const resolveData = params?.resolveData ?? "all";
      return filterHookData(parsed, resolveData);
    },

    async getByToken(token: string, params?: GetHookParams): Promise<Hook> {
      const hookId = await redis.get(hooksByTokenKey(token));
      if (!hookId) {
        throw new HookNotFoundError(token);
      }
      return this.get(hookId, params);
    },

    async list(params: ListHooksParams): Promise<PaginatedResponse<Hook>> {
      const limit = params?.pagination?.limit ?? 100;
      const fromCursor = params?.pagination?.cursor;

      const entries = await pageIndex(
        redis,
        params.runId ? hooksIndexKey(params.runId) : await liveHooksIndexKeys(),
        fromCursor,
        limit + 1,
        params?.pagination?.sortOrder ?? "asc",
      );

      // Fetch all hooks
      const pipeline = redis.pipeline();
      for (const { id } of entries) {
        pipeline.get(hookKeyFn(id));
      }
      const results = await pipeline.exec();

      const hooks: { hook: Hook; cursor: string }[] = [];
      for (const [i, result] of (results ?? []).entries()) {
        if (result?.[1]) {
          const hook = parseWithUint8Array<Hook>(result[1] as string);
          const parsed = HookSchema.parse(compact(hook));
          hooks.push({
            hook: filterHookData(parsed, params?.resolveData ?? "all"),
            cursor: entries[i].cursor,
          });
        }
      }

      const values = hooks.slice(0, limit);
      const hasMore = hooks.length > limit;

      return {
        data: values.map((entry) => entry.hook),
        cursor: values.at(-1)?.cursor ?? null,
        hasMore,
      };
    },
  };
}
