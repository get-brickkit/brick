# Pages

A publishing app with a TanStack Start frontend, an in-process Brick API, Better Auth,
Postgres, and MCP tools. This is an ordinary part of the brick-ts workspace.
The app depends on `@brickkit/core` and `@brickkit/cli` via `workspace:*`.
The frontend uses `@brickkit/core/client` with a type-only import of the API
contract; no npm publish or OpenAPI client generation is needed.

From the repository root:

```sh
bun install
bun run pages:dev           # build local Brick packages, then start web + API on :5174
bun run pages:build         # build local Brick packages and the production app
bun run pages:typecheck     # check backend and frontend against the local package builds
bun run pages:test         # run the Postgres-backed API and SDK integration tests
```

After changing framework code, rerun these commands to rebuild the workspace
packages. The backend lives in `src/api` and is mounted by `src/server.ts`; there is one
package and one server for the UI, API, auth, and MCP routes.

`pages:dev` also serves the Brick dashboard at `http://127.0.0.1:9400`. It shows
each API request with its action, auth, and SQL spans, plus failures and the
service's routes and tables. The app opts in with `telemetry: true` in
`src/api/app.ts`, and its auth and MCP routes are wrapped with `traceRoute`.
The APIs tab renders the app's routes and Better Auth's (the `openAPI()` plugin,
passed through `reference.documents`) with Fumadocs OpenAPI and sends test calls to
the app, with the app's trace of each call under its response.
The Docs tab shows the developer documentation in `docs/` (set by `documentation`
in `src/api/app.ts`, as `../../docs`, a path from that file): Fumadocs-style pages
with `meta.json` ordering, and
`docs/components.tsx` adds an `Endpoint` component of the project's own. It needs
`fumadocs-core` and `@mdx-js/mdx`, listed in this package's dev dependencies.
The Requests tab can look back over 90 days of finished requests kept in
`.brick/`, which ignores itself. Change that with `dashboard: { historyDays }`, or turn the dashboard off
with `dashboard: false`, on `brickClient` in `vite.config.ts`.

## Database and environment

Provide a local Postgres database. The development connection defaults to
`postgresql://localhost:5432/drafton`; override it with `DATABASE_URL`.
The app owns one postgres-js client in `src/api/db.ts` and injects it
into the shared database handle used by pages and auth. Prepared statements
are disabled for compatibility with transaction-mode poolers.

The app never runs migrations on startup. Apply the committed migrations:

```sh
DATABASE_URL=postgresql://localhost:5432/drafton \
  bun run --cwd examples/pages db:migrate
```

For a disposable development database, `db:push` is also available. To
regenerate schema migrations after changing tables, run `db:generate`.

Set `AUTH_SECRET` for production (`openssl rand -hex 32` makes one). Locally it is optional: a random secret is made on first start and kept in `.brick/auth-secret`, which git ignores, so sessions survive restarts. A development database that already has a signing key from an older secret answers signed-in requests with a 500 ("Failed to decrypt private key") until that key is cleared once: `delete from jwks;`. Better Auth makes a new one on demand. `BASE_URL` and `BACKEND_ORIGIN` should be the
public origin; for the combined local web/API server use
`http://localhost:5174`. `MCP_RESOURCE` defaults to `<BASE_URL>/mcp`.
`VITE_API_BASE` optionally points the browser at a separate API origin.
The environment template lives in `.env.example`. Export values
in your shell or put them in the app's `.env` file before starting it.

## Vercel deployment

Set the Vercel project's Root Directory to `examples/pages` and enable access to
files outside that directory so the build can read the workspace packages.
The committed `vercel.json` installs from the repository root and runs
`pages:build`, rebuilding local Brick packages before building the app.
Framework changes are included directly in the deployment without an npm publish.

Vercel sets `VERCEL=1`, which selects Nitro's `vercel` preset and generates
`.vercel/output` with static assets and the combined SSR/API server function.
The config overrides the static Vite `dist` output setting. Local production
builds continue to emit `.output` for `bun run start`.

