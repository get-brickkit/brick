# @brickkit/cli

CLI and server engine for the Brick-TS framework. Mounts services,
actions, and resources as a typed HTTP API (Elysia) with OpenAPI 3.1,
Scalar/Swagger docs, request logging, and MCP routes.

You need Bun 1.2 or later.

```sh
bun add @brickkit/cli @brickkit/core
```

```ts
import { brick } from "@brickkit/core";

const app = brick({ title: "Pages API", version: "1.0.0" });
app.listen(3333);
```

## Commands

Every command except `dev` and `start` takes a required `<entry>`: a module
whose default export is a `BrickApp` that does not call `.listen()`.

```sh
brick dev [entry] [--port 4000] [--dashboard-port 9400] [--history-days 90] [--no-dashboard]
brick start [entry] [--port 4000]
brick build <entry> [--outdir dist/brick] [--port <number>] [--no-aot]
brick worker <entry>
brick gen openapi <entry> [--output openapi.json]
brick gen client <entry> [--output _brick/contract.ts]
brick info <entry>
```

Build the backend directly from registered services:

```ts
import { brick } from "@brickkit/core";
import { pagesService, billingService } from "./services";

const app = brick({ services: [pagesService, billingService] });
```

The typed HTTP client is available from `@brickkit/core/client`. See the
[typed client guide](https://brickkit.dev/docs/typed-client) for routing and
error handling.

The `brick` binary ships in this package for local dev and inspection.
`dev` and `start` accept an optional entry and resolve the port from
`--port`, then `PORT`, then 4000:

```sh
brick dev --port 4000
brick dev src/app.ts --port 4000
brick gen openapi src/app.ts --output openapi.json
brick gen client src/app.ts
brick info src/app.ts
```

Source: <https://github.com/get-brickkit/brick>.

## Local dashboard

`brick dev` with an entry also serves a dashboard at
`http://127.0.0.1:9400`. It lists requests as they run, shows a waterfall of
each request's action and remote-call spans, and collects failures and reloads,
including startup crashes. The live views survive restarts within the same session.

Requests appear only from apps that opt in with `telemetry: true`. `brick dev`
warns when the dashboard is on but the entry doesn't set it:

```ts
const app = brick({ services: [pagesService], telemetry: true });
```

```sh
brick dev src/app.ts                          # dashboard on 9400
brick dev src/app.ts --dashboard-port 9500    # another port
brick dev src/app.ts --history-days 30        # keep a month of requests
brick dev src/app.ts --history-days 0         # live requests only, nothing on disk
brick dev src/app.ts --no-dashboard           # API only
```

The dashboard is a React app in `packages/cli/dashboard`, styled with Tailwind
and shadcn components. `bun run --filter @brickkit/cli build` bundles it into
`dashboard-dist`, which the package ships (about 2 MB, most of it the API
reference, which loads only when the APIs tab opens). See
`packages/cli/dashboard/README.md`.

The Overview tab draws the app as a graph of clients, services, and databases,
with each service's actions and tools and each database's name, engine, and
tables. Calls, durations, and health fill in from recent requests. Below it are
each HTTP route with its action and recent request and failure counts, and the
services with their databases and resources. SQL statements appear as child
spans under the action that ran them, with the statement text on hover. Spans
are colored by type: request, action, service call, and SQL.

The APIs tab renders the app's OpenAPI documents with Fumadocs OpenAPI, in the
dashboard's colors, so the app serves no reference page of its own. A sidebar
lists each document's operations by tag, with a filter; the open one shows its
parameters, responses, and example requests, which default to JavaScript
`fetch`. Try in Playground sends the call to the app through the dashboard (the
app is another origin), so the call also appears in the Requests tab, and the
response comes with the app's trace of it (when `telemetry` is on): the error, its stack trace when the
app threw one, and the spans. The dashboard forwards only to the app it shows.
The first document is the app's own, left out when
`docs` is `false`; `reference.documents` adds more, each a title and an OpenAPI
document or a function returning one (for example Better Auth's
`auth.api.generateOpenAPISchema()`). A document that throws is skipped with a
warning. `reference` serves a Scalar page only for `true` or with a `path`.

The Docs tab shows the app's developer documentation: a folder of `.md`/`.mdx`
pages in Fumadocs' layout (frontmatter, `meta.json`, folder groups), set with
`documentation` on `brick()`. It appears only for apps that set it.

```ts
// src/app.ts, with the docs in docs/ at the project root
const app = brick({
  services: [pagesService],
  documentation: "../docs", // or { dir: "../docs", components: "../docs/components.tsx" }
});
```

Relative paths start at the folder of the app entry, as they read in the file that
sets them. `fumadocs-core` builds the page tree and search, and `@mdx-js/mdx` compiles the
pages. Both are optional peers, loaded only when `documentation` is set; without
them the tab says what to install (`bun add -d fumadocs-core @mdx-js/mdx`).
Saving a file updates the tab. Pages can use Fumadocs' components without
importing them (Callout, Cards, Tabs, Steps, Accordions, Files, TypeTable,
InlineTOC, Banner), and `components` names a module of your own React components
to add, which the dashboard bundles. Links between pages and local images work as
they do on a docs site. See `packages/cli/dashboard/README.md`.

For an app with workflow listeners, a Workflows tab shows the Workflow SDK's
inspector, which comes with the CLI, for the world the app runs on. The app serves it on a
loopback port of its own and the dashboard passes requests to it at `/workflows`.
It can cancel runs, so only `brick dev` serves it, and only the dashboard's own
page may change anything through it.

The Logs tab lists what actions, tools, and endpoints log with `ctx.logger`, and
what they print with `console.log`, `info`, `warn`, `error`, and `debug`, newest
first. Under `brick dev` a line written while a traced request runs is a span
event on that request, so it shows here and in the request's details, and is not
printed. `brick start` does the same only when the app sets the `dashboard`
option (see below); otherwise nothing is captured or changed and both print as
usual. Lines outside a request still print. It needs `telemetry` on. A line is
cut at 4,000 characters and a span keeps its first 100.

To find a line: words that must all appear, `"an exact phrase"`, `-word` to
leave lines out, and `level:`, `route:`, `action:`, `method:`, and `trace:` for
one part of a line (any can be negated with `-`). Matches are marked, the level
buttons count what matches, 5m / 15m / 1h limit how far back to look, and Pause
holds the list still. Point at a line to copy it, show only its request, or
open it.

The Requests tab is one log of every request the app has served. Choose Live
for this run, or a range from 1 hour to 90 days to look back, or Custom to name
a start and an end to the second (or Today, Yesterday, the last 15 minutes). Four
cards show
the request count, error rate, median duration, and slowest 5% of what the list
shows, so they follow the range and filters. A timeline below them shows volume
(drag across it to zoom), filters on the left show a count
beside each value (outcome, service, method, route, and speed, with several
values per filter allowed), and the search box matches routes, paths, actions,
and failure messages. Each row shows the time, method and status, route, how long
it took, and the action that handled it or why it failed. Open a row to see the
request beside the list: when it started, what it ran, how it ended, the error
and stack trace if it failed, and the waterfall of its spans. Export saves the
filtered requests as CSV.

Finished requests are kept on disk between runs for 90 days by default, in
`.brick/telemetry.sqlite` in the project folder. `.brick/` ignores itself, so it
is never committed. History uses `bun:sqlite` under Bun and `node:sqlite` under
Node (22.5 or later); without either, the dashboard runs with live data only and
says so. Requests cut off by a restart are not kept. It keeps at most 100,000
requests, dropping the oldest first. Stored requests include their spans, which
carry SQL statement text, error messages, and stack traces, so treat `.brick/` as
you would your logs. Use `--history-days 0` to keep nothing, or
delete `.brick/` to start over.

Requests that send a W3C `traceparent` header join the caller's trace, and the
dashboard shows them under that trace id.

`brick dev` also serves `/mcp` on the dashboard's port, an MCP endpoint
for coding agents (Claude Code, Cursor, Codex) with five read-only tools: `summary`, `list_requests`,
`get_trace`, `list_errors` and `app_overview`. It prints the address on start;
connect with `claude mcp add --transport http brick http://127.0.0.1:9400/mcp`.
Those five only read, and a request from another origin is refused. Tools of
the app's own marked `dashboard: true` (`service.tool`, or a plugin's) are
listed beside them; one without `readOnlyHint: true` can change data and is
advertised as destructive. `list_errors` reads only the failures held in memory
since the process started (the last 200), even when history is kept on disk;
older ones are found with `list_requests` and `outcome: "server"`. What an agent reads (paths, errors, SQL text, log lines) goes to its
model provider.

