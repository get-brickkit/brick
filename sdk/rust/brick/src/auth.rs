//! Better Auth JWTs: the caller's `Authorization: Bearer` token, verified
//! against the app's JWKS, which is fetched and cached.

use axum::http::HeaderMap;
use jsonwebtoken::{DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde_json::{Map, Value};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// The registered claims: everything else in the token is the user.
const REGISTERED: [&str; 7] = ["iss", "sub", "aud", "exp", "nbf", "iat", "jti"];

pub(crate) struct Verifier {
    url: String,
    issuer: String,
    audience: String,
    /// How often a token with an unknown key id (key rotation) may refetch the JWKS.
    min_refresh: Duration,
    max_age: Duration,
    keys: Mutex<Option<(JwkSet, Instant)>>,
}

impl Verifier {
    pub(crate) fn new(url: &str, issuer: &str, audience: &str) -> Self {
        Verifier {
            url: url.into(),
            issuer: issuer.into(),
            audience: audience.into(),
            min_refresh: Duration::from_secs(10),
            max_age: Duration::from_secs(600),
            keys: Mutex::new(None),
        }
    }

    /// The verifier `BRICK_JWT_ISSUER` configures, or `None` (no JWT auth).
    /// `BRICK_JWT_AUDIENCE` defaults to the issuer and `BRICK_JWKS_URL` to
    /// `<issuer>/api/auth/jwks`, as Better Auth's jwt plugin does.
    pub(crate) fn from_env() -> Option<Self> {
        let var = |name| std::env::var(name).ok().filter(|v: &String| !v.is_empty());
        let issuer = var("BRICK_JWT_ISSUER")?;
        let audience = var("BRICK_JWT_AUDIENCE").unwrap_or_else(|| issuer.clone());
        let url = var("BRICK_JWKS_URL")
            .unwrap_or_else(|| format!("{}/api/auth/jwks", issuer.trim_end_matches('/')));
        Some(Verifier::new(&url, &issuer, &audience))
    }

    async fn fetch(&self) -> Result<JwkSet, reqwest::Error> {
        crate::client::http()
            .get(&self.url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
    }

    async fn key_set(&self, kid: &str) -> Option<JwkSet> {
        let mut keys = self.keys.lock().await;
        let stale = match &*keys {
            None => true,
            Some((set, at)) => {
                at.elapsed() > self.max_age
                    || (set.find(kid).is_none() && at.elapsed() >= self.min_refresh)
            }
        };
        if stale {
            match self.fetch().await {
                Ok(set) => *keys = Some((set, Instant::now())),
                Err(err) => {
                    eprintln!("[brick] JWKS fetch from {} failed: {err}", self.url);
                    // Keep the keys we have; try again after min_refresh.
                    if let Some((_, at)) = keys.as_mut() {
                        *at = Instant::now() - self.max_age + self.min_refresh;
                    }
                }
            }
        }
        keys.as_ref().map(|(set, _)| set.clone())
    }

    /// The user of the request's bearer JWT (its claims without the registered
    /// ones, the shape a TS service sees), or `None` without a valid token:
    /// bad signature, expired, wrong issuer or audience.
    pub(crate) async fn user(&self, headers: &HeaderMap) -> Option<Value> {
        let header = headers.get("authorization")?.to_str().ok()?;
        if header.len() < 8 || !header[..7].eq_ignore_ascii_case("bearer ") {
            return None;
        }
        let token = header[7..].trim();
        let head = decode_header(token).ok()?;
        let kid = head.kid.as_deref()?;
        let keys = self.key_set(kid).await?;
        let jwk = keys.find(kid)?;
        // The key decides the algorithm, never the token alone.
        if let Some(alg) = jwk.common.key_algorithm
            && alg.to_string().parse::<jsonwebtoken::Algorithm>().ok() != Some(head.alg)
        {
            return None;
        }
        let key = DecodingKey::from_jwk(jwk).ok()?;
        let mut validation = Validation::new(head.alg);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.audience]);
        validation.set_required_spec_claims(&["exp", "iss", "aud"]);
        validation.leeway = 30;
        let claims = decode::<Map<String, Value>>(token, &key, &validation)
            .ok()?
            .claims;
        let sub = claims.get("sub").cloned();
        let mut user: Map<String, Value> = claims
            .into_iter()
            .filter(|(k, _)| !REGISTERED.contains(&k.as_str()))
            .collect();
        if let (false, Some(sub)) = (user.contains_key("id"), sub) {
            user.insert("id".into(), sub);
        }
        Some(Value::Object(user))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, Router, routing::get};
    use base64::Engine;
    use ed25519_dalek::{SigningKey, pkcs8::EncodePrivateKey};
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use serde_json::json;
    use std::sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicUsize, Ordering},
    };
    use std::time::{SystemTime, UNIX_EPOCH};

    const ISSUER: &str = "http://app.test";

    struct Key {
        kid: &'static str,
        signing: SigningKey,
    }

    impl Key {
        fn new(kid: &'static str, seed: u8) -> Self {
            Key {
                kid,
                signing: SigningKey::from_bytes(&[seed; 32]),
            }
        }
        /// The public key as Better Auth's JWKS lists it.
        fn jwk(&self) -> Value {
            let x = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(self.signing.verifying_key().as_bytes());
            json!({ "kty": "OKP", "crv": "Ed25519", "x": x, "kid": self.kid, "alg": "EdDSA" })
        }
        fn sign(&self, claims: Value) -> String {
            let der = self.signing.to_pkcs8_der().unwrap();
            let mut header = Header::new(Algorithm::EdDSA);
            header.kid = Some(self.kid.into());
            encode(&header, &claims, &EncodingKey::from_ed_der(der.as_bytes())).unwrap()
        }
    }

    fn claims(edit: impl FnOnce(&mut Map<String, Value>)) -> Value {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut c = json!({
            "iat": now, "exp": now + 900, "iss": ISSUER, "aud": ISSUER, "sub": "u1",
            "id": "u1", "email": "a@example.com", "name": "Ann",
        });
        edit(c.as_object_mut().unwrap());
        c
    }

    /// A JWKS endpoint whose keys can be swapped (rotation), counting fetches.
    async fn jwks(keys: Vec<Value>) -> (String, Arc<StdMutex<Vec<Value>>>, Arc<AtomicUsize>) {
        let keys = Arc::new(StdMutex::new(keys));
        let calls = Arc::new(AtomicUsize::new(0));
        let (k, c) = (keys.clone(), calls.clone());
        let app = Router::new().route(
            "/jwks",
            get(move || {
                c.fetch_add(1, Ordering::SeqCst);
                let keys = k.lock().unwrap().clone();
                async move { Json(json!({ "keys": keys })) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/jwks", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        (url, keys, calls)
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
        headers
    }

    #[tokio::test]
    async fn verifies_better_auth_tokens() {
        let key = Key::new("k1", 1);
        let impostor = Key::new("k1", 2);
        let (url, _, _) = jwks(vec![key.jwk()]).await;
        let v = Verifier::new(&url, ISSUER, ISSUER);

        let user = v.user(&bearer(&key.sign(claims(|_| {})))).await;
        assert_eq!(
            user,
            Some(json!({ "id": "u1", "email": "a@example.com", "name": "Ann" }))
        );
        let rejected = [
            ("missing", HeaderMap::new()),
            (
                "expired",
                bearer(&key.sign(claims(|c| {
                    c.insert("exp".into(), json!(1_000_000));
                }))),
            ),
            (
                "wrong issuer",
                bearer(&key.sign(claims(|c| {
                    c.insert("iss".into(), json!("http://evil.test"));
                }))),
            ),
            (
                "wrong audience",
                bearer(&key.sign(claims(|c| {
                    c.insert("aud".into(), json!("http://other.test"));
                }))),
            ),
            ("bad signature", bearer(&impostor.sign(claims(|_| {})))),
            ("garbage", bearer("not.a.jwt")),
        ];
        for (name, headers) in rejected {
            assert_eq!(v.user(&headers).await, None, "{name}");
        }
    }

    #[tokio::test]
    async fn refetches_the_jwks_on_key_rotation() {
        let (k1, k2) = (Key::new("k1", 1), Key::new("k2", 3));
        let (url, keys, calls) = jwks(vec![k1.jwk()]).await;
        let mut v = Verifier::new(&url, ISSUER, ISSUER);
        v.min_refresh = Duration::ZERO;
        assert!(v.user(&bearer(&k1.sign(claims(|_| {})))).await.is_some());
        assert!(v.user(&bearer(&k1.sign(claims(|_| {})))).await.is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 1, "cached");
        *keys.lock().unwrap() = vec![k1.jwk(), k2.jwk()];
        assert!(v.user(&bearer(&k2.sign(claims(|_| {})))).await.is_some());
        assert_eq!(calls.load(Ordering::SeqCst), 2, "refetched once");
    }
}