Set the production database and auth environment variables described above in
Vercel, and apply database migrations separately before using the app.
To verify the deployment build locally from the app directory:

```sh
VERCEL=1 bun run --cwd ../.. pages:build
```

## Testing

`pages:test` uses `TEST_DATABASE_URL`, defaulting to
`postgresql://localhost:5432/drafton_test`. It creates the database if missing,
applies migrations, and **truncates its tables between tests**. Use a dedicated
test database. The Postgres role needs database creation permission on first run.

```sh
TEST_DATABASE_URL=postgresql://localhost:5432/drafton_test bun run pages:test
```

The SDK test authenticates through Better Auth, calls CRUD and a custom action
through the real API, checks the public HTML viewer and anonymous access, and
verifies injected-client identity. `bun run test` at the repository root runs
framework tests without requiring the pages Postgres database.

## Layout

- `src/api/db.ts`: shared Postgres client, handle, and schema.
- `src/api/contract.ts`: server contract and exported `PagesApi` type.
- `src/api/app.ts`: contract-based server, auth, public HTML, and MCP routes.
- `src/api/services/pages/page/`: table, resource, and rendering.
- `src/api/services/pages/page/tools/`: MCP tool definitions with inline annotations.
- `src/api/services/pages/mcp.ts`: shared MCP registry for the Pages service.
- `test/`: API, auth, MCP, rendering, and local SDK tests.
- `src/lib/api.ts`: browser-safe SDK, cookie credentials, and page types.
- `src/collections/pages.ts`: paginated SDK reads for TanStack DB.
- `src/actions/pages.ts`: optimistic writes through the SDK.

CRUD and explicitly exposed tool types infer directly from the contract. List rows allow
omitted columns because resource lists support projection. Backend modules are
imported only as types in the browser client.

## Routes

- `/api/pages/page` and `/api/pages/page/:id`: owner-scoped CRUD (list is
  `POST /api/pages/page/query`).
- `POST /api/pages/echo`: tool explicitly exposed over HTTP.
- `/api/auth/*`: Better Auth.
- `GET /api/pages/public/:slug`: public metadata.
- `/p/:slug`: rendered public page.
- `/openapi.json`, `/swagger`: API documentation. The API reference (this app's
  routes and Better Auth's) is the APIs tab of the `brick dev` dashboard.
- `/mcp` and `/.well-known/*`: authenticated MCP transport and OAuth discovery.

The web server mounts the API in-process, so development requires one server.
The separate pages repository is no longer needed to run this example.

Tools register with `pagesService.tool()` and remain MCP-only by default. The
shared `createMcpRegistry({ services: [pagesService] })` lists and dispatches them,
so no separate annotations map or tool array is needed. Echo and the public
metadata tool opt into HTTP with `http: true`. The shared `createMcpHandler()`
handles JSON-RPC; Better Auth still verifies tokens in the app's MCP wrapper.

## Generated client contract

The Brick Vite plugin loads the default `BrickApp` export from `src/api/app.ts`
and generates `_brick/contract.ts` automatically during `dev` and `build`.
There is no manually maintained backend contract. `src/lib/api.ts` imports the
browser-safe generated metadata, and `src/server/brick.ts` imports
`virtual:brick-app` to forward API requests inside the Start server.

Backend edits regenerate route/schema metadata and participate in Vite hot
reload. `_brick/` is ignored by Git. The `typecheck` script initializes Vite to
produce the contract before running TypeScript, so it also works on a clean
checkout. App initialization configuration (including required secrets) must
be available when generation runs.

The editor uses `@brickkit/core/tanstack-query` with the generated browser contract.
Its load query and create/update mutations infer their inputs and outputs from the
API. Successful saves invalidate typed list/detail keys and explicitly refetch the
TanStack DB collection used by the dashboard and command bar. Collection identity
and optimistic synchronization remain separate from the Query helpers.
