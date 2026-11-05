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
	done           chan struct{} // closed when the fetch in flight ends
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
	keys, done := v.keys, v.done
	age := time.Since(v.fetched)
	stale := keys == nil || age > maxKeyAge
	if !stale {
		if _, ok := keys.LookupKeyID(kid); !ok && age > minRefresh {
			stale = true
		}
	}
	// One fetch at a time, outside the lock, so cached keys keep serving; a
	// failed one is retried only after minRefresh, so an outage or unknown key
	// ids can't make every request fetch.
	fetch := stale && done == nil && time.Since(v.tried) >= minRefresh
	if fetch {
		v.tried, v.done = time.Now(), make(chan struct{})
		done = v.done
	}
	v.mu.Unlock()
	if !fetch {
		if keys == nil && done != nil {
			// The first fetch is in flight: wait for it rather than fail.
			select {
			case <-done:
			case <-ctx.Done():
			}
			v.mu.Lock()
			keys = v.keys
			v.mu.Unlock()
		}
		if keys == nil {
			return nil, errNoKeys
		}
		return keys, nil
	}
	// Not cancelled with the request that happened to start it.
	fetchCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), fetchTimeout)
	defer cancel()
	set, err := jwk.Fetch(fetchCtx, v.url, jwk.WithHTTPClient(client))
	v.mu.Lock()
	defer v.mu.Unlock()
	close(done)
	v.done = nil
	if err != nil {
		// Keep the keys we have.
		log.Printf("[brick] JWKS fetch from %s failed: %v", v.url, err)
		if v.keys == nil {
			return nil, errNoKeys
		}
		return v.keys, nil
	}
	v.keys, v.fetched = set, time.Now()
	return set, nil
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
	// keySet logs the fetches that fail.
	keys, err := v.keySet(r.Context(), msg.Signatures()[0].ProtectedHeaders().KeyID())
	if err != nil {
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
