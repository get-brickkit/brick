//! **Experimental.** Polyglot services are new in Brick 0.13; the API, the
//! wire format and the environment variables may change in any release.
//!
//! Write Brick services in Rust. A Rust service runs as its own process next to
//! the Bun app. Browsers reach it directly, through a reverse proxy in
//! production or the Bun gateway in `brick dev`: it serves
//! `/api/<service>/<action>` (and `/<action>`), verifies the caller's Better
//! Auth JWT itself, and adds request ids, the W3C trace and CORS. Other
//! services call it with the internal token, which alone makes their
//! `x-brick-*` headers (caller, user, tenant) trusted.
//!
//! ```no_run
//! use brickkit::{Ctx, Error, ErrorDef, Service};
//! use schemars::JsonSchema;
//! use serde::{Deserialize, Serialize};
//!
//! const NO_FUNDS: ErrorDef = ErrorDef::new("INSUFFICIENT_FUNDS", 402, "Not enough funds");
//!
//! #[derive(Deserialize, JsonSchema)]
//! struct Charge { amount: u32 }
//! #[derive(Serialize, JsonSchema)]
//! struct Receipt { id: String }
//!
//! #[tokio::main]
//! async fn main() {
//!     Service::new("billing")
//!         .error(NO_FUNDS)
//!         .action("charge", |_ctx: Ctx, input: Charge| async move {
//!             if input.amount > 100 { return Err(NO_FUNDS.err()); }
//!             Ok(Receipt { id: "r1".into() })
//!         })
//!         .serve()
//!         .await
//!         .unwrap();
//! }
//! ```

mod auth;
mod client;
mod http;
mod validate;

pub use client::call;
pub use validate::Issue;

use axum::{
    Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State, rejection::BytesRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::Engine;
use schemars::{JsonSchema, generate::SchemaSettings};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, OnceLock},
};

static SERVICE_NAME: OnceLock<String> = OnceLock::new();

/// A Brick error envelope, identical across TypeScript, Go and Rust:
/// `{ name, code, message, status, details?, errors?, requestId }`.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Error {
    pub name: String,
    pub code: String,
    pub message: String,
    pub status: u16,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub details: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub errors: Option<Vec<Issue>>,
    #[serde(rename = "requestId", default)]
    pub request_id: String,
}

impl Error {
    /// An error with this code, status and message.
    pub fn new(code: &str, status: u16, message: &str) -> Self {
        Error {
            name: "ActionExecutionError".into(),
            code: code.into(),
            message: message.into(),
            status,
            details: None,
            errors: None,
            request_id: String::new(),
        }
    }

    /// The generic 500: what an unexpected failure is answered with.
    pub fn internal() -> Self {
        Error {
            name: "InternalServerError".into(),
            ..Error::new("INTERNAL_SERVER_ERROR", 500, "Internal Server Error")
        }
    }

    /// The same error with `details`.
    pub fn details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

/// Any other failure (a database error, say) is logged and answered as a 500.
impl<E: std::error::Error> From<E> for Error {
    fn from(err: E) -> Self {
        eprintln!("[brick] unexpected error: {err}");
        Error::internal()
    }
}

/// A declared error of a service, listed in its manifest.
#[derive(Debug, Clone, Copy)]
pub struct ErrorDef {
    pub code: &'static str,
    pub status: u16,
    pub message: &'static str,
}

impl ErrorDef {
    pub const fn new(code: &'static str, status: u16, message: &'static str) -> Self {
        ErrorDef {
            code,
            status,
            message,
        }
    }

    /// The error with its default message.
    pub fn err(&self) -> Error {
        Error::new(self.code, self.status, self.message)
    }

