// Package brick writes Brick services in Go. A Go service runs as its own
// process next to the Bun app. Browsers reach it directly, through a reverse
// proxy in production or the Bun gateway in `brick dev`: it serves
// /api/<service>/<action> (and /<action>), verifies the caller's Better Auth
// JWT itself, and adds request ids, the W3C trace and CORS. Other services
// call it with the internal token, which alone makes their x-brick-* headers
// (caller, user, tenant) trusted.
//
//	svc := brick.NewService("billing")
//	errNoFunds := svc.DefineError("INSUFFICIENT_FUNDS", 402, "Not enough funds")
//	brick.Action(svc, "charge", func(ctx *brick.Ctx, in ChargeInput) (ChargeOutput, error) {
//		return ChargeOutput{}, errNoFunds.New(nil)
//	})
//	log.Fatal(svc.Serve())
//
// Experimental: polyglot services are new in Brick 0.13. The API, the wire
// format and the environment variables may change in any release. Install it
// at the version of the @brickkit npm packages:
//
//	go get github.com/get-brickkit/brick/sdk/go@v0.13.0
package brick

import (
	"bytes"
	"cmp"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"reflect"
	"slices"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/go-chi/chi/v5"
)

const maxBody = 1 << 20

// Service is a Go Brick service: a name, its actions and its declared errors.
type Service struct {
	name     string
	registry huma.Registry
	router   chi.Router
	actions  []manifestAction
	errors   []*ErrorDef
	auth     *verifier
}

