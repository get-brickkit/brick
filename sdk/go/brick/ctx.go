package brick

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
)

type ctxKey struct{}

// Ctx is the context of one action call. Bun has already worked out the user
// and checked the caller; a request carries them only with the internal token.
type Ctx struct {
	context.Context
	requestID   string
	traceID     string
	traceparent string
	caller      string
	tenantID    string
	user        string // base64 JSON, as forwarded
}

func newCtx(r *http.Request, trusted bool) *Ctx {
	c := &Ctx{
		requestID:   r.Header.Get("x-request-id"),
		traceID:     r.Header.Get("x-trace-id"),
		traceparent: r.Header.Get("traceparent"),
	}
	if trusted {
		c.caller = r.Header.Get("x-brick-caller")
		c.tenantID = r.Header.Get("x-brick-tenant")
		c.user = r.Header.Get("x-brick-user")
	}
	c.Context = context.WithValue(r.Context(), ctxKey{}, c)
	return c
}

// FromContext returns the Ctx of the action call ctx belongs to, if any.
func FromContext(ctx context.Context) (*Ctx, bool) {
	if c, ok := ctx.(*Ctx); ok {
		return c, true
	}
	c, ok := ctx.Value(ctxKey{}).(*Ctx)
	return c, ok
}

// RequestID is the id of the public request this call is part of.
func (c *Ctx) RequestID() string { return c.requestID }

// TraceID is the trace id Bun assigned.
func (c *Ctx) TraceID() string { return c.traceID }

// Caller is the name of the service that called this action, or "" for a
// call from outside through the gateway.
func (c *Ctx) Caller() string { return c.caller }

// TenantID is the tenant the gateway's context hook resolved, if any.
func (c *Ctx) TenantID() string { return c.tenantID }

// HasUser reports whether the call carries a user.
func (c *Ctx) HasUser() bool { return c.user != "" }

// User decodes the user Bun resolved into v. It returns false when there is none.
func (c *Ctx) User(v any) (bool, error) {
	if c.user == "" {
		return false, nil
	}
	raw, err := base64.StdEncoding.DecodeString(c.user)
	if err != nil {
		return false, err
	}
	return true, json.Unmarshal(raw, v)
}
