package brick

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/lestrrat-go/jwx/v2/jwk"
	"github.com/lestrrat-go/jwx/v2/jws"
	"github.com/lestrrat-go/jwx/v2/jwt"
)

// How often the JWKS is fetched again: on a token signed with a key id it
// doesn't have yet (key rotation), at most every minRefresh; otherwise every
// maxKeyAge. A fetch gives up after fetchTimeout.
var (
	minRefresh   = 10 * time.Second
	maxKeyAge    = 10 * time.Minute
	fetchTimeout = 5 * time.Second
)

// verifier checks Better Auth JWTs against the app's JWKS, fetched and cached.
type verifier struct {
	url, issuer, audience string

	mu             sync.Mutex
	keys           jwk.Set
	fetched, tried time.Time
}

// verifierFromEnv is the verifier BRICK_JWT_ISSUER configures, or nil (no JWT
// auth: a call has a user only when another service forwards one).
// BRICK_JWT_AUDIENCE defaults to the issuer and BRICK_JWKS_URL to
// <issuer>/api/auth/jwks, as Better Auth's jwt plugin does.
func verifierFromEnv() *verifier {
	issuer := os.Getenv("BRICK_JWT_ISSUER")
	if issuer == "" {
		return nil
	}
	return &verifier{
		issuer:   issuer,
		audience: cmp.Or(os.Getenv("BRICK_JWT_AUDIENCE"), issuer),
		url:      cmp.Or(os.Getenv("BRICK_JWKS_URL"), strings.TrimRight(issuer, "/")+"/api/auth/jwks"),
	}
}

func (v *verifier) keySet(ctx context.Context, kid string) (jwk.Set, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	age := time.Since(v.fetched)
	stale := v.keys == nil || age > maxKeyAge
	if !stale {
		if _, ok := v.keys.LookupKeyID(kid); !ok && age > minRefresh {
			stale = true
		}
	}
	// A failed fetch is retried after minRefresh, so an outage or unknown key
	// ids can't make every request fetch.
	if stale && time.Since(v.tried) >= minRefresh {
		v.tried = time.Now()
		ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
		defer cancel()
		set, err := jwk.Fetch(ctx, v.url, jwk.WithHTTPClient(client))
		if err != nil {
			if v.keys == nil {
				return nil, err
			}
			// Keep the keys we have.
			log.Printf("[brick] JWKS fetch from %s failed: %v", v.url, err)
			return v.keys, nil
		}
		v.keys, v.fetched = set, time.Now()
	}
	if v.keys == nil {
		return nil, errNoKeys
	}
	return v.keys, nil
}

var errNoKeys = errors.New("no JWKS yet (the last fetch failed)")

// user returns the user of the request's bearer JWT as JSON (its claims
// without the registered ones, so the same shape a TS service sees), or nil
// without a valid token: bad signature, expired, wrong issuer or audience.
func (v *verifier) user(r *http.Request) json.RawMessage {
	header := r.Header.Get("authorization")
	if len(header) < 8 || !strings.EqualFold(header[:7], "bearer ") {
		return nil
	}
	raw := []byte(strings.TrimSpace(header[7:]))
	msg, err := jws.Parse(raw)
	if err != nil || len(msg.Signatures()) != 1 {
		return nil
	}
	keys, err := v.keySet(r.Context(), msg.Signatures()[0].ProtectedHeaders().KeyID())
	if err != nil {
		log.Printf("[brick] JWKS fetch from %s failed: %v", v.url, err)
		return nil
	}
	token, err := jwt.Parse(raw,
		jwt.WithKeySet(keys),
		jwt.WithValidate(true),
		jwt.WithIssuer(v.issuer),
		jwt.WithAudience(v.audience),
		jwt.WithAcceptableSkew(30*time.Second),
	)
	if err != nil {
		return nil
	}
	claims := token.PrivateClaims()
	if _, ok := claims["id"]; !ok {
		claims["id"] = token.Subject()
	}
	data, err := json.Marshal(claims)
	if err != nil {
		return nil
	}
	return data
}
