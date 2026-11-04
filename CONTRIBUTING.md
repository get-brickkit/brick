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

For the Go and Rust SDKs (`sdk/go`, `sdk/rust`) and their conformance test, which needs `go` and `cargo`:

```sh
(cd sdk/go && go vet ./... && go test ./...)
(cd sdk/rust && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
bun test sdk
```

The pages tests create the test database if it is missing and truncate its tables between tests. Use a dedicated test database. Postgres setup and environment variables are documented in `examples/pages/README.md`.

Format with `bun run format` from the package directory or the root. Shared config lives in `.oxlintrc.json` and `.oxfmtrc.json`. Generated files and build output are excluded.

## Know what the hooks run

The hooks are defined in `lefthook.yml` and run on pre-commit. They check staged whitespace, run Oxlint and Oxfmt on staged files, run `bun run check`, and, when site files change, run the site lint and type checks. There is no pre-push hook. Run `bunx --no-install lefthook run pre-push --all-files` only when you want the website checks on demand from the root.

## Send the pull request

- Describe what changes and how you verified it. Link the run output or the command you used.
- Keep generated files out of the diff. `_brick/` contract output is ignored by Git.
- Do not run `bun run release`. Releases run from a clean `main` (stable) or `beta` checkout through `scripts/release.ts` and the `publish-npm.yml` workflow.

## Release the Go and Rust SDKs

The Rust crate `brickkit` (`sdk/rust/brick`) and the Go module `github.com/get-brickkit/brick/sdk/go` ship with every npm release, under the same version. `scripts/release.ts` bumps the crate's `Cargo.toml` with the packages. After npm, the `publish-sdks` job in `publish-npm.yml` runs `cargo publish` from the release commit, then pushes the tag `sdk/go/v<version>`, which is the Go module's version.

A maintainer sets this up once, before the first release that includes them:

1. Claim the crate name: sign in to crates.io with the GitHub account that owns the release, and publish `brickkit` once by hand from `sdk/rust` (`cargo publish -p brickkit`), or let the first release do it. Then add the other maintainers with `cargo owner --add <github-user> brickkit`.
2. Create a crates.io API token (Account Settings, API Tokens) with the `publish-update` scope, limited to the `brickkit` crate (and `publish-new` for the first publish).
3. Add it as the repository secret `CARGO_REGISTRY_TOKEN` (Settings, Secrets and variables, Actions). Without it a release, manual or from a `v*` tag, stops in the `prepare` job, before anything is published.

The Go module needs no registry: the tag is enough, and `proxy.golang.org` picks it up on the first `go get`.
