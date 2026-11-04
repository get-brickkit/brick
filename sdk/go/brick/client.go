package brick

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
)

var (
	serviceName string
	client      = &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 64}}
	urlsOnce    sync.Once
	urls        map[string]string
)

func serviceURL(service string) (string, error) {
	urlsOnce.Do(func() {
		_ = json.Unmarshal([]byte(os.Getenv("BRICK_SERVICES")), &urls)
	})
	base, ok := urls[service]
	if !ok {
		return "", &Error{Name: "ActionExecutionError", Code: "SERVICE_UNAVAILABLE", Message: fmt.Sprintf("Service '%s' is not in BRICK_SERVICES", service), Status: 503}
	}
	return base, nil
}

// Call runs another service's action directly (TypeScript, Go or Rust), not
// through the gateway, forwarding the user, request id and trace of ctx with
// this service as the caller. The generated client calls it. A failure is an
// *Error with the callee's code, status and details.
func Call(ctx context.Context, service, action string, in, out any) error {
	base, err := serviceURL(service)
	if err != nil {
		return err
	}
	body, err := marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/"+kebab(action), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-brick-internal", os.Getenv("BRICK_INTERNAL_TOKEN"))
	req.Header.Set("x-brick-caller", serviceName)
	if c, ok := FromContext(ctx); ok {
		for key, value := range map[string]string{
			"x-request-id":   c.requestID,
			"x-trace-id":     c.traceID,
			"traceparent":    c.traceparent,
			"x-brick-user":   c.user,
			"x-brick-tenant": c.tenantID,
		} {
			if value != "" {
				req.Header.Set(key, value)
			}
		}
	}
	res, err := client.Do(req)
	if err != nil {
		return &Error{Name: "ActionExecutionError", Code: "SERVICE_UNAVAILABLE", Message: fmt.Sprintf("Service '%s' is not reachable", service), Status: 503}
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		e := &Error{}
		if json.Unmarshal(data, e) != nil || e.Code == "" {
			return &Error{Name: "ActionExecutionError", Code: "INTERNAL_SERVER_ERROR", Message: res.Status, Status: res.StatusCode}
		}
		return e
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(data, out)
}
