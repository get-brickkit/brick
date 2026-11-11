# Events example

An orders service whose writes emit events. Every generated `create`, `update`
and `delete` on `order` records an event in the same transaction as the row. The
service also declares an event catalog (`src/events.ts`) with one event,
`shipped`, and a `ship` command that emits it:

```ts
order.command("ship", {
  access: "public",
  errors: {
    NOT_PLACED: { status: 409, message: "Only a placed order can ship" },
  },
  decide: (row, _input, { error }) =>
    row.status !== "placed"
      ? error.NOT_PLACED()
      : {
          set: { status: "shipped" },
          emit: { shipped: { id: row.id, customer: row.customer } },
        },
});
```

`POST /api/orders/order/:id/ship` changes the status and records
`orders.shipped` in one transaction. `status` can't be changed with a PATCH.
Three listeners react after the commit:

| Listener   | Listens for                           | What it does                                                   |
| ---------- | ------------------------------------- | -------------------------------------------------------------- |
| `audit`    | `order.*` and `orders.events.shipped` | Writes one `audit_log` row per event, describing what changed. |
| `receipt`  | `order.create`                        | Writes a `receipt` notification.                               |
| `shipping` | `orders.events.shipped`               | Books a carrier and notifies, with a typed payload. Flaky.     |

The carrier is a stand-in API that can be told to fail, so the `shipping`
listener shows retries and the `dead` state. Every listener writes its row under
`deliveryId`, so a second run of the same delivery changes nothing.

`internalNote` can be written but not read, so it never appears in an event.

## A schedule

`src/schedules.ts` defines `unshipped-reminder`, a cron schedule that runs at
09:00 Berlin time on weekdays and writes an `unshipped` notification for every
order still waiting to ship. Its state lives in the `schedules` table
(`scheduleTable("sqlite")`), so it runs once per morning however many processes
serve the app, and a restart keeps its next due time.

```sh
bunx brick schedules src/app.ts                               # next run, last runs
bunx brick schedules src/app.ts --run unshipped-reminder      # due now
```

## Run it

From the repository root:

```sh
bun run --cwd examples/events test    # in memory, no services needed
bun run --cwd examples/events demo    # a walkthrough with a failing carrier
bun run --cwd examples/events dev     # brick dev on port 4000, reloads on changes
bun run --cwd examples/events start   # brick start
```

The database is `.data/orders.sqlite`. Set `DB_PATH` to move it. Set
`CARRIER_FAILURES=2` to make the carrier fail twice before it answers.

```sh
curl -s -X POST localhost:4000/api/orders/order -H 'content-type: application/json' \
  -d '{"customer":"ada@example.com","totalCents":4200}'
curl -s -X POST localhost:4000/api/orders/order/<id>/ship
curl -s -X POST localhost:4000/api/orders/notification/query -H 'content-type: application/json' -d '{}'
```

## Shipping as a workflow

With `REDIS_URL` set, the `shipping` handler is replaced by `fulfilment`, a
workflow (`src/workflows/fulfil-order.ts`) that the Workflow SDK runs on a Redis
world. It books the carrier in a step, waits a second with a durable timer, and
notifies the customer in a second step.

```sh
docker run -d -p 6379:6379 redis:7
REDIS_URL=redis://localhost:6379 bun run --cwd examples/events dev
REDIS_URL=redis://localhost:6379 bun run --cwd examples/events test   # the workflow tests run on both worlds
```

`brick dev` and `brick start` build the workflow bundle into
`.well-known/workflow/v1` before events start. What to look at:

- With `CARRIER_FAILURES=2`, the booking step fails twice and the SDK retries it
  after 100 ms. The delivery is not retried, and the carrier is booked once.
- Stop the server with `kill -9` while an order is shipping and start it again.
  The run resumes and the notification still arrives.
- Delivering the same event again (reset its outbox row to `pending`) does not
  start a second run.
- `test/webhook.test.ts` runs a workflow that waits on `createWebhook`: a request
  to its URL on the Brick server resumes it. The example lists `@workflow/utils`
  so the SDK finds the port the server listens on.

- `bunx brick dev src/app.ts` (without `--no-dashboard`) serves the dashboard on
  9400; its Workflows tab is the SDK's inspector (it comes with the CLI) showing each
  `fulfilOrder` run and its trace.

SQLite allows one process per database file, so this example delivers events in
the same process that serves requests. With PostgreSQL, run the API with
`events: { dispatch: false }` and deliver from other processes.
