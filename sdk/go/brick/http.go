package brick

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"regexp"
	"slices"
)

// What the Bun gateway does for a TS request, done here for calls that reach
// the service directly: a request id, the W3C trace, and CORS.

var traceparentRe = regexp.MustCompile(`^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-([0-9a-f]{2})$`)

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// continueTrace keeps the trace of a valid traceparent with a new span id for
// this service, or starts a new trace.
func continueTrace(parent string) (traceparent, traceID string) {
	if m := traceparentRe.FindStringSubmatch(parent); m != nil && m[1] != "00000000000000000000000000000000" {
		return "00-" + m[1] + "-" + randomHex(8) + "-" + m[2], m[1]
	}
	traceID = randomHex(16)
	return "00-" + traceID + "-" + randomHex(8) + "-01", traceID
}

// corsRule is BRICK_CORS: the origins of brick({ cors }), as JSON
// {"origin":["https://app.example.com"],"credentials":true}.
type corsRule struct {
	Origin      []string `json:"origin"`
	Credentials bool     `json:"credentials"`
}

func corsFromEnv() *corsRule {
	source := os.Getenv("BRICK_CORS")
	if source == "" {
		return nil
	}
	rule := &corsRule{}
	if err := json.Unmarshal([]byte(source), rule); err != nil {
		log.Printf("[brick] ignoring BRICK_CORS: %v", err)
		return nil
	}
	return rule
}

// apply adds the CORS headers TS's corsHook adds, and answers a preflight (true).
func (c *corsRule) apply(w http.ResponseWriter, r *http.Request) bool {
	from := r.Header.Get("origin")
	if c == nil || from == "" {
		return false
	}
	h := w.Header()
	h.Set("vary", "Origin")
	allowed := slices.Contains(c.Origin, from)
	if allowed {
		h.Set("access-control-allow-origin", from)
		if c.Credentials {
			h.Set("access-control-allow-credentials", "true")
		}
	}
	if r.Method != http.MethodOptions || r.Header.Get("access-control-request-method") == "" {
		return false
	}
	if allowed {
		h.Set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE")
		if requested := r.Header.Get("access-control-request-headers"); requested != "" {
			h.Set("access-control-allow-headers", requested)
		}
	}
	w.WriteHeader(http.StatusNoContent)
	return true
}

// Handler is the service's HTTP handler, for tests or a server of your own:
// the actions, with request ids, tracing and CORS.
func (s *Service) Handler() http.Handler {
	cors := corsFromEnv()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-request-id") == "" {
			r.Header.Set("x-request-id", "req_"+randomHex(8))
		}
		traceparent, traceID := continueTrace(r.Header.Get("traceparent"))
		r.Header.Set("traceparent", traceparent)
		if r.Header.Get("x-trace-id") == "" {
			r.Header.Set("x-trace-id", traceID)
		}
		h := w.Header()
		h.Set("x-request-id", r.Header.Get("x-request-id"))
		h.Set("x-trace-id", r.Header.Get("x-trace-id"))
		if cors.apply(w, r) {
			return
		}
		s.router.ServeHTTP(w, r)
	})
}