    /// The error with `details`.
    pub fn with_details(&self, details: Value) -> Error {
        self.err().details(details)
    }
}

/// The context of one action call: its ids, and its user from the caller's
/// JWT, or, for a call from another service, the caller, user and tenant that
/// service forwarded.
#[derive(Debug, Clone, Default)]
pub struct Ctx {
    action: String,
    request_id: String,
    trace_id: String,
    traceparent: String,
    caller: Option<String>,
    tenant_id: Option<String>,
    user: Option<Value>,
}

impl Ctx {
    async fn from_request(
        action: &str,
        headers: &HeaderMap,
        trust: bool,
        auth: Option<&auth::Verifier>,
    ) -> Self {
        let get = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty())
                .map(String::from)
        };
        let user = if trust {
            get("x-brick-user")
                .and_then(|u| base64::engine::general_purpose::STANDARD.decode(u).ok())
                .and_then(|raw| serde_json::from_slice(&raw).ok())
        } else if let Some(auth) = auth {
            auth.user(headers).await
        } else {
            None
        };
        Ctx {
            action: action.into(),
            request_id: get("x-request-id").unwrap_or_default(),
            trace_id: get("x-trace-id").unwrap_or_default(),
            traceparent: get("traceparent").unwrap_or_default(),
            caller: get("x-brick-caller").filter(|_| trust),
            tenant_id: get("x-brick-tenant").filter(|_| trust),
            user,
        }
    }

    /// The id of the public request this call is part of.
    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    /// The id of the trace this call is part of.
    pub fn trace_id(&self) -> &str {
        &self.trace_id
    }

    /// The service that called this action, or `None` for a call from outside.
    pub fn caller(&self) -> Option<&str> {
        self.caller.as_deref()
    }

    /// The tenant the calling service forwarded, if any.
    pub fn tenant_id(&self) -> Option<&str> {
        self.tenant_id.as_deref()
    }

    /// The caller's user decoded into `T` (the claims of a valid JWT, or the
    /// user a calling service forwarded), or `None` without one.
    pub fn user<T: DeserializeOwned>(&self) -> Option<T> {
        serde_json::from_value(self.user.clone()?).ok()
    }

    /// The user, or the 401 a TS action's `authorize` gives without one:
    /// `let user: User = ctx.require_user()?;`
    // The same Error every action returns, so `?` works in a handler.
    #[allow(clippy::result_large_err)]
    pub fn require_user<T: DeserializeOwned>(&self) -> Result<T, Error> {
        let unauthorized = || {
            Error::new(
                "UNAUTHORIZED",
                401,
                &format!("Access denied for action '{}'", self.action),
            )
        };
        let user = self.user.clone().ok_or_else(unauthorized)?;
        serde_json::from_value(user).map_err(|_| unauthorized())
    }
}

type Handler = Arc<
    dyn Fn(Ctx, Value) -> Pin<Box<dyn Future<Output = Result<Value, Error>> + Send>> + Send + Sync,
>;

struct ActionEntry {
    name: String,
    input: Value,
    output: Value,
    validator: jsonschema::Validator,
    handler: Handler,
    auth: Option<Arc<auth::Verifier>>,
}

/// A Rust Brick service: a name, its actions and its declared errors.
pub struct Service {
    name: String,
    actions: Vec<Arc<ActionEntry>>,
    errors: Vec<ErrorDef>,
    auth: Option<Arc<auth::Verifier>>,
}

fn schema_of<T: JsonSchema>() -> Value {
    let mut schema = SchemaSettings::draft2020_12()
        .with(|s| s.inline_subschemas = true)
        .into_generator()
        .into_root_schema_for::<T>()
        .to_value();
    if let Some(map) = schema.as_object_mut() {
        map.remove("$schema");
    }
    schema
}

impl Service {
    /// Start a service. Its name must match the `remoteService` name in the Bun app.
    pub fn new(name: &str) -> Self {
        let _ = SERVICE_NAME.set(name.to_string());
        Service {
            name: name.into(),
            actions: Vec::new(),
            errors: Vec::new(),
            auth: auth::Verifier::from_env().map(Arc::new),
        }
    }

    /// Declare an error the service's actions return.
    pub fn error(mut self, def: ErrorDef) -> Self {
        self.errors.push(def);
        self
    }

