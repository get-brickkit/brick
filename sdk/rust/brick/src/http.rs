//! What the Bun gateway does for a TS request, done here for calls that reach
//! the service directly: a request id, the W3C trace, and CORS.

use axum::{
    Router,
    extract::Request,
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::{
    hash::BuildHasher,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

/// Random hex for ids. shortcut: std's per-call hasher keys, not a CSPRNG; ids
/// only need to be unique, upgrade to `getrandom` if they ever need secrecy.
fn random_hex(bytes: usize) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut out = String::new();
    while out.len() < bytes * 2 {
        let n = std::collections::hash_map::RandomState::new()
            .hash_one(COUNTER.fetch_add(1, Ordering::Relaxed));
        out.push_str(&format!("{n:016x}"));
    }
    out.truncate(bytes * 2);
    out
}

/// Keep the trace of a valid `traceparent` with a new span id for this
/// service, or start a new trace. Returns the traceparent and the trace id.
fn continue_trace(parent: Option<&str>) -> (String, String) {
    let parts: Vec<&str> = parent.unwrap_or_default().split('-').collect();
    let hex = |s: &str, len: usize| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if let [version, trace, span, flags] = parts[..]
        && hex(version, 2)
        && hex(trace, 32)
        && hex(span, 16)
        && hex(flags, 2)
        && trace.bytes().any(|b| b != b'0')
    {
        return (
            format!("00-{trace}-{}-{flags}", random_hex(8)),
            trace.into(),
        );
    }
    let trace = random_hex(16);
    (format!("00-{trace}-{}-01", random_hex(8)), trace)
}

/// `BRICK_CORS`: the origins of `brick({ cors })`, as JSON
/// `{"origin":["https://app.example.com"],"credentials":true}`.
#[derive(Deserialize, Default)]
struct Cors {
    #[serde(default)]
    origin: Vec<String>,
    #[serde(default)]
    credentials: bool,
}

fn cors_from_env() -> Option<Cors> {
    let source = std::env::var("BRICK_CORS").ok().filter(|s| !s.is_empty())?;
    serde_json::from_str(&source)
        .map_err(|e| eprintln!("[brick] ignoring BRICK_CORS: {e}"))
        .ok()
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
}

fn set(headers: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        headers.insert(name, value);
    }
}

/// The CORS headers TS's corsHook adds, or `None` when the request has no Origin.
fn cors_headers(cors: &Cors, request: &HeaderMap) -> Option<(HeaderMap, bool)> {
    let from = header(request, "origin")?;
    let mut out = HeaderMap::new();
    set(&mut out, "vary", "Origin");
    let allowed = cors.origin.iter().any(|o| o == from);
    if allowed {
        set(&mut out, "access-control-allow-origin", from);
        if cors.credentials {
            set(&mut out, "access-control-allow-credentials", "true");
        }
    }
    Some((out, allowed))
}

async fn gateway(cors: Arc<Option<Cors>>, mut request: Request, next: Next) -> Response {
    let headers = request.headers_mut();
    let request_id = header(headers, "x-request-id")
        .map(String::from)
        .unwrap_or_else(|| format!("req_{}", random_hex(8)));
    let (traceparent, trace) = continue_trace(header(headers, "traceparent"));
    let trace_id = header(headers, "x-trace-id")
        .map(String::from)
        .unwrap_or(trace);
    set(headers, "x-request-id", &request_id);
    set(headers, "x-trace-id", &trace_id);
    set(headers, "traceparent", &traceparent);
    let cors = cors.as_ref().as_ref().and_then(|c| {
        let preflight = request.method() == Method::OPTIONS
            && header(request.headers(), "access-control-request-method").is_some();
        cors_headers(c, request.headers()).map(|(mut out, allowed)| {
            if preflight && allowed {
                set(
                    &mut out,
                    "access-control-allow-methods",
                    "GET, POST, PUT, PATCH, DELETE",
                );
                if let Some(requested) = header(request.headers(), "access-control-request-headers")
                {
                    set(&mut out, "access-control-allow-headers", requested);
                }
            }
            (out, preflight)
        })
    });
    let mut response = match &cors {
        Some((_, true)) => StatusCode::NO_CONTENT.into_response(),
        _ => next.run(request).await,
    };
    let out = response.headers_mut();
    set(out, "x-request-id", &request_id);
    set(out, "x-trace-id", &trace_id);
    if let Some((cors, _)) = cors {
        out.extend(cors);
    }
    response
}

pub(crate) fn wrap(router: Router) -> Router {
    let cors = Arc::new(cors_from_env());
    router.layer(middleware::from_fn(move |request, next| {
        gateway(cors.clone(), request, next)
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn continues_a_valid_trace() {
        let (parent, trace) = continue_trace(Some(
            "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
        ));
        assert_eq!(trace, "0af7651916cd43dd8448eb211c80319c");
        assert!(parent.starts_with("00-0af7651916cd43dd8448eb211c80319c-"));
        assert!(!parent.contains("b7ad6b7169203331"));
        let (fresh, trace) = continue_trace(Some("garbage"));
        assert_eq!(trace.len(), 32);
        assert!(fresh.ends_with("-01"));
    }
}
