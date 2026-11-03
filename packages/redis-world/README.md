# @brickkit/redis-world

A plain Redis World for Workflow SDK v5. Runs, events, steps, hooks, streams, and queue deliveries live in Redis. The queue uses a ready list, per-worker processing lists, a delayed sorted set, and expiring worker heartbeats. Lua scripts make enqueue, reserve, acknowledge, defer, promote, and reclaim atomic.

```sh
bun add @brickkit/redis-world
# or: npm install @brickkit/redis-world
```

```ts
import { createWorld } from "@brickkit/redis-world";

const world = createWorld({ redis: "redis://localhost:6379" });
await world.start();
// On shutdown: await world.close();
```

Set `WORKFLOW_TARGET_WORLD=@brickkit/redis-world` for the Workflow runtime. Serve the runtime's generated flow route at `/.well-known/workflow/v1/flow`. Workers POST to that route unless an in-process handler or a custom route is registered. This package supplies the World, not an embedded runtime server.

## Configuration

Pass options to `createWorld`. With no arguments, Redis, key prefix, and concurrency come from the environment variables below.

| Option                 | Default                                                        | Meaning                                                                                                                             |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `redis`                | `WORKFLOW_REDIS_URL`, `REDIS_URL`, or `redis://localhost:6379` | Connection URL or ioredis `RedisOptions`                                                                                            |
| `keyPrefix`            | `workflow:`                                                    | All storage and queue keys; env `WORKFLOW_REDIS_KEY_PREFIX`                                                                         |
| `queueConcurrency`     | `10`                                                           | Concurrent deliveries per process; env `WORKFLOW_REDIS_WORKER_CONCURRENCY`                                                          |
| `heartbeatTtlMs`       | `90000`                                                        | Worker lease in ms, renewed every third of its TTL; minimum 300. Set above the longest event-loop pause                             |
| `maxAttempts`          | `73`                                                           | Retry budget, minimum 49. After this budget, failed deliveries continue at `maxBackoffMs` so a transport outage cannot strand a run |
| `backoffType`          | `exponential`                                                  | `fixed` or `exponential`                                                                                                            |
| `backoffDelayMs`       | `1000`                                                         | Initial retry delay in ms                                                                                                           |
| `maxBackoffMs`         | `30000`                                                        | Retry delay cap in ms                                                                                                               |
| `baseUrl`              | `WORKFLOW_BASE_URL` or `http://localhost:$PORT` with port 3000 | HTTP delivery base; registered handlers/routes take precedence                                                                      |
| `httpTimeoutMs`        | `300000`                                                       | HTTP request timeout in ms. A timeout cannot stop a handler already running on the server                                           |
| `idempotencyTtlMs`     | unset                                                          | Optional dedup TTL. Unset keeps the reservation until acknowledgement. A TTL shorter than the backlog/delay permits duplicates      |
| `maxEventsPerRun`      | `WORKFLOW_MAX_EVENTS` or `25000`                               | Event ceiling reported to the runtime                                                                                               |
| `enableAutoPipelining` | `true`                                                         | Batch Redis commands issued in the same tick                                                                                        |
| `retention`            | unset                                                          | Finished-run policy described below                                                                                                 |

`getQueueStats()` returns `waiting`, `active`, and `delayed`. `completed` and `failed` are always zero because delivery history is not retained. Exhausted failed deliveries remain delayed and retain their dedup reservation until they succeed. The Workflow runtime can record a failed run when its own delivery ceiling is exceeded.

## Reliability and recovery

One queue, `${keyPrefix}queue:flows`, carries both workflow and step work. Reservation moves a message into `${keyPrefix}queue:flows:processing:<worker>` and increments durable attempt/delivery counters before dispatch. Heartbeat expiry permits another worker to reclaim the processing list. Recovery preserves message IDs and reports attempts above one after a crash. Successful reschedules preserve the attempt number and increment delivery count. Delays and retry backoffs remain in Redis across process restarts.

Duplicate enqueues with an `idempotencyKey` return the existing message ID while that message is ready, active, or delayed. Acknowledgement releases the reservation only if it still belongs to that message. An expired lease or a reclaimed claim cannot acknowledge, defer, or release another delivery's reservation. `start()` also re-enqueues active runs with `recover:<runId>` dedup keys.

