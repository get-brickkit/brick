# @brickkit/bullmq-world

Versioned in lockstep with the other `@brickkit` packages. The release notes on GitHub (one `v<version>` release for all packages) list every change; this file keeps the ones to this package.

## Unreleased

- Storage, streams, the retention reaper and run ids now come from `@brickkit/redis-world`, which this package depends on, instead of a copy of the same code. The public API is unchanged, and the reaper still logs under the `redis-bullmq-world` debug namespace.

## 0.11.0

- No changes to the code. Repository links now point to `get-brickkit/brick`.

## 0.10.0

- No changes. Released in lockstep.

## 0.9.1

- No changes. Released in lockstep.

## 0.9.0

- First release on npm: a Redis and BullMQ world for the Workflow SDK v5, derived from `@fantasticfour/world-redis-bullmq` (see `NOTICE`).
- `createRunId` names a run after its `runKey`, so a run is started once per key.

## 0.8.1

Not published. First version in the repository: a Redis and BullMQ world for the Workflow SDK v5, derived from `@fantasticfour/world-redis-bullmq` (see `NOTICE`).
