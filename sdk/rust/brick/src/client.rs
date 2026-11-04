use crate::{Ctx, Error, SERVICE_NAME, kebab};
use base64::Engine;
use serde::{Serialize, de::DeserializeOwned};
use std::{collections::HashMap, sync::OnceLock};

fn urls() -> &'static HashMap<String, String> {
    static URLS: OnceLock<HashMap<String, String>> = OnceLock::new();
    URLS.get_or_init(|| {
        std::env::var("BRICK_SERVICES")
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    })
}

pub(crate) fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Run another service's action directly (TypeScript, Go or Rust), not through
/// the gateway, forwarding the user, request id and trace of `ctx` with this
/// service as the caller. The generated client calls it. A failure is an
/// [`Error`] with the callee's code, status and details.
pub async fn call<I: Serialize, O: DeserializeOwned>(
    ctx: &Ctx,
    service: &str,
    action: &str,
    input: &I,
) -> Result<O, Error> {
    let base = urls().get(service).ok_or_else(|| {
        Error::new(
            "SERVICE_UNAVAILABLE",
            503,
            &format!("Service '{service}' is not in BRICK_SERVICES"),
        )
    })?;
    let mut request = http()
        .post(format!("{base}/{}", kebab(action)))
        .header("content-type", "application/json")
        .header(
            "x-brick-internal",
            std::env::var("BRICK_INTERNAL_TOKEN").unwrap_or_default(),
        )
        .header(
            "x-brick-caller",
            SERVICE_NAME.get().map(String::as_str).unwrap_or_default(),
        )
        .body(serde_json::to_vec(input)?);
    let user = ctx
        .user
        .as_ref()
        .map(|u| base64::engine::general_purpose::STANDARD.encode(u.to_string()));
    for (name, value) in [
        ("x-request-id", Some(&ctx.request_id)),
        ("x-trace-id", Some(&ctx.trace_id)),
        ("traceparent", Some(&ctx.traceparent)),
        ("x-brick-user", user.as_ref()),
        ("x-brick-tenant", ctx.tenant_id.as_ref()),
    ] {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            request = request.header(name, value);
        }
    }
    let unreachable = || {
        Error::new(
            "SERVICE_UNAVAILABLE",
            503,
            &format!("Service '{service}' is not reachable"),
        )
    };
    let response = request.send().await.map_err(|_| unreachable())?;
    let status = response.status();
    let body = response.bytes().await.map_err(|_| unreachable())?;
    if !status.is_success() {
        return Err(
            serde_json::from_slice::<Error>(&body).unwrap_or_else(|_| Error {
                status: status.as_u16(),
                ..Error::new("INTERNAL_SERVER_ERROR", status.as_u16(), status.as_str())
            }),
        );
    }
    Ok(serde_json::from_slice(&body)?)
}
