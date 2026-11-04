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

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=get-brickkit/brick&type=date&legend=top-left)](https://www.star-history.com/?repos=get-brickkit%2Fbrick&type=date&legend=top-left)

## Contribute

Read `CONTRIBUTING.md` for setup, checks, and hook behavior. Small starter tasks carry the `good first issue` label. The project is MIT licensed.
