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
	rec = call(testService(t), `{}`, map[string]string{"x-request-id": "r0"})
	want = `{"name":"ValidationError","code":"VALIDATION_FAILED","message":"Validation failed for action 'greetPerson' input","status":400,"errors":[{"path":"/name","message":"Expected required property"},{"path":"/age","message":"Expected required property"},{"path":"/role","message":"Expected required property"},{"path":"/name","message":"Expected string"},{"path":"/age","message":"Expected integer"},{"path":"/role","message":"Expected union value"}],"requestId":"r0"}`
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

func TestOversizedBody(t *testing.T) {
	rec := call(testService(t), `{"name":"`+strings.Repeat("a", maxBody)+`"}`, nil)
	if rec.Code != 413 || !strings.Contains(rec.Body.String(), "PAYLOAD_TOO_LARGE") {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestMalformedForwardedUser(t *testing.T) {
	rec := call(testService(t), `{"name":"alice","age":1,"role":"user"}`, map[string]string{"x-brick-user": "eyJpZCI6"})
	if rec.Code != 400 || !strings.Contains(rec.Body.String(), `"code":"BAD_REQUEST"`) {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestIntegerWrittenAsFloat(t *testing.T) {
	rec := call(testService(t), `{"name":"alice","age":30.0,"role":"user"}`, nil)
	if rec.Code != 200 {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestJSNumber(t *testing.T) {
	for in, want := range map[float64]string{3: "3", 0.5: "0.5", 1e-7: "1e-7", 1.5e-10: "1.5e-10", 1e21: "1e+21", -2.5e22: "-2.5e+22", 0.000001: "0.000001", 0: "0", 1 << 60: "1152921504606847000", 1 << 63: "9223372036854776000"} {
		if got := jsNumber(in); got != want {
			t.Fatalf("jsNumber(%v) = %s, want %s", in, got, want)
		}
	}
}

func TestContinueTrace(t *testing.T) {
	const trace = "0af7651916cd43dd8448eb211c80319c"
	if _, id := continueTrace("00-" + trace + "-b7ad6b7169203331-01"); id != trace {
		t.Fatalf("valid traceparent restarted: %s", id)
	}
	for _, bad := range []string{"ff-" + trace + "-b7ad6b7169203331-01", "00-" + trace + "-0000000000000000-01", "00-00000000000000000000000000000000-b7ad6b7169203331-01"} {
		if _, id := continueTrace(bad); id == trace || id == "00000000000000000000000000000000" {
			t.Fatalf("%s continued", bad)
		}
	}
}
