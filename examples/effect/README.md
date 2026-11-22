# Effect example

A small uptime checker that writes its logic with [Effect](https://effect.website) (effect@4) and lets Brick run it. Nothing in Brick is written in Effect: each callback below returns an Effect where it would return a value or a Promise.

| Callback                         | What it shows                                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check` action `execute`         | `Effect.gen` over a `Probe` service, `Effect.catchTag` to record a failed probe as a down check, `error.NOT_FOUND()` inside the Effect still answers 404 |
| `status` action `execute`        | a plain `Effect.gen` with no services                                                                                                                    |
| service `context`                | reads the `x-admin` header in `Effect.sync`                                                                                                              |
| `clearChecks` action `authorize` | returns `Effect<boolean>`: 401 without `x-admin: 1`                                                                                                      |
| CRUD `url` field `scrub`         | strips credentials, query string and fragment, so tokens never come back on read                                                                         |
| `check-all` schedule `run`       | `Effect.forEach` over every monitor, four at a time                                                                                                      |

`Probe` is an Effect service. The app provides it once, through `Effect.provide(effect, probeLayer)`, so every Effect handed to Brick needs nothing more. The live layer uses `fetch` with a timeout and two retries; the tests pass a fake layer and use no network.

## Run

```sh
bun install
bun run dev
```

```sh
curl -s localhost:4000/api/uptime/monitor -H 'content-type: application/json' \
  -d '{"name":"Example","url":"https://example.com/?token=secret"}'
curl -s localhost:4000/api/uptime/check -H 'content-type: application/json' -d '{"id":"<id>"}'
```

```sh
bun run test
```

This is an example, not a hosted service: anyone who can reach it can make the server fetch any URL, including internal addresses. Put it behind auth and refuse private addresses before exposing it.