### Monitoring dashboard for production

`brick start` serves a read-only dashboard of the running app when the app,
default-exported from the entry, sets the `dashboard` option:

```ts
export default brick({
  services,
  dashboard: {
    port: 9400, // its own port, apart from the app's
    host: "0.0.0.0", // 127.0.0.1 unless set
    auth: { token: process.env.DASHBOARD_TOKEN, authorize },
    historyDays: 0, // finished requests kept on disk, in .brick/
  },
});
```

It listens on a port of its own, so it can be kept private or mounted at another
address, and it answers while the app's routes do not. It shows Requests, Logs,
Errors, Overview, and Reloads; there is no restart, API proxy, APIs, or Docs, and
OpenAPI documents are not served. `dashboard: { inspector: true }` adds
Schedules and Workflows, where only a signed-in user can change anything.
`dashboard: { mcp: true }` serves `/mcp` for coding agents behind the same
`auth` (agents send `Authorization: Bearer <token>`); it is off otherwise. The
dashboard's own tools only read; the app's `dashboard: true` tools that can
change data are offered only to a signed-in user (`authorize` returned
`{ user }`).
Setting it turns `telemetry` on, and from then `ctx.logger` and `console`
lines written during a request go to the dashboard and not to the container's
console.

Beyond loopback, access control is required, and `brick start` will not run the
dashboard without it. `auth.token` is a secret (or several, to rotate), at least
16 characters: a browser asks for it in its sign-in prompt (any user name, the
secret as the password), and monitors send `Authorization: Bearer <secret>`.
`auth.authorize(request)` is your own check, for the auth the app already has
(Better Auth, Clerk, a header from a proxy): it gets a standard `Request` without
a body and returns `true`, `false`, `{ user }` for someone signed in, or a
`Response` such as a redirect to a login page; a throw or five seconds without
an answer refuses the request with 503. A request passes with a valid token or
when `authorize` allows it.

