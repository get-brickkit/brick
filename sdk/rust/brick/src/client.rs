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

/// How much of a callee's reply `call` reads.
const MAX_REPLY: usize = 16 << 20;

/// The client for service calls. A call that gets no answer in 30s fails as SERVICE_UNAVAILABLE.
pub(crate) fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            // A redirect elsewhere would carry the internal token there.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let first = &attempt.previous()[0];
                if attempt.url().origin() != first.origin() || attempt.previous().len() > 10 {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .expect("http client")
    })
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
    let mut response = request.send().await.map_err(|_| unreachable())?;
    let status = response.status();
    // Capped, as in Go.
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unreachable())? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_REPLY {
            return Err(Error::new(
                "INTERNAL_SERVER_ERROR",
                502,
                &format!("Reply from '{service}' is over {MAX_REPLY} bytes"),
            ));
        }
    }
    if !status.is_success() {
        return Err(match serde_json::from_slice::<Error>(&body) {
            // Only an error status from the body; otherwise the HTTP one.
            Ok(mut e) => {
                if !(400..600).contains(&e.status) {
                    e.status = status.as_u16();
                }
                e
            }
            Err(_) => Error::new(
                "INTERNAL_SERVER_ERROR",
                status.as_u16(),
                status.canonical_reason().unwrap_or(status.as_str()),
            ),
        });
    }
    Ok(serde_json::from_slice(&body)?)
}