Delivery is at least once. A worker paused beyond its heartbeat TTL can overlap its replacement; queue fencing protects Redis queue state, not arbitrary external side effects. A killed step may execute again if its completion was not persisted. Use idempotent external effects. Graceful `close()` drains handlers while renewing its heartbeat.

Use Redis persistence such as AOF. Redis data loss can lose workflow history. Use a single primary, optionally with Sentinel/failover. Redis Cluster is unsupported because the storage and queue scripts use multiple keys without a shared hash slot. Workflow v4 run data is incompatible; drain old runs or use a fresh key prefix.

## Starting a run once

`start()` takes no run id, so a caller that retries (an event delivered twice, a request sent again) normally starts a second run. This world lets the caller name the run instead. Pass `runKey` and `runKeyTime` in the options to `start()`:

```ts
import { start } from "workflow/api";

const run = await start(myWorkflow, [input], {
  runKey: "evt_01J...:welcome-email",
  runKeyTime: Date.parse(event.occurredAt),
} as never);
```

The same `runKey` and `runKeyTime` always give the same run id, so starting again returns the run that is already there instead of a second one. This holds when the starts happen at the same moment on different workers, and the run's first message is not queued a second time. Once a run has started, starting it again does nothing: its steps do not run again.

`runKeyTime` is required with a `runKey`. A run id is a ULID, and the Workflow runtime seeds the workflow's clock (what `Date.now()` returns inside it) from the time in it. Passing the time the run is for, such as when the event happened, keeps that clock true and the same on every attempt. Pass the same time each time: a different `runKeyTime` is a different run. `runKey` is a non-empty string of at most 1024 characters. The world throws a `TypeError` for either one when it is not usable.

Without `runKey`, ids are fresh ULIDs and nothing changes. The Workflow typings do not list these two options yet, hence the cast.

## Retention

Finished runs stay forever unless you set a policy. `age` is in seconds; `count` keeps the newest runs. A status without a policy is kept.

```ts
createWorld({
  redis: "redis://localhost:6379",
  retention: {
    completed: { age: 24 * 60 * 60, count: 1000 },
    failed: { age: 7 * 24 * 60 * 60 },
    // cancelled is unset, so cancelled runs stay
  },
});
```

A run past either configured limit is deleted with its event log, steps, hooks, and streams. Running runs are never touched. Each worker sweeps every `retention.sweepIntervalMs` (default 60000), at most `retention.batchSize` runs per status (default 200). A Redis lock prevents simultaneous sweeps. `world.sweepRetention()` runs a sweep on demand. Queue records disappear on acknowledgement independently of run retention.

The optional in-band writer fence, `$retention: '0'` purging, hook token retention, and `createBatch` are not implemented. The v5 runtime handles their absence.

## Choosing a World

Choose `@brickkit/redis-world` when you want fewer dependencies and a hand-built list queue with durable delays, retries, and worker recovery. Choose `@brickkit/bullmq-world` when you want BullMQ's queue tooling and delivery records. Both use the same v5 storage, streaming, and run-retention implementation, which lives in this package; `@brickkit/bullmq-world` depends on it. This package has no BullMQ dependency and no Bull Board integration.

BullMQ-only options `jobPrefix`, `stalledInterval`, `maxStalledCount`, `lockDuration`, and `jobRetention` are absent. `keyPrefix` isolates the queue; `heartbeatTtlMs` controls crash recovery. Promotion and orphan checks run about every 100 ms while workers are alive.

## Development

```sh
bun install
bun run typecheck
bun run build
bun run test       # Docker/testcontainers unless REDIS_TEST_URL is supplied
bun run test:e2e  # redis-server executable, or E2E_REDIS_URL for shared Redis
```

The e2e harness exercises the built package and real Workflow runtime, including SIGKILL and Redis AOF restart scenarios. Own-Redis restart tests require `redis-server` even when `E2E_REDIS_URL` is provided.

Apache-2.0. See LICENSE and NOTICE.