`GET /_health` on the dashboard's port needs no sign-in: 200 while the app answers
its own `/_health`, 503 when it does not, for uptime monitors. Responses are
`no-store`, with a strict Content-Security-Policy and `X-Frame-Options: DENY`
(the Workflows page and an extension's `/app` pages may be framed by the
dashboard itself);
serve it over HTTPS. Failed sign-ins are not rate limited, so use long random
tokens. The dashboard runs in the app's process: it survives errors in handlers,
not the process dying. `brick dev` has its own dashboard and ignores the option.

The dashboard binds to `127.0.0.1` and rejects requests whose `Host` header is
not local. It does not record request bodies or headers. Error messages, stack
traces, and SQL statement text are visible to anyone who can open the dashboard.

## Action routes

Each action exposes exactly one route: `method` defaults to POST, and `path`
defaults to `/api/{service}/{action}` (or your configured prefix). Explicit
methods are honored regardless of the action name. A custom `path` includes
its own prefix and replaces the default path. OpenAPI describes the same
method and path, including path parameters.

To expose a read action over GET, declare `method: "GET"`. Action names beginning
with `get`, `list`, `find`, or `read` no longer add a GET alias. Custom paths no
longer expose default action aliases or an additional method. Resource CRUD
routes keep their REST methods.

## Compiler

The server compiles specialized JavaScript handlers for all resource CRUD and
custom actions at startup, pre-renders documentation, and caches OpenAPI and
architecture JSON with definition/endpoint invalidation. Health retains live
uptime and timestamps. Build a
module whose default export is a `BrickApp` into a runnable Bun server with:

```sh
brick build src/app.ts --outdir dist/brick
bun dist/brick/server.js
```

Use the same app entry as `brick gen client`. The build preserves its selected
services, prefix, docs settings, endpoints, and Elysia hooks. Keep `.listen()`
in a separate server bootstrap.

This beta branch pins Elysia `2.0.0-beta.29`. `brick build` also precompiles
Elysia's HTTP handlers with its Bun AOT plugin and removes the runtime HTTP
compiler. Use `brick build src/app.ts --no-aot` for a regular bundle.
Development and direct `brick()` calls still use runtime HTTP compilation;
both modes share the same services and Brick handlers.

## Automatic typed client with Vite

Add `brickClient` before your framework plugins. Its entry can be any module
whose default export is a `BrickApp`; construct the app without calling
`.listen()` there:

```ts
// src/api/app.ts
import { brick } from "@brickkit/core";
import { pagesService } from "./services";

export default brick({ prefix: "/v2", services: [pagesService] });
```

```ts
// vite.config.ts
import { brickClient } from "@brickkit/cli/vite";

export default defineConfig({
  plugins: [
    brickClient({ entry: "./src/api/app.ts" }),
    // TanStack Start, React, or other framework plugins
  ],
});
```

Vite creates `_brick/contract.ts` before loading the frontend and before
production builds. The prefix and selected services come from the app. Backend
edits regenerate the file; unchanged metadata does not rewrite it. There is no
separate generation command or manually maintained action list.

```ts
// src/client.ts
import { createBrickClient } from "@brickkit/core/client";
import { contract } from "../_brick/contract";

export const api = createBrickClient({
  baseUrl: "http://localhost:8085",
  contract,
});
```

