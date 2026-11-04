# brickkit

> **Experimental.** Polyglot services are new in Brick 0.13. The API, the
> wire format and the environment variables may change in any release
> until they are marked stable.

Write [Brick](https://github.com/get-brickkit/brick) services in Rust. A Rust
service runs as its own process next to the Brick (TypeScript on Bun) app:
it serves `POST /api/<service>/<action>`, validates its input with the same
messages as TypeBox, verifies the caller's Better Auth JWT, and calls the
app's other services (TypeScript, Go or Rust) through a generated client.

```sh
cargo add brickkit schemars serde tokio --features tokio/macros,tokio/rt-multi-thread,serde/derive
```

```rust
use brickkit::{Ctx, Error, Service};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, JsonSchema)]
struct Charge { cents: i64 }

#[derive(Serialize, JsonSchema)]
struct Receipt { id: String }

#[tokio::main]
async fn main() -> std::io::Result<()> {
    Service::new("billing")
        .action("charge", |_ctx: Ctx, input: Charge| async move {
            Ok::<_, Error>(Receipt { id: format!("r_{}", input.cents) })
        })
        .serve()
        .await
}
```

Declare it in the app with `remoteService` from `@brickkit/core`. The guide:
<https://github.com/get-brickkit/brick/blob/main/www/content/docs/(brick)/polyglot-services.mdx>.

The crate is released with the `@brickkit/*` npm packages, under the same
version. License: MIT.