    /// Register a typed action, served at `POST /<kebab-name>`. Input and output
    /// schemas come from the types through schemars (`#[schemars(length(min = 3))]`,
    /// `range`, enums); the input is validated before `f` runs, with the same
    /// error envelope a TypeScript action gives.
    pub fn action<I, O, F, Fut>(mut self, name: &str, f: F) -> Self
    where
        I: DeserializeOwned + JsonSchema + Send + 'static,
        O: Serialize + JsonSchema + 'static,
        F: Fn(Ctx, I) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<O, Error>> + Send + 'static,
    {
        // Same path, which axum would only report as an overlapping route.
        if let Some(other) = self.actions.iter().find(|a| kebab(&a.name) == kebab(name)) {
            panic!(
                "brick: actions \"{}\" and \"{name}\" both serve /{}",
                other.name,
                kebab(name)
            );
        }
        let input = schema_of::<I>();
        let output = schema_of::<O>();
        // Lengths are the walk's: it counts UTF-16 units as TypeBox does, jsonschema code points.
        let validator = jsonschema::validator_for(&validate::without_lengths(&input))
            .expect("valid input schema");
        let action_name = name.to_string();
        let f = Arc::new(f);
        let handler: Handler = Arc::new(move |ctx, value| {
            let f = f.clone();
            let action_name = action_name.clone();
            Box::pin(async move {
                // JSON integers may be written 30.0, which pass validation as in
                // TS but which serde won't read into an integer: retry with them as 30.
                let input = match I::deserialize(&value) {
                    Ok(input) => Ok(input),
                    Err(_) => serde_json::from_value(validate::whole_numbers(value)),
                };
                let input: I = input.map_err(|e| {
                    validate::validation_error(
                        &action_name,
                        vec![Issue {
                            path: String::new(),
                            message: e.to_string(),
                            value: None,
                        }],
                    )
                })?;
                let output = f(ctx, input).await?;
                serde_json::to_value(output).map_err(|_| Error::internal())
            })
        });
        self.actions.push(Arc::new(ActionEntry {
            name: name.into(),
            input,
            output,
            validator,
            handler,
            auth: self.auth.clone(),
        }));
        self
    }

    /// What `--brick-manifest` prints: the actions with input and output JSON
    /// Schema, and the errors.
    pub fn manifest(&self) -> Value {
        let mut errors = Map::new();
        for e in &self.errors {
            errors.insert(
                e.code.into(),
                json!({ "status": e.status, "message": e.message }),
            );
        }
        json!({
            "name": self.name,
            "language": "rust",
            "actions": self.actions.iter().map(|a| json!({
                "name": a.name, "input": a.input, "output": a.output,
            })).collect::<Vec<_>>(),
            "errors": errors,
        })
    }

    /// The service's HTTP routes, for tests or a server of your own: each
    /// action at `POST /<kebab-name>` for other services, and at
    /// `POST $BRICK_PREFIX/<kebab-service>/<kebab-name>` (prefix default
    /// `/api`) for the proxy, which then needs no path rewriting. Request ids,
    /// tracing and CORS are added around them.
    pub fn router(self) -> Router {
        let mut router = Router::new().route("/_health", get(|| async { r#"{"status":"ok"}"# }));
        // Empty counts as unset, as in Go.
        let prefix = std::env::var("BRICK_PREFIX")
            .ok()
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| "/api".into());
        let base = format!("{}/{}", prefix.trim_end_matches('/'), kebab(&self.name));
        for action in self.actions {
            let path = kebab(&action.name);
            router = router
                .route(&format!("/{path}"), post(handle).with_state(action.clone()))
                .route(&format!("{base}/{path}"), post(handle).with_state(action));
        }
        // 1 MiB, as in Go.
        http::wrap(router.layer(DefaultBodyLimit::max(1 << 20)))
    }

    /// Print the manifest and exit when run with `--brick-manifest` (or
    /// `BRICK_MANIFEST=1`). Otherwise listen on `$BRICK_HOST:$BRICK_PORT`
    /// (default `127.0.0.1`; `0.0.0.0` in a container).
    pub async fn serve(self) -> std::io::Result<()> {
        if std::env::args().any(|a| a == "--brick-manifest")
            || std::env::var("BRICK_MANIFEST").as_deref() == Ok("1")
        {
            println!("{}", self.manifest());
            std::process::exit(0);
        }
        let port: u16 = match std::env::var("BRICK_PORT") {
            Ok(port) if !port.is_empty() => port.parse().map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!("BRICK_PORT {port:?}: {e}"),
                )
            })?,
            _ => 0,
        };
        let host = std::env::var("BRICK_HOST").unwrap_or_else(|_| "127.0.0.1".into());
        let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
        eprintln!(
            "[brick] {} (rust) listening on http://{}",
            self.name,
            listener.local_addr()?
        );
        axum::serve(listener, self.router()).await
    }
}

