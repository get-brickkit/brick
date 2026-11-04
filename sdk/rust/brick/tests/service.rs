use axum::body::{Body, to_bytes};
use axum::http::Request;
use brickkit::{Ctx, Error, ErrorDef, Service, kebab};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tower::ServiceExt;

const GONE: ErrorDef = ErrorDef::new("GONE", 410, "It is gone");

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
struct Hello {
    hello: String,
    caller: Option<String>,
    user: Option<serde_json::Value>,
}

fn service() -> Service {
    Service::new("people")
        .error(GONE)
        .action("greetPerson", |ctx: Ctx, input: Person| async move {
            if input.name == "gone" {
                return Err(GONE.with_details(serde_json::json!({ "id": 7 })));
            }
            Ok::<_, Error>(Hello {
                hello: input.name,
                caller: ctx.caller().map(String::from),
                user: ctx.user(),
            })
        })
        .action("me", |ctx: Ctx, _input: serde_json::Value| async move {
            ctx.require_user::<serde_json::Value>()
        })
}

/// One request to the service, without the internal token unless `headers` has it.
async fn send(method: &str, path: &str, headers: &[(&str, &str)]) -> axum::response::Response {
    // SAFETY: tests in this file set the same values.
    unsafe {
        std::env::set_var("BRICK_INTERNAL_TOKEN", "secret");
        std::env::set_var(
            "BRICK_CORS",
            r#"{"origin":["https://app.test"],"credentials":true}"#,
        );
    }
    let mut request = Request::builder().method(method).uri(path);
    for (k, v) in headers {
        request = request.header(*k, *v);
    }
    service()
        .router()
        .oneshot(request.body(Body::from("{}")).unwrap())
        .await
        .unwrap()
}

async fn text(response: axum::response::Response) -> (u16, String) {
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

const UNAUTHORIZED: &str = r#"{"name":"ActionExecutionError","code":"UNAUTHORIZED","message":"Access denied for action 'me'","status":401,"requestId":"r1"}"#;

#[tokio::test]
async fn trusts_x_brick_headers_only_with_the_token() {
    let spoofed = [
        ("x-request-id", "r1"),
        ("x-brick-user", "eyJpZCI6Im1hbGxvcnkifQ=="),
        ("x-brick-caller", "admin"),
    ];
    let (status, body) = text(send("POST", "/api/people/me", &spoofed).await).await;
    assert_eq!((status, body.as_str()), (401, UNAUTHORIZED));
    let mut with_token = spoofed.to_vec();
    with_token.push(("x-brick-internal", "secret"));
    let (status, body) = text(send("POST", "/me", &with_token).await).await;
    assert_eq!((status, body.as_str()), (200, r#"{"id":"mallory"}"#));
}

#[tokio::test]
async fn does_the_gateway_s_work() {
    let response = send(
        "POST",
        "/api/people/me",
        &[
            (
                "traceparent",
                "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
            ),
            ("origin", "https://app.test"),
        ],
    )
    .await;
    let h = response.headers();
    assert!(h["x-request-id"].to_str().unwrap().starts_with("req_"));
    assert_eq!(h["x-trace-id"], "0af7651916cd43dd8448eb211c80319c");
    assert_eq!(h["access-control-allow-origin"], "https://app.test");
    assert_eq!(h["access-control-allow-credentials"], "true");
    let preflight = [
        ("origin", "https://app.test"),
        ("access-control-request-method", "POST"),
        (
            "access-control-request-headers",
            "authorization, content-type",
        ),
    ];
    let response = send("OPTIONS", "/api/people/me", &preflight).await;
    assert_eq!(response.status().as_u16(), 204);
    assert_eq!(
        response.headers()["access-control-allow-headers"],
        "authorization, content-type"
    );
    let evil = [("origin", "https://evil.test"), preflight[1]];
    let response = send("OPTIONS", "/api/people/me", &evil).await;
    assert!(
        !response
            .headers()
            .contains_key("access-control-allow-origin")
    );
}

async fn call(body: &str, headers: &[(&str, &str)]) -> (u16, String) {
    // SAFETY: tests in this file set the same values.
    unsafe {
        std::env::set_var("BRICK_INTERNAL_TOKEN", "secret");
        std::env::set_var(
            "BRICK_CORS",
            r#"{"origin":["https://app.test"],"credentials":true}"#,
        );
    }
    let mut request = Request::post("/greet-person");
    if !headers.iter().any(|(k, _)| *k == "x-brick-internal") {
        request = request.header("x-brick-internal", "secret");
    }
    for (k, v) in headers {
        request = request.header(*k, *v);
    }
    let response = service()
        .router()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    (status, String::from_utf8(bytes.to_vec()).unwrap())
}

#[tokio::test]
async fn validation_matches_typebox() {
    let (status, body) = call(
        r#"{"name":"ab","age":200,"role":"nope"}"#,
        &[("x-request-id", "r1")],
    )
    .await;
    assert_eq!(status, 400);
    assert_eq!(
        body,
        r#"{"name":"ValidationError","code":"VALIDATION_FAILED","message":"Validation failed for action 'greetPerson' input","status":400,"errors":[{"path":"/name","message":"Expected string length greater or equal to 3","value":"ab"},{"path":"/age","message":"Expected integer to be less or equal to 150","value":200},{"path":"/role","message":"Expected union value","value":"nope"}],"requestId":"r1"}"#
    );
    let (_, body) = call("{}", &[("x-request-id", "r0")]).await;
    assert_eq!(
        body,
        r#"{"name":"ValidationError","code":"VALIDATION_FAILED","message":"Validation failed for action 'greetPerson' input","status":400,"errors":[{"path":"/name","message":"Expected required property"},{"path":"/age","message":"Expected required property"},{"path":"/role","message":"Expected required property"},{"path":"/name","message":"Expected string"},{"path":"/age","message":"Expected integer"},{"path":"/role","message":"Expected union value"}],"requestId":"r0"}"#
    );
}

#[tokio::test]
async fn typed_error_and_context() {
    let (status, body) = call(
        r#"{"name":"gone","age":1,"role":"user"}"#,
        &[("x-request-id", "r2")],
    )
    .await;
    assert_eq!(status, 410);
    assert_eq!(
        body,
        r#"{"name":"ActionExecutionError","code":"GONE","message":"It is gone","status":410,"details":{"id":7},"requestId":"r2"}"#
    );
    let (_, body) = call(
        r#"{"name":"alice","age":1,"role":"user"}"#,
        &[
            ("x-brick-caller", "orders"),
            ("x-brick-user", "eyJpZCI6ImEifQ=="),
        ],
    )
    .await;
    assert_eq!(
        body,
        r#"{"hello":"alice","caller":"orders","user":{"id":"a"}}"#
    );
}

#[tokio::test]
async fn rejects_without_token() {
    let (status, _) = call("{}", &[("x-brick-internal", "wrong")]).await;
    assert_eq!(status, 401);
}

#[test]
fn manifest_lists_actions_and_errors() {
    let manifest = service().manifest().to_string();
    assert!(
        manifest.contains(r#""name":"people","language":"rust""#),
        "{manifest}"
    );
    assert!(
        manifest.contains(r#""required":["name","age","role"]"#),
        "{manifest}"
    );
    assert!(
        manifest.contains(r#""errors":{"GONE":{"status":410,"message":"It is gone"}}"#),
        "{manifest}"
    );
}

#[test]
fn kebab_matches_typescript() {
    assert_eq!(kebab("chargeCard"), "charge-card");
    assert_eq!(kebab("importCSV"), "import-csv");
    assert_eq!(kebab("page.list"), "page.list");
}
