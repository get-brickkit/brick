// The benchmark's Go service (see ../../bench/run.ts): echo, validate and db,
// the same three APIs as the TS bench service, and me (test/jwt.test.ts).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"

	"github.com/get-brickkit/brick/sdk/go/brick"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type person struct {
	Name string `json:"name" minLength:"3" maxLength:"32"`
	Age  int64  `json:"age" minimum:"0" maximum:"150"`
	Role string `json:"role" enum:"admin,editor,viewer"`
}

type itemID struct {
	ID int64 `json:"id" minimum:"1" maximum:"2147483647"`
}

type item struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Value int64  `json:"value"`
}

func main() {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		url = "postgresql://localhost:5432/drafton"
	}
	config, err := pgxpool.ParseConfig(url)
	if err != nil {
		log.Fatal(err)
	}
	config.MaxConns = 10 // the same pool size as the TS and Rust services
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		log.Fatal(err)
	}

	svc := brick.NewService("benchGo")
	notFound := svc.DefineError("NOT_FOUND", 404, "No such item")
	brick.Action(svc, "echo", func(ctx *brick.Ctx, in json.RawMessage) (json.RawMessage, error) {
		return in, nil
	})
	brick.Action(svc, "validate", func(ctx *brick.Ctx, in person) (person, error) {
		return in, nil
	})
	brick.Action(svc, "db", func(ctx *brick.Ctx, in itemID) (item, error) {
		var it item
		err := pool.QueryRow(ctx, `SELECT id, name, value FROM bench_items WHERE id = $1`, in.ID).Scan(&it.ID, &it.Name, &it.Value)
		if errors.Is(err, pgx.ErrNoRows) {
			return it, notFound.New(nil)
		}
		return it, err
	})
	brick.Action(svc, "me", func(ctx *brick.Ctx, in struct{}) (map[string]any, error) {
		var user map[string]any
		err := ctx.RequireUser(&user)
		return user, err
	})
	log.Fatal(svc.Serve())
}
