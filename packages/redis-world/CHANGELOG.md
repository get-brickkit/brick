# @brickkit/redis-world

Versioned in lockstep with the other `@brickkit` packages. The release notes on GitHub (one `v<version>` release for all packages) list every change; this file keeps the ones to this package.

## Unreleased

- `@brickkit/bullmq-world` now uses this package's storage, streams, retention reaper and run ids instead of its own copy, through a new `@brickkit/redis-world/internal` export. That export is not a public API. The package's public exports are unchanged.

## 0.11.0

- No changes to the code. Repository links now point to `get-brickkit/brick`.

## 0.10.0

- No changes. Released in lockstep.

## 0.9.1

- No changes. Released in lockstep.

## 0.9.0

- First release on npm: a Workflow SDK v5 World with Redis storage, streaming, retention, and a reliable Redis list queue, with no BullMQ dependency.
- `createRunId` names a run after its `runKey`, so a run is started once per key.

## 0.8.1

Not published. First version in the repository: Workflow SDK v5 World with Redis storage, streaming, retention, and a reliable Redis list queue.
