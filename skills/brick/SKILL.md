---
name: brick
description: Build and modify TypeScript backends with Brick on Bun, including services, actions, resources, CRUD, typed clients, and MCP tools. Use when a project uses @brickkit/core, @brickkit/crud, or @brickkit/cli.
---

# Brick projects

Read the project's package scripts and existing service definitions before changing code. Use the installed Brick version as the API reference.

## Find documentation

Fetch `https://www.brickkit.dev/llms.txt` and follow the relevant markdown links. Use `https://www.brickkit.dev/llms-full.txt` when you need the complete reference. Each docs page also has a `.md` URL, and accepts `Accept: text/markdown`.

Use `/docs/quickstart.md` for a runnable starter and `/docs/tutorial.md` for an end-to-end REST API. For existing projects, fetch the relevant guides:

- `/docs/services-and-actions.md`, `/docs/context.md`, and `/docs/validation-and-errors.md` for actions and execution context.
- `/docs/routes.md` for the URL scheme and migrating v0.10 paths.
- `/docs/resources.md`, `/docs/access-control.md`, `/docs/hooks.md`, and `/docs/relations.md` for CRUD and database changes.
- `/docs/typed-client.md` for browser clients and `/docs/tools-and-mcp.md` for MCP tools.
- `/docs/reference/cheatsheet.md` for symbols and `/docs/brick-cli/info.md` for architecture exports.

If the hosted docs differ from the installed version, inspect the package types and source.

## Follow Brick's definitions

- Use `defineService` and its `.action()`, `.resource()`, and `.tool()` methods. Define input and output schemas with `t` from `@brickkit/core`.
- Keep database tables in the service's database definition. Use `@brickkit/crud` for generated resource operations where the project already uses it. CRUD requires an explicit access policy; preserve its field and operation permissions.
- Put authorization in the action or tool definition and resource access rules. Use the project's context resolver for identity.
- Import definition modules before compiling the app, generating contracts, or exporting the global registry. Registration occurs when modules load.
- Tools register separately from HTTP actions. Set `http: true` or attach a tool with `.action(tool)` only when HTTP access is required.
- Use the generated typed-client contract for browser calls. Keep server modules out of browser imports.
- For work on one row or one collection of a resource that CRUD doesn't cover, use `resource.action()`. `record: true` adds `id` from the path and passes the loaded `row` to `execute`; it answers 404 for rows the caller can't see. Every record action and command needs `access` (`"public"` or `{ scope }`).
- For a state change with rules that emits events, use `resource.command(name, { access, input, errors, load, decide })`. `decide(row, input, { error })` is pure: return `error.CODE()` to reject, or `{ set, children, emit }`. Brick writes the change and records `emit` events in one transaction. Declare events in `defineService(name, { events: { shipped: t.Object(...) } })` and listen with `defineListener({ name, on: service.events.shipped, run })`; catalog events are named `<service>.<event>` on the wire.
- For background jobs, use `defineSchedule({ name, cron, timeZone, run })` (fixed wall-clock times) or `defineSchedule({ name, every: "6h", run })` (a period after the last success), passed in `brick({ events: { schedules } })`, with `scheduleTable("postgres")` in one database. Never hand-write `setInterval` jobs: a schedule runs once per due time across processes, survives restarts, and retries failures.

## Routes

Every route follows the owner tree, with URL segments in kebab-case of the declared names. For service `orders` and resource `order`:

- Service action `getSummary`: `POST /api/orders/get-summary`, client `api.orders.getSummary()`.
- CRUD: `POST /api/orders/order/query` (list), `GET|PATCH|DELETE /api/orders/order/:id`, `POST /api/orders/order` (create), `/find-one`, `/count`, `/exists`, `/bulk-*`. Client `api.orders.order.list()`.
- Resource action `importCsv`: `POST /api/orders/order/import-csv`. Record action `archive`: `POST /api/orders/order/:id/archive`, client `api.orders.order.archive({ id, reason })`.
- Socket `live`: `GET /api/orders/live`, client `api.orders.live.connect()`.

For a field that holds any JSON value, use `t.Json()`: it works in actions and sockets alike. Socket schemas reject `t.Unsafe`, `t.Any` and `t.Unknown`.

An explicit `path` on an action, resource action or socket is relative to its owner (`path: "/:id/summary"` on `orders` mounts at `/api/orders/:id/summary`). Never repeat the prefix. Only raw `endpoints`, `app.endpoint()` and webhooks take absolute paths. Plugin route scopes `app`, `service` and `resource` mount under `/api`, `/api/<service>` and `/api/<service>/<resource>`.

Names that share a URL segment in one service, or a resource action named after a CRUD segment or action (`query`, `count`, `findOne`, `list`, ...), fail at startup.

When upgrading from v0.10, regenerate the client contract, change `api.<resource>.*` calls to `api.<service>.<resource>.*`, and rewrite absolute action paths relative to the owner. `legacyRoutes` was removed in v0.12: the old paths are no longer served, so don't add it.

## Inspect the application

A running Brick app exposes its registered architecture at `GET /_brick/services`. For an offline export, run `bunx brick info <entry>` with the project's app entry file. The CLI loads definitions before exporting mounted routes and resource access policies. Service options are included, so review configuration values before sharing the JSON.

An app can expose MCP through `createMcpRegistry` and `createMcpHandler`. Read its tool definitions and auth layer before calling tools. The documentation site does not provide a hosted MCP server.

Run the project's type checks and relevant tests after edits. Follow its scripts for schema migrations and contract generation.