/// Trust a request's `x-brick-*` headers only with the internal token, which
/// only other services of the app have. A request without the header is a
/// public call (its user comes from its JWT); a wrong token is refused, so a
/// misconfigured service fails loudly instead of running as nobody.
fn check_token(headers: &HeaderMap) -> (bool, bool) {
    let mut given = headers.get_all("x-brick-internal").iter();
    let Some(first) = given.next() else {
        return (true, false);
    };
    let token = std::env::var("BRICK_INTERNAL_TOKEN").unwrap_or_default();
    // Exactly one value, as the Go SDK requires.
    let single = given.next().is_none();
    let given = first.as_bytes();
    let ok = single
        && !token.is_empty()
        && given.len() == token.len()
        && given
            .iter()
            .zip(token.as_bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0;
    (ok, ok)
}

async fn handle(
    State(action): State<Arc<ActionEntry>>,
    headers: HeaderMap,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let (serve, trust) = check_token(&headers);
    if !serve {
        // Before Ctx, so a bad token costs no JWT verification.
        let request_id = headers
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();
        return error_response(
            Error::new("UNAUTHORIZED", 401, "Invalid internal token"),
            request_id,
        );
    }
    let ctx = Ctx::from_request(&action.name, &headers, trust, action.auth.as_deref()).await;
    let request_id = ctx.request_id.clone();
    if trust && ctx.user.is_none() && headers.get("x-brick-user").is_some_and(|v| !v.is_empty()) {
        // A trusted x-brick-user that isn't base64 JSON, as the TS internal call handler answers it.
        return error_response(
            Error::new("BAD_REQUEST", 400, "Invalid x-brick-user header"),
            request_id,
        );
    }
    let body = match body {
        Ok(body) => body,
        Err(rejection) if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE => {
            return error_response(
                Error::new("PAYLOAD_TOO_LARGE", 413, "Request body too large"),
                request_id,
            );
        }
        Err(_) => return error_response(Error::internal(), request_id),
    };
    let value: Value = if body.iter().all(u8::is_ascii_whitespace) {
        json!({})
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(_) => {
                return error_response(
                    Error::new("BAD_REQUEST", 400, "Invalid JSON body"),
                    request_id,
                );
            }
        }
    };
    let issues = validate::validate(&action.input, &value, &action.validator);
    if !issues.is_empty() {
        return error_response(validate::validation_error(&action.name, issues), request_id);
    }
    match (action.handler)(ctx, value).await {
        Ok(output) => (
            [(header::CONTENT_TYPE, "application/json")],
            output.to_string(),
        )
            .into_response(),
        Err(e) => error_response(e, request_id),
    }
}

fn error_response(mut e: Error, request_id: String) -> Response {
    e.request_id = request_id;
    // An error is a 4xx or 5xx; anything else is a 500, as in Go.
    let status = StatusCode::from_u16(e.status)
        .ok()
        .filter(|s| s.is_client_error() || s.is_server_error())
        .unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    e.status = status.as_u16();
    let body = serde_json::to_string(&e).unwrap_or_default();
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

/// Brick's URL segment for a name: `chargeCard` becomes `charge-card`.
pub fn kebab(name: &str) -> String {
    // Same two rules as the TypeScript kebabCase.
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::new();
    for (i, &c) in chars.iter().enumerate() {
        if c.is_ascii_uppercase() && i > 0 {
            let prev = chars[i - 1];
            let next_lower = chars.get(i + 1).is_some_and(|n| n.is_ascii_lowercase());
            if prev.is_ascii_lowercase()
                || prev.is_ascii_digit()
                || (prev.is_ascii_uppercase() && next_lower)
            {
                out.push('-');
            }
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}
