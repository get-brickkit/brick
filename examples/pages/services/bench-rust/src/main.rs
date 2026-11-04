//! The benchmark's Rust service (see ../../bench/run.ts): echo, validate and
//! db, the same three APIs as the TS bench service, and me (test/jwt.test.ts).
mod brick_client;

use brick::{Ctx, Error, ErrorDef, Service};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;

const NOT_FOUND: ErrorDef = ErrorDef::new("NOT_FOUND", 404, "No such item");

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Role {
    Admin,
    Editor,
    Viewer,
}

#[derive(Serialize, Deserialize, JsonSchema)]
struct Person {
    #[schemars(length(min = 3, max = 32))]
    name: String,
    #[schemars(range(min = 0, max = 150))]
    age: i64,
    role: Role,
}

#[derive(Deserialize, JsonSchema)]
struct Empty {}

#[derive(Deserialize, JsonSchema)]
struct ItemId {
    #[schemars(range(min = 1))]
    id: i32,
}

#[derive(Serialize, JsonSchema, sqlx::FromRow)]
struct Item {
    id: i32,
    name: String,
    value: i32,
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://localhost:5432/drafton".into());
    // The same pool size as the TS and Go services; connects on first use.
    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect_lazy(&url)
        .expect("valid DATABASE_URL");

    Service::new("benchRust")
        .error(NOT_FOUND)
        .action("echo", |_ctx: Ctx, input: Value| async move {
            Ok::<_, Error>(input)
        })
        .action("validate", |_ctx: Ctx, input: Person| async move {
            Ok::<_, Error>(input)
        })
        .action("db", move |_ctx: Ctx, input: ItemId| {
            let pool = pool.clone();
            async move {
                sqlx::query_as::<_, Item>("SELECT id, name, value FROM bench_items WHERE id = $1")
                    .bind(input.id)
                    .fetch_optional(&pool)
                    .await?
                    .ok_or_else(|| NOT_FOUND.err())
            }
        })
        .action("me", |ctx: Ctx, _input: Empty| async move {
            ctx.require_user::<Value>()
        })
        .serve()
        .await
}
