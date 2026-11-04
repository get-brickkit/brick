package brick

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwa"
	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

const issuer = "http://app.test"

// keyPair is an Ed25519 key as Better Auth's jwt plugin makes them (EdDSA, with a kid).
func keyPair(t *testing.T, kid string) (private, public jwk.Key) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	private, _ = jwk.FromRaw(priv)
	public, _ = jwk.FromRaw(pub)
	for _, k := range []jwk.Key{private, public} {
		_ = k.Set(jwk.KeyIDKey, kid)
		_ = k.Set(jwk.AlgorithmKey, jwa.EdDSA)
	}
	return private, public
}

// jwksServer serves the current public keys; set swaps them (key rotation).
type jwksServer struct {
	*httptest.Server
	mu    sync.Mutex
	keys  []jwk.Key
	calls int
}

func newJWKS(t *testing.T, keys ...jwk.Key) *jwksServer {
	s := &jwksServer{keys: keys}
	s.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.calls++
		set := jwk.NewSet()
		for _, k := range s.keys {
			_ = set.AddKey(k)
		}
		_ = json.NewEncoder(w).Encode(set)
	}))
	t.Cleanup(s.Close)
	return s
}

func (s *jwksServer) set(keys ...jwk.Key) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.keys = keys
}

func sign(t *testing.T, key jwk.Key, edit func(b *jwt.Builder) *jwt.Builder) string {
	b := jwt.NewBuilder().Issuer(issuer).Audience([]string{issuer}).Subject("u1").
		IssuedAt(time.Now()).Expiration(time.Now().Add(15*time.Minute)).
		Claim("id", "u1").Claim("email", "a@example.com").Claim("name", "Ann")
	if edit != nil {
		b = edit(b)
	}
	token, err := b.Build()
	if err != nil {
		t.Fatal(err)
	}
	signed, err := jwt.Sign(token, jwt.WithKey(jwa.EdDSA, key))
	if err != nil {
		t.Fatal(err)
	}
	return string(signed)
}

func authService(t *testing.T, jwksURL string) *Service {
	t.Setenv("BRICK_INTERNAL_TOKEN", "secret")
	t.Setenv("BRICK_JWT_ISSUER", issuer)
	t.Setenv("BRICK_JWKS_URL", jwksURL)
	t.Setenv("BRICK_CORS", `{"origin":["https://app.test"],"credentials":true}`)
	svc := NewService("people")
	Action(svc, "me", func(ctx *Ctx, _ struct{}) (map[string]any, error) {
		var user map[string]any
		if err := ctx.RequireUser(&user); err != nil {
			return nil, err
		}
		return user, nil
	})
	return svc
}

func get(svc *Service, path string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader("{}"))
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, req)
	return rec
}

func me(svc *Service, token string) *httptest.ResponseRecorder {
	headers := map[string]string{"x-request-id": "r1"}
	if token != "" {
		headers["authorization"] = "Bearer " + token
	}
	return get(svc, "/api/people/me", headers)
}

const unauthorized = `{"name":"ActionExecutionError","code":"UNAUTHORIZED","message":"Access denied for action 'me'","status":401,"requestId":"r1"}`

