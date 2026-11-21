# board

[vercel/board](https://github.com/vercel/board) (channels, threads, tasks with
leases) rebuilt as one Brick service. The HTTP API, an MCP server and a CLI
all come from it.

```
src/schema.ts   tables: threads, messages, tasks
src/events.ts   the event catalog
src/board.ts    the Board model: resources, commands, views, the ReadyTasks query
src/surface.ts  BoardApi: the one surface definition (names only)
src/derive.ts   toMcp / toCli  ← example-local, see below
src/mcp.ts      MCP wiring (POST /mcp)
src/cli.ts      CLI wiring
src/app.ts      the app: Brick routes + /mcp
```

```bash
BOARD_TOKENS="julian=jtok,claude=ctok" bun src/app.ts        # :4100
BOARD_TOKEN=jtok bun src/cli.ts --help
BOARD_TOKEN=jtok bun src/cli.ts create-task --channel work --text "fix CVE-123" --labels step=fix
```

Identity is the bearer token (`BOARD_TOKENS`, actor=token pairs), on HTTP and MCP
alike. A message's author and a task's holder are the caller.

## What is Brick and what is not

|                                 |                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| HTTP API                        | Brick: `resource.action`, `resource.command`, `service.action`                         |
| Command rules, events           | Brick: `thread.command` (`label`, `scheduleFollowUp`), the event catalog, `emitEvent`  |
| MCP protocol                    | Brick: `defineTool`, `createMcpRegistry`, `createMcpHandler`                           |
| Deriving MCP tools from a model | **Not in Brick.** `toMcp` in `derive.ts` wraps each action in a `defineTool`           |
| A CLI                           | **Not in Brick.** `toCli` in `derive.ts` reads `/_brick/services` and calls the routes |
| One surface definition          | **Not in Brick.** `BoardApi` is a plain object that `derive.ts` reads                  |

## Gaps this example works around

- A command's `decide` is pure: it can't read the clock or the caller. The lease
  operations and `post` need both, so they are record actions with a conditional
  `UPDATE` (the epoch fences a claim that ended), not commands.
- `emitEvent` in an action commits in its own transaction after the write, not
  with it. Only `command` writes and events commit together.
- Actions are POST-only by default and have no read-only marker, so the views and
  the query are POST actions, and `toMcp` marks them `readOnlyHint` from the surface.

## Not built

vercel/board's task dependencies (`needs`), `block`/`fail`/`cancel`, watchers,
sync, and the claim token (the epoch is the only fence). A follow-up is stored
and emitted, but nothing fires it: Brick's schedules are cron or periodic, not
per-row timers.
