package brick

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type person struct {
	Name string `json:"name" minLength:"3" maxLength:"20"`
	Age  int    `json:"age" minimum:"0" maximum:"150"`
	Role string `json:"role" enum:"admin,user"`
	Note string `json:"note,omitempty"`
}

func testService(t *testing.T) *Service {
	t.Setenv("BRICK_INTERNAL_TOKEN", "secret")
	svc := NewService("people")
	errGone := svc.DefineError("GONE", 410, "It is gone")
	Action(svc, "greetPerson", func(ctx *Ctx, in person) (map[string]any, error) {
		if in.Name == "gone" {
			return nil, errGone.New(map[string]int{"id": 7})
		}
		var user map[string]string
		_, _ = ctx.User(&user)
		return map[string]any{"hello": in.Name, "user": user, "caller": ctx.Caller(), "requestId": ctx.RequestID()}, nil
	})
	return svc
}

func call(svc *Service, body string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/greet-person", strings.NewReader(body))
	req.Header.Set("x-brick-internal", "secret")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	svc.Handler().ServeHTTP(rec, req)
	return rec
}

func TestValidationMatchesTypeBox(t *testing.T) {
	rec := call(testService(t), `{"name":"ab","age":200,"role":"nope"}`, map[string]string{"x-request-id": "r1"})
	want := `{"name":"ValidationError","code":"VALIDATION_FAILED","message":"Validation failed for action 'greetPerson' input","status":400,"errors":[{"path":"/name","message":"Expected string length greater or equal to 3","value":"ab"},{"path":"/age","message":"Expected integer to be less or equal to 150","value":200},{"path":"/role","message":"Expected union value","value":"nope"}],"requestId":"r1"}`
	if rec.Code != 400 || rec.Body.String() != want {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
	rec = call(testService(t), `{}`, nil)
	want = `{"name":"ValidationError","code":"VALIDATION_FAILED","message":"Validation failed for action 'greetPerson' input","status":400,"errors":[{"path":"/name","message":"Expected required property"},{"path":"/age","message":"Expected required property"},{"path":"/role","message":"Expected required property"},{"path":"/name","message":"Expected string"},{"path":"/age","message":"Expected integer"},{"path":"/role","message":"Expected union value"}],"requestId":""}`
	if rec.Body.String() != want {
		t.Fatalf("got %s", rec.Body.String())
	}
}

func TestTypedErrorAndContext(t *testing.T) {
	svc := testService(t)
	rec := call(svc, `{"name":"gone","age":1,"role":"user"}`, map[string]string{"x-request-id": "r2"})
	if rec.Code != 410 || rec.Body.String() != `{"name":"ActionExecutionError","code":"GONE","message":"It is gone","status":410,"details":{"id":7},"requestId":"r2"}` {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
	rec = call(svc, `{"name":"alice","age":1,"role":"user"}`, map[string]string{
		"x-request-id": "r3", "x-brick-caller": "orders", "x-brick-user": "eyJpZCI6ImEifQ==",
	})
	if rec.Body.String() != `{"caller":"orders","hello":"alice","requestId":"r3","user":{"id":"a"}}` {
		t.Fatalf("got %s", rec.Body.String())
	}
}

func TestRejectsWithoutToken(t *testing.T) {
	rec := call(testService(t), `{}`, map[string]string{"x-brick-internal": "wrong"})
	if rec.Code != 401 {
		t.Fatalf("got %d", rec.Code)
	}
}

func TestManifest(t *testing.T) {
	data, _ := json.Marshal(testService(t).Manifest())
	got := string(data)
	for _, want := range []string{
		`"name":"people","language":"go"`,
		`"properties":{"name":{"maxLength":20,"minLength":3,"type":"string"},"age":`,
		`"required":["name","age","role"]`,
		`"errors":{"GONE":{"status":410,"message":"It is gone"}}`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("manifest %s lacks %s", got, want)
		}
	}
}

func TestKebab(t *testing.T) {
	for in, want := range map[string]string{"chargeCard": "charge-card", "importCSV": "import-csv", "page.list": "page.list"} {
		if got := kebab(in); got != want {
			t.Fatalf("kebab(%s) = %s", in, got)
		}
	}
}
