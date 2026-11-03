# Contribute to Brick-TS

This guide gets your first change merged. It covers setup, where code lives, and the checks that must pass.

## Set up

You need Bun 1.2 or later and, for the pages app only, a local Postgres server.

```sh
bun install
```

`bun install` also installs the Lefthook Git hooks. It manages the whole workspace through the root `bun.lock`.

## Decide where your change lives

- `packages/core/` is services, actions, the `brick()` server, and the typed client in `@brickkit/core/client`.
- `packages/cli/` is the `brick` binary: `dev`, `start`, `build`, `gen`, and `info`. Details live in `packages/cli/README.md`.
- `packages/crud/` is the opt-in CRUD plugin.
- `packages/redis-world/` and `packages/bullmq-world/` are the Workflow SDK worlds that run workflow listeners. Their tests need Redis: `bun run test:worlds`.
- `packages/workflow-inspector/` is the Workflow SDK's observability UI for the dev dashboard, a modified copy of `@workflow/web`. It is not published: `bun run --filter @brickkit/cli build` builds it and copies it into the CLI. See its README before changing upstream files.
- `www/` is the docs site. Content lives in `www/content/docs`. The agent skill lives in `skills/brick/SKILL.md`.
- `examples/events/` is the events and workflows example, with tests that run over both worlds.
- `examples/pages/` is the full app: TanStack Start frontend with the Brick API mounted in process. It uses workspace packages, so no npm publish is needed to try a framework change.

## Make a first change

Good starters are labeled `good first issue`. Issues 70 to 80 are small backlog tasks with acceptance criteria.

Keep the change to one package or the site. Do not mix a framework change with a site redesign in one pull request.

## Run the checks

Run the focused command first, then the full gate before you push.

```sh
bun test packages/core
bun run --filter @brickkit/core typecheck
bun run check
```

`bun run check` runs lint, format check, build, typecheck, and tests for the framework packages.

For the site, run these from `www/`:

```sh
bun run lint
bun run types:check
bun run docs:check
```

For the pages app, build the framework first, then run the app commands from the root:

```sh
bun run pages:typecheck
TEST_DATABASE_URL=postgresql://localhost:5432/drafton_test bun run pages:test
```

The pages tests create the test database if it is missing and truncate its tables between tests. Use a dedicated test database. Postgres setup and environment variables are documented in `examples/pages/README.md`.

Format with `bun run format` from the package directory or the root. Shared config lives in `.oxlintrc.json` and `.oxfmtrc.json`. Generated files and build output are excluded.

## Know what the hooks run

The hooks are defined in `lefthook.yml` and run on pre-commit. They check staged whitespace, run Oxlint and Oxfmt on staged files, run `bun run check`, and, when site files change, run the site lint and type checks. There is no pre-push hook. Run `bunx --no-install lefthook run pre-push --all-files` only when you want the website checks on demand from the root.

## Send the pull request

- Describe what changes and how you verified it. Link the run output or the command you used.
- Keep generated files out of the diff. `_brick/` contract output is ignored by Git.
- Do not run `bun run release`. Releases run from a clean `main` (stable) or `beta` checkout through `scripts/release.ts` and the `publish-npm.yml` workflow. The README's Release section explains the process.