The generated file contains transport types and route metadata, with no runtime
imports or backend handlers. HTTP actions are grouped by service name; dotted
action names become nested namespaces. Resources use their names at the root
and their normal REST routes. MCP-only tools are excluded. Add `_brick/` to
`.gitignore`; customize its location with `output` in the plugin options.

For TanStack Start or another embedded server, import the app from
`virtual:brick-app` in server code and forward requests to `app.fetch(request)`.
Vite tracks the entry and its dependencies for backend hot reload. Browser
imports of this server module are rejected. Add
`/// <reference types="@brickkit/cli/vite/client" />` to your Vite environment
declarations. See `examples/pages` for a complete Start integration.

During `vite dev` the plugin also serves the local dashboard at
`http://127.0.0.1:9400`. Pass `dashboard: { port }` to move it or
`dashboard: false` to turn it off. `dashboard: { historyDays }` sets how many days
of requests are kept in `.brick/` (default 90; 0 for none). The app must still
pass `telemetry: true` to `brick()`. Dev servers such as TanStack Start with Nitro run the app in a
worker, so the plugin imports a reporter into `virtual:brick-app` that sends
the worker's spans to the dashboard over loopback HTTP. History stays in the
Vite process and survives worker restarts. If the port is taken, Vite starts
without the dashboard and logs a warning. The dashboard cannot restart the app
in this mode, so it hides that button.

Generation evaluates the app entry, so the configuration it needs to construct
the app must be available in development and at build time. Keep startup jobs
and connection-opening initialization in request handlers or your server
bootstrap, outside the app definition module. Input/output types
come from JSON transport schemas; absent schemas produce `unknown`. Unresolved
schema references and non-JSON transport types fail generation explicitly.
This integration requires Vite 8; the normal server entry point has no Vite
runtime dependency. `generateClientContract(app)` exposes the source generator
for non-Vite tooling.

## Generate a typed client without Vite

Use the standalone Bun CLI with any module whose default export is a `BrickApp`:

```sh
brick gen client src/app.ts
brick gen client src/app.ts --output frontend/src/contract.ts
```

The default output is `_brick/contract.ts`, relative to the working directory.
The app's selected services and prefix determine its contents, just as with the
Vite plugin. The command evaluates the entry without calling `.listen()`; keep
the listener in a separate server bootstrap. Vite is not required or loaded.

Repeated transport type fragments are emitted as shared `BrickSchema_*` aliases
when the declarations reduce source size. Names are derived from the emitted
shape, so runtime-only constraints such as string length bounds do not prevent
sharing. Scalars stay inline, and reference targets retain document-scoped
aliases; equivalent recursive graphs in separate documents remain separate.
This applies to both standalone and Vite generation.

Run generation before your frontend's development server, build, and type check,
and rerun after changing backend definitions. You can add a package script:

```json
{
  "scripts": {
    "gen:client": "brick gen client src/app.ts"
  }
}
```

Import the generated `contract` with `createBrickClient({ baseUrl, contract })`
as shown above. The command creates parent directories and leaves an unchanged
contract file untouched. Add the generated output to `.gitignore`.

## Coordinate backend and frontend development

For a separate frontend tool, generate the contract before its compiler starts:

```sh
brick dev src/app.ts --client frontend/src/contract.ts --frontend 'bun run --cwd frontend dev'
```

The app entry must default-export a BrickApp without calling `.listen()`.
Brick generates the initial contract, starts the frontend command once, and
restarts the backend on edits. Imported local dependencies outside the entry's
directory are watched too. Changes coalesce before restart; every restart evaluates
the app in a fresh process and generates the contract before starting the server.
Generation failures preserve the previous contract and print the error. The next
valid edit retries. Stopping `brick dev` stops its backend and frontend children.
When you stop `brick dev` with Ctrl-C or it reloads, the backend first finishes its in-flight event deliveries (up to 3 seconds); a second Ctrl-C exits at once.
On Windows, stopping or reloading the backend forcibly terminates it, so in-flight event deliveries may be interrupted.
`--client` also works without `--frontend` if another process owns the frontend.

For an embedded Vite app such as Pages, keep using `brickClient` in `vite.config.ts`.
Vite owns backend loading and frontend startup in that setup. It generates before
startup and production compilation, reloads the app definition graph, including imported service instances, and reports generation errors through its terminal and browser overlay.
A valid edit regenerates the contract after an error. Both integrations atomically
replace changed contracts and preserve unchanged files, so implementation-only
edits do not trigger frontend contract updates. Generated files are excluded from
regeneration triggers.

For non-Vite production builds and type checks, run `brick gen client` as the first
command in the build or typecheck script. It uses the same generator and atomic
writer as development. Keep startup jobs and listeners outside the app definition,
since all generation paths evaluate the entry.
