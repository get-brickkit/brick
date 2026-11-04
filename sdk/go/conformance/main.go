// The Go side of the cross-language conformance test (sdk/conformance).
package main

import (
	"log"

	"github.com/get-brickkit/brick/sdk/go/brick"
	"github.com/get-brickkit/brick/sdk/go/conformance/brickclient"
)

type person struct {
	Name string `json:"name" minLength:"3" maxLength:"20"`
	Age  int64  `json:"age" minimum:"0" maximum:"150"`
	Role string `json:"role" enum:"admin,user"`
}

type ok struct {
	OK bool `json:"ok"`
}

type empty struct{}

type who struct {
	Service   string `json:"service"`
	User      any    `json:"user"`
	Caller    string `json:"caller,omitempty"`
	RequestID string `json:"requestId"`
	Next      any    `json:"next,omitempty"`
}

func whoami(ctx *brick.Ctx, next any) who {
	var user any
	_, _ = ctx.User(&user)
	return who{Service: "confGo", User: user, Caller: ctx.Caller(), RequestID: ctx.RequestID(), Next: next}
}

func main() {
	svc := brick.NewService("confGo")
	teapot := svc.DefineError("TEAPOT", 418, "I am a teapot")
	brick.Action(svc, "validate", func(ctx *brick.Ctx, in person) (ok, error) {
		return ok{OK: true}, nil
	})
	brick.Action(svc, "fail", func(ctx *brick.Ctx, in empty) (ok, error) {
		return ok{}, teapot.New(map[string]string{"kind": "tea"})
	})
	brick.Action(svc, "whoami", func(ctx *brick.Ctx, in empty) (who, error) {
		return whoami(ctx, nil), nil
	})
	brick.Action(svc, "chain", func(ctx *brick.Ctx, in empty) (who, error) {
		next, err := brickclient.ConfRustChain(ctx, brickclient.ConfRustChainInput{})
		if err != nil {
			return who{}, err
		}
		return whoami(ctx, next), nil
	})
	log.Fatal(svc.Serve())
}