// NewService starts a service. Its name must match the remoteService name in the Bun app.
func NewService(name string) *Service {
	s := &Service{
		name:     name,
		registry: huma.NewMapRegistry("#/components/schemas/", huma.DefaultSchemaNamer),
		router:   chi.NewRouter(),
		auth:     verifierFromEnv(),
	}
	s.router.Get("/_health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	serviceName = name
	return s
}

// Name is the service name.
func (s *Service) Name() string { return s.name }

// DefineError declares an error the service's actions return: `return out, def.New(details)`.
func (s *Service) DefineError(code string, status int, message string) *ErrorDef {
	def := &ErrorDef{Code: code, Status: status, Message: message}
	s.errors = append(s.errors, def)
	return def
}

// Action registers a typed action. Its input and output schemas come from the
// Go types through Huma (struct tags such as minLength, maximum and enum);
// the input is validated against that schema before fn runs, with the same
// error envelope a TypeScript action gives. It is served at
// POST /<kebab-name> for other services, and at
// POST $BRICK_PREFIX/<kebab-service>/<kebab-name> (prefix default /api) for
// the proxy, which then needs no path rewriting.
func Action[I, O any](s *Service, name string, fn func(ctx *Ctx, in I) (O, error)) {
	input := s.schema(reflect.TypeFor[I](), pascal(name)+"Input")
	output := s.schema(reflect.TypeFor[O](), pascal(name)+"Output")
	s.actions = append(s.actions, manifestAction{Name: name, Input: input, Output: output})
	handler := func(w http.ResponseWriter, r *http.Request) {
		serve, trust := checkToken(r)
		ctx := newCtx(r, name, trust, s.auth)
		if !serve {
			writeError(w, ctx, &Error{Name: "ActionExecutionError", Code: "UNAUTHORIZED", Message: "Invalid internal token", Status: 401})
			return
		}
		if ctx.badUser {
			// As the TS internal call handler answers it.
			writeError(w, ctx, &Error{Name: "ActionExecutionError", Code: "BAD_REQUEST", Message: "Invalid x-brick-user header", Status: 400})
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if tooLarge := (*http.MaxBytesError)(nil); errors.As(err, &tooLarge) {
			writeError(w, ctx, &Error{Name: "ActionExecutionError", Code: "PAYLOAD_TOO_LARGE", Message: "Request body too large", Status: 413})
			return
		}
		if err != nil {
			writeError(w, ctx, internalError())
			return
		}
		if len(strings.TrimSpace(string(body))) == 0 {
			body = []byte("{}")
		}
		value, err := decodeOrdered(body)
		if err != nil {
			writeError(w, ctx, &Error{Name: "ActionExecutionError", Code: "BAD_REQUEST", Message: "Invalid JSON body", Status: 400})
			return
		}
		if issues := validate(input, value); len(issues) > 0 {
			writeError(w, ctx, validationError(name, issues))
			return
		}
		var in I
		if json.Unmarshal(body, &in) != nil {
			// JSON integers may be written 30.0 or 3e1, which pass validation as
			// in TS but which Go won't decode into an int: retry with them as 30.
			var normalized bytes.Buffer
			writeJSON(&normalized, value)
			body = normalized.Bytes()
		}
		if err := json.Unmarshal(body, &in); err != nil {
			writeError(w, ctx, validationError(name, []Issue{{Path: "", Message: err.Error()}}))
			return
		}
		out, err := fn(ctx, in)
		if err != nil {
			e, ok := asError(err)
			if !ok {
				log.Printf("[%s:%s] unexpected error (requestId %q): %v", s.name, name, ctx.requestID, err)
				e = internalError()
			}
			writeError(w, ctx, e)
			return
		}
		data, err := marshal(out)
		if err != nil {
			writeError(w, ctx, internalError())
			return
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write(data)
	}
	s.router.Post("/"+kebab(name), handler)
	prefix := strings.TrimRight(cmp.Or(os.Getenv("BRICK_PREFIX"), "/api"), "/")
	s.router.Post(prefix+"/"+kebab(s.name)+"/"+kebab(name), handler)
}

// checkToken trusts a request's x-brick-* headers only with the internal
// token, which only other services of the app have. A request without the
// header is a public call (its user comes from its JWT); a wrong token is
// refused, so a misconfigured service fails loudly instead of running as
// nobody.
func checkToken(r *http.Request) (serve, trust bool) {
	given, present := r.Header["X-Brick-Internal"]
	if !present {
		return true, false
	}
	token := os.Getenv("BRICK_INTERNAL_TOKEN")
	ok := token != "" && len(given) == 1 && subtle.ConstantTimeCompare([]byte(given[0]), []byte(token)) == 1
	return ok, ok
}

func writeError(w http.ResponseWriter, ctx *Ctx, e *Error) {
	envelope := *e
	envelope.RequestID = ctx.requestID
	if envelope.Name == "" {
		envelope.Name = "ActionExecutionError"
	}
	data, _ := marshal(&envelope)
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(envelope.Status)
	_, _ = w.Write(data)
}

// Serve prints the manifest and exits when run with --brick-manifest (or
// BRICK_MANIFEST=1). Otherwise it listens on $BRICK_HOST:$BRICK_PORT
// (default 127.0.0.1; 0.0.0.0 in a container).
func (s *Service) Serve() error {
	if slices.Contains(os.Args[1:], "--brick-manifest") || os.Getenv("BRICK_MANIFEST") == "1" {
		data, err := json.Marshal(s.Manifest())
		if err != nil {
			return err
		}
		fmt.Println(string(data))
		os.Exit(0)
	}
	port := os.Getenv("BRICK_PORT")
	if port == "" {
		port = "0"
	}
	ln, err := net.Listen("tcp", net.JoinHostPort(cmp.Or(os.Getenv("BRICK_HOST"), "127.0.0.1"), port))
	if err != nil {
		return err
	}
	log.Printf("[brick] %s (go) listening on http://%s", s.name, ln.Addr())
	srv := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
	return srv.Serve(ln)
}

type manifestAction struct {
	Name   string  `json:"name"`
	Input  *object `json:"input"`
	Output *object `json:"output"`
}

type manifestError struct {
	Status  int    `json:"status"`
	Message string `json:"message"`
}

// Manifest describes the service for `brick gen`: its actions with input and
// output JSON Schema, and its errors.
type Manifest struct {
	Name     string           `json:"name"`
	Language string           `json:"language"`
	Actions  []manifestAction `json:"actions"`
	Errors   *object          `json:"errors"`
}

// Manifest returns what --brick-manifest prints.
func (s *Service) Manifest() Manifest {
	errs := newObject()
	for _, e := range s.errors {
		errs.set(e.Code, manifestError{Status: e.Status, Message: e.Message})
	}
	actions := s.actions
	if actions == nil {
		actions = []manifestAction{}
	}
	return Manifest{Name: s.name, Language: "go", Actions: actions, Errors: errs}
}