func TestJWT(t *testing.T) {
	private, public := keyPair(t, "k1")
	other, _ := keyPair(t, "k1")
	jwks := newJWKS(t, public)
	svc := authService(t, jwks.URL)

	rec := me(svc, sign(t, private, nil))
	if rec.Code != 200 || rec.Body.String() != `{"email":"a@example.com","id":"u1","name":"Ann"}` {
		t.Fatalf("valid: %d %s", rec.Code, rec.Body.String())
	}
	for name, token := range map[string]string{
		"missing":       "",
		"expired":       sign(t, private, func(b *jwt.Builder) *jwt.Builder { return b.Expiration(time.Now().Add(-time.Hour)) }),
		"wrong issuer":  sign(t, private, func(b *jwt.Builder) *jwt.Builder { return b.Issuer("http://evil.test") }),
		"wrong aud":     sign(t, private, func(b *jwt.Builder) *jwt.Builder { return b.Audience([]string{"http://other.test"}) }),
		"bad signature": sign(t, other, nil),
		"garbage":       "not.a.jwt",
	} {
		if rec := me(svc, token); rec.Code != 401 || rec.Body.String() != unauthorized {
			t.Fatalf("%s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
}

func TestJWKSRotation(t *testing.T) {
	old := minRefresh
	minRefresh = 0
	t.Cleanup(func() { minRefresh = old })
	k1, p1 := keyPair(t, "k1")
	k2, p2 := keyPair(t, "k2")
	jwks := newJWKS(t, p1)
	svc := authService(t, jwks.URL)
	if rec := me(svc, sign(t, k1, nil)); rec.Code != 200 {
		t.Fatalf("k1: %d", rec.Code)
	}
	if rec := me(svc, sign(t, k1, nil)); rec.Code != 200 || jwks.calls != 1 {
		t.Fatalf("cached: %d, %d fetches", rec.Code, jwks.calls)
	}
	jwks.set(p1, p2)
	if rec := me(svc, sign(t, k2, nil)); rec.Code != 200 || jwks.calls != 2 {
		t.Fatalf("rotated: %d, %d fetches", rec.Code, jwks.calls)
	}
}

func TestSpoofedHeadersNeedTheToken(t *testing.T) {
	_, public := keyPair(t, "k1")
	svc := authService(t, newJWKS(t, public).URL)
	spoofed := map[string]string{"x-request-id": "r1", "x-brick-user": "eyJpZCI6Im1hbGxvcnkifQ==", "x-brick-caller": "admin"}
	if rec := get(svc, "/me", spoofed); rec.Code != 401 || rec.Body.String() != unauthorized {
		t.Fatalf("spoofed: %d %s", rec.Code, rec.Body.String())
	}
	spoofed["x-brick-internal"] = "secret"
	if rec := get(svc, "/me", spoofed); rec.Code != 200 || rec.Body.String() != `{"id":"mallory"}` {
		t.Fatalf("with token: %d %s", rec.Code, rec.Body.String())
	}
	spoofed["x-brick-internal"] = "guess"
	if rec := get(svc, "/me", spoofed); rec.Code != 401 || !strings.Contains(rec.Body.String(), "Invalid internal token") {
		t.Fatalf("wrong token: %d %s", rec.Code, rec.Body.String())
	}
}

func TestGatewayDuties(t *testing.T) {
	_, public := keyPair(t, "k1")
	svc := authService(t, newJWKS(t, public).URL)
	rec := get(svc, "/api/people/me", map[string]string{"traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"})
	if !strings.HasPrefix(rec.Header().Get("x-request-id"), "req_") || rec.Header().Get("x-trace-id") != "0af7651916cd43dd8448eb211c80319c" {
		t.Fatalf("ids: %v", rec.Header())
	}
	rec = get(svc, "/api/people/me", map[string]string{"origin": "https://app.test"})
	if rec.Header().Get("access-control-allow-origin") != "https://app.test" || rec.Header().Get("access-control-allow-credentials") != "true" {
		t.Fatalf("cors: %v", rec.Header())
	}
	req := httptest.NewRequest(http.MethodOptions, "/api/people/me", nil)
	req.Header.Set("origin", "https://app.test")
	req.Header.Set("access-control-request-method", "POST")
	req.Header.Set("access-control-request-headers", "authorization, content-type")
	pre := httptest.NewRecorder()
	svc.Handler().ServeHTTP(pre, req)
	if pre.Code != 204 || pre.Header().Get("access-control-allow-headers") != "authorization, content-type" {
		t.Fatalf("preflight: %d %v", pre.Code, pre.Header())
	}
	req.Header.Set("origin", "https://evil.test")
	pre = httptest.NewRecorder()
	svc.Handler().ServeHTTP(pre, req)
	if pre.Header().Get("access-control-allow-origin") != "" {
		t.Fatalf("evil preflight allowed: %v", pre.Header())
	}
}

func TestJWKSOutageBacksOff(t *testing.T) {
	k1, _ := keyPair(t, "k1")
	calls := 0
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(down.Close)
	svc := authService(t, down.URL)
	for range 3 {
		if rec := me(svc, sign(t, k1, nil)); rec.Code != 401 {
			t.Fatalf("got %d", rec.Code)
		}
	}
	if calls != 1 {
		t.Fatalf("%d JWKS fetches during the outage, want 1", calls)
	}
}
