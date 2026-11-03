<div align="center">
  <picture>
    <source srcset="./banner-dark.svg" media="(prefers-color-scheme: dark)"/>
    <source srcset="./banner-light.svg" media="(prefers-color-scheme: light)"/>
    <img src="./banner-light.svg" alt="Brick logo" width="160"/>
  </picture>

[![npm](https://img.shields.io/npm/dm/@brickkit/core?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@brickkit/core)
[![npm version](https://img.shields.io/npm/v/@brickkit/core.svg?style=flat&colorA=000000&colorB=000000)](https://www.npmjs.com/package/@brickkit/core)
[![GitHub stars](https://img.shields.io/github/stars/get-brickkit/brick?style=flat&colorA=000000&colorB=000000)](https://github.com/get-brickkit/brick/stargazers)

  <p>
    <a href="https://github.com/get-brickkit/brick/issues">Issues</a>
    ·
    <a href="./CONTRIBUTING.md">Contributing</a>
    ·
    <a href="https://github.com/get-brickkit/brick/releases">Releases</a>
  </p>
</div>

# Brick-TS

Brick-TS is a TypeScript backend framework on Bun. You define services with validated actions, mount them with `brick()`, and get an Elysia HTTP server with OpenAPI output and a typed client.

The framework runs on Bun, Elysia, TypeBox, and Drizzle ORM. The pages example adds Better Auth and Postgres.

## Install

You need Bun 1.2 or later.

```sh
bun add @brickkit/core @brickkit/cli @brickkit/crud
```

## Build a minimal API

Define a service, mount it, and start the server.

```ts
import { brick, defineAction, defineService } from "@brickkit/core";

const healthService = defineService("system");
const ping = defineAction({
  name: "ping",
  execute: async () => ({ status: "ok" }),
});
healthService.action(ping);

const app = brick({ services: [healthService] });
app.listen(4000);
```

This serves `POST /api/system/ping`.

Inspect the same app without starting it:

```sh
brick gen openapi src/app.ts --output openapi.json
brick info src/app.ts
```

The entry module must default-export the `BrickApp` and must not call `.listen()` inside it. Keep the listener in a separate bootstrap file. The CLI reference is in `packages/cli/README.md`.

## Packages

| Package                  | Directory                | What it holds                                                                                                                |
| ------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `@brickkit/core`         | `packages/core/`         | Services, actions, the `brick()` server, events and workflow listeners, and the typed client at `@brickkit/core/client`.     |
| `@brickkit/crud`         | `packages/crud/`         | Opt-in CRUD plugin with field policies, filtering, and hooks.                                                                |
| `@brickkit/cli`          | `packages/cli/`          | The `brick` binary: `dev`, `start`, `build`, `worker`, `gen`, and `info`, plus the Vite client plugin and the dev dashboard. |
| `@brickkit/redis-world`  | `packages/redis-world/`  | A Redis world for the Workflow SDK, which runs workflow listeners durably.                                                   |
| `@brickkit/bullmq-world` | `packages/bullmq-world/` | A Redis and BullMQ world for the Workflow SDK, the same interface as the Redis world.                                        |

The dev dashboard's Workflows tab is the Workflow SDK's inspector. Its source is in `packages/workflow-inspector/`, which is not published: the CLI build copies it into `@brickkit/cli`.

The events and workflows example is in `examples/events/`. The full app is in `examples/pages/`. It mounts the API in process with TanStack Start and uses workspace packages directly. The docs site is in `www/`, with content in `www/content/docs`.

## Develop and test

```sh
bun install
bun test packages
bun run pages:dev
```

`bun test packages` runs the framework tests without Postgres. `bun run pages:dev` builds the framework and starts the combined web and API server on port 5174. Rerun it after you change framework code.

The pages suite needs Postgres. It is documented in `examples/pages/README.md`.

```sh
bun run pages:typecheck
TEST_DATABASE_URL=postgresql://localhost:5432/drafton_test bun run pages:test
```

Run the full gate before you push:

```sh
bun run check
```

`bun run check` runs lint, format check, build, typecheck, and tests. The worlds' own tests need Redis and run separately with `bun run test:worlds` (point `REDIS_TEST_URL` at a server, or let it start a container). Each package also has `lint`, `lint:fix`, `format`, and `format:check`. Shared config lives in `.oxlintrc.json` and `.oxfmtrc.json`.

## Release

All five published packages (`@brickkit/core`, `@brickkit/crud`, `@brickkit/cli`, `@brickkit/redis-world`, and `@brickkit/bullmq-world`) share one version and ship under one `v<version>` tag. A release writes the new version into each package manifest, sets the CLI's `@brickkit/core` dependency and CRUD's `@brickkit/core` peer dependency to `^<version>`, and updates `bun.lock`. It refuses to run when the five versions differ.

Stable releases run from a clean, up-to-date `main` checkout:

```sh
bun run release patch   # or minor, major
```

Beta releases run from `beta` with `bun run release beta`. The first beta after `X.Y.Z` is `X.(Y+1).0-beta.0`; later ones count up (`-beta.1`, `-beta.2`). Betas publish under the npm `beta` dist-tag and as GitHub prereleases; stable versions publish under `latest`. To promote a beta, merge `beta` into `main` and run a stable bump there: any stable bump from `X.Y.Z-beta.N` releases `X.Y.Z`.

The GitHub `publish-npm.yml` workflow stages candidate versions without changing Git refs. Its `validate` matrix builds, typechecks, tests, and packs each of the five packages separately. Only when all five validations pass does it publish each validated tarball. After all five npm publishes succeed, it commits and tags the version, then creates the GitHub release. A failed validation or publish does not create a release commit. No builds or tests run again inside the individual publish jobs, so a later test failure cannot leave only some packages published. If npm itself fails after some uploads, rerun the failed jobs for that same candidate; already-published package versions are skipped.

`bun run release` only checks the preconditions (a clean tree, the release branch in sync with origin, a tag that does not exist yet, and `gh` signed in) and dispatches that workflow. There are two dry runs:

- `bun run release <bump> --dry-run` runs locally. It prints the next version and the files it would write, and changes nothing. It does not build, test, or pack.
- The workflow's `dry_run` input, set when you dispatch `publish-npm.yml` by hand, runs the full `validate` matrix and packs the tarballs, but publishes nothing and creates no commit or tag.

The internal `--prepare` mode is for the workflow: it writes the manifests and the lockfile for validation, without committing.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=get-brickkit/brick&type=date&legend=top-left)](https://www.star-history.com/?repos=get-brickkit%2Fbrick&type=date&legend=top-left)

## Contribute

Read `CONTRIBUTING.md` for setup, checks, and hook behavior. Small starter tasks carry the `good first issue` label. The project is MIT licensed.
