//! The Rust side of the cross-language conformance test (sdk/conformance).
mod brick_client;

use brick::{Ctx, Error, ErrorDef, Service};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const TEAPOT: ErrorDef = ErrorDef::new("TEAPOT", 418, "I am a teapot");

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum Role {
    Admin,
    User,
}

#[derive(Deserialize, JsonSchema)]
#[allow(dead_code)]
struct Person {
    #[schemars(length(min = 3, max = 20))]
    name: String,
    #[schemars(range(min = 0, max = 150))]
    age: i64,
    role: Role,
}

#[derive(Serialize, JsonSchema)]
struct Ok {
    ok: bool,
}

#[derive(Deserialize, Serialize, JsonSchema)]
struct Empty {}

#[derive(Serialize, JsonSchema)]
struct Who {
    service: String,
    user: Option<Value>,
    caller: Option<String>,
    #[serde(rename = "requestId")]
    request_id: String,
    next: Option<Value>,
}

fn who(ctx: &Ctx, next: Option<Value>) -> Who {
    Who {
        service: "confRust".into(),
        user: ctx.user(),
        caller: ctx.caller().map(String::from),
        request_id: ctx.request_id().into(),
        next,
    }
}

#[tokio::main]
async fn main() -> std::io::Result<()> {
    Service::new("confRust")
        .error(TEAPOT)
        .action("validate", |_ctx: Ctx, _input: Person| async {
            Result::<_, Error>::Ok(Ok { ok: true })
        })
        .action("fail", |_ctx: Ctx, _input: Empty| async {
            Result::<Ok, _>::Err(TEAPOT.with_details(serde_json::json!({ "kind": "tea" })))
        })
        .action("whoami", |ctx: Ctx, _input: Empty| async move {
            Result::<_, Error>::Ok(who(&ctx, None))
        })
        .action("chain", |ctx: Ctx, _input: Empty| async move {
            let next =
                brick_client::conf_ts_whoami(&ctx, &brick_client::ConfTsWhoamiInput {}).await?;
            Ok(who(&ctx, Some(serde_json::to_value(next)?)))
        })
        .serve()
        .await
}
