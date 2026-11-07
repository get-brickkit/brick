// The entry points the reference covers: one page each. `file` is the source
// the published entry is built from (see each package's tsdown config), and
// `specifier` is what users import. test/api-reference.test.ts checks that this
// list matches every package's `exports`, so a new entry point cannot be missed.
export interface EntryPoint {
  slug: string;
  specifier: string;
  /** Repository-relative source file of the entry. */
  file: string;
  /** The tsconfig that resolves its imports. */
  tsconfig: string;
  description: string;
}

export const ENTRY_POINTS: EntryPoint[] = [
  {
    slug: "core",
    specifier: "@brickkit/core",
    file: "packages/core/src/index.ts",
    tsconfig: "packages/core/tsconfig.build.json",
    description:
      "Services, actions, tools, resources, databases, secrets, the HTTP runtime, and the typed contract of a Brick application.",
  },
  {
    slug: "core-client",
    specifier: "@brickkit/core/client",
    file: "packages/core/src/client.ts",
    tsconfig: "packages/core/tsconfig.build.json",
    description:
      "The typed HTTP client a frontend uses to call a Brick application, inferred from its contract.",
  },
  {
    slug: "core-tanstack-query",
    specifier: "@brickkit/core/tanstack-query",
    file: "packages/core/src/tanstack-query.ts",
    tsconfig: "packages/core/tsconfig.build.json",
    description:
      "TanStack Query options and keys for the typed client's actions.",
  },
  {
    slug: "core-pg",
    specifier: "@brickkit/core/pg",
    file: "packages/core/src/pg.ts",
    tsconfig: "packages/core/tsconfig.build.json",
    description:
      "Postgres databases for Brick services, with Drizzle's table builders.",
  },
  {
    slug: "core-workflow",
    specifier: "@brickkit/core/workflow",
    file: "packages/core/src/workflow.ts",
    tsconfig: "packages/core/tsconfig.build.json",
    description:
      "Typed errors for workflow steps, safe to import in workflow code.",
  },
  {
    slug: "core-testing",
    specifier: "@brickkit/core/testing",
    file: "packages/core/src/testing.ts",
    tsconfig: "packages/core/tsconfig.build.json",
    description:
      "createTestApp: an app per test with a typed client and a cleanup.",
  },
  {
    slug: "cli",
    specifier: "@brickkit/cli",
    file: "packages/cli/src/index.ts",
    tsconfig: "packages/cli/tsconfig.build.json",
    description:
      "The brick command's building blocks: the dev and production servers, contract generation, and the OpenAPI pages.",
  },
  {
    slug: "cli-config",
    specifier: "@brickkit/cli/config",
    file: "packages/cli/src/config.ts",
    tsconfig: "packages/cli/tsconfig.build.json",
    description:
      "Define and validate brick.config.ts, resolve project paths, and apply CLI flag defaults.",
  },
  {
    slug: "cli-compiler",
    specifier: "@brickkit/cli/compiler",
    file: "packages/cli/src/compiler.ts",
    tsconfig: "packages/cli/tsconfig.build.json",
    description:
      "Emit the JavaScript module of a compiled application's route handlers, and each handler factory, for an ahead-of-time build.",
  },
  {
    slug: "cli-production-dashboard",
    specifier: "@brickkit/cli/production-dashboard",
    file: "packages/cli/src/production-dashboard.ts",
    tsconfig: "packages/cli/tsconfig.build.json",
    description:
      "Serve the production dashboard with bearer authentication and database access controls.",
  },
  {
    slug: "cli-dashboard",
    specifier: "@brickkit/cli/dashboard",
    file: "packages/cli/dashboard/kit.ts",
    tsconfig: "packages/cli/dashboard/tsconfig.json",
    description:
      "defineDashboard, the UI kit and the data hooks for a dashboard extension.",
  },
  {
    slug: "cli-vite",
    specifier: "@brickkit/cli/vite",
    file: "packages/cli/src/vite.ts",
    tsconfig: "packages/cli/tsconfig.build.json",
    description:
      "The Vite plugin that generates the typed client contract and serves the dashboard.",
  },
  {
    slug: "cli-workflows",
    specifier: "@brickkit/cli/workflows",
    file: "packages/cli/src/workflows.ts",
    tsconfig: "packages/cli/tsconfig.build.json",
    description:
      'Load and build the `"use workflow"` and `"use step"` files of a Brick application, for tests and scripts that run workflows without `brick dev`.',
  },
  {
    slug: "cli-dev-reporter",
    specifier: "@brickkit/cli/dev-reporter",
    file: "packages/cli/src/dev-reporter.ts",
    tsconfig: "packages/cli/tsconfig.build.json",
    description:
      "Report a worker process's requests to a running dev dashboard.",
  },
  {
    slug: "cli-lint-eslint",
    specifier: "@brickkit/cli/lint/eslint",
    file: "packages/cli/src/lint/eslint.ts",
    tsconfig: "packages/cli/tsconfig.build.json",
    description: "The Brick lint rules as an ESLint flat-config plugin.",
  },
  {
    slug: "cli-lint-oxlint",
    specifier: "@brickkit/cli/lint/oxlint",
    file: "packages/cli/src/lint/oxlint.ts",
    tsconfig: "packages/cli/tsconfig.build.json",
    description:
      "The Brick lint rules as an oxlint JS plugin, and an oxlint config from brick.config.ts.",
  },
  {
    slug: "crud",
    specifier: "@brickkit/crud",
    file: "packages/crud/src/index.ts",
    tsconfig: "packages/crud/tsconfig.json",
    description:
      "CRUD actions for a resource, with access rules, filters, and hooks.",
  },
];
