module github.com/get-brickkit/brick/examples/pages/services/bench-go

go 1.26.3

require (
	github.com/get-brickkit/brick/sdk/go v0.0.0
	github.com/jackc/pgx/v5 v5.12.0
)

require (
	github.com/danielgtaylor/huma/v2 v2.40.0 // indirect
	github.com/go-chi/chi/v5 v5.5.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.3 // indirect
	golang.org/x/sync v0.24.0 // indirect
	golang.org/x/text v0.43.0 // indirect
)

replace github.com/get-brickkit/brick/sdk/go => ../../../../sdk/go
