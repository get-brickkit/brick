package brick

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
)

type ctxKey struct{}

// Ctx is the context of one action call: its ids, and its user from the
// caller's JWT, or, for a call from another service, the caller, user and
// tenant that service forwarded.
type Ctx struct {
	context.Context
	action      string
	requestID   string
	traceID     string
	traceparent string
	caller      string
	tenantID    string
	user        json.RawMessage
}

func newCtx(r *http.Request, action string, trusted bool, auth *verifier) *Ctx {
	c := &Ctx{
		action:      action,
		requestID:   r.Header.Get("x-request-id"),
		traceID:     r.Header.Get("x-trace-id"),
		traceparent: r.Header.Get("traceparent"),
	}
	if trusted {
		c.caller = r.Header.Get("x-brick-caller")
		c.tenantID = r.Header.Get("x-brick-tenant")
		if user := r.Header.Get("x-brick-user"); user != "" {
			c.user, _ = base64.StdEncoding.DecodeString(user)
		}
	} else if auth != nil {
		c.user = auth.user(r)
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

// TraceID is the id of the trace this call is part of.
func (c *Ctx) TraceID() string { return c.traceID }

// Caller is the name of the service that called this action, or "" for a
// call from outside.
func (c *Ctx) Caller() string { return c.caller }

// TenantID is the tenant the calling service forwarded, if any.
func (c *Ctx) TenantID() string { return c.tenantID }

// HasUser reports whether the call carries a user.
func (c *Ctx) HasUser() bool { return len(c.user) > 0 }

// User decodes the caller's user into v: the claims of a valid JWT, or the
// user a calling service forwarded. It returns false when there is none.
func (c *Ctx) User(v any) (bool, error) {
	if len(c.user) == 0 {
		return false, nil
	}
	return true, json.Unmarshal(c.user, v)
}

// RequireUser decodes the user into v, or returns the 401 a TS action's
// authorize gives without one: `if err := ctx.RequireUser(&u); err != nil { return out, err }`.
func (c *Ctx) RequireUser(v any) error {
	if len(c.user) == 0 {
		return &Error{Name: "ActionExecutionError", Code: "UNAUTHORIZED", Message: fmt.Sprintf("Access denied for action '%s'", c.action), Status: 401}
	}
	return json.Unmarshal(c.user, v)
}
