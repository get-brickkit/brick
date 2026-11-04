import { defineService, eq, remoteService, t } from "@brickkit/core";

import { getAuth } from "../../auth";
import { appDb } from "../../db";
import { benchItemsTable } from "./model";

export * from "./model";

// The same three APIs in TS, Go and Rust, for bench/run.ts:
// echo (return the JSON body), validate (string length, integer range, enum)
// and db (one SELECT by id).
export const benchService = defineService("bench", { database: appDb });

benchService.action({
  name: "echo",
  input: t.Unknown(),
  output: t.Unknown(),
  execute: ({ input }) => input,
});

const Person = t.Object({
  name: t.String({ minLength: 3, maxLength: 32 }),
  age: t.Integer({ minimum: 0, maximum: 150 }),
  role: t.Union([t.Literal("admin"), t.Literal("editor"), t.Literal("viewer")]),
});

benchService.action({
  name: "validate",
  input: Person,
  output: Person,
  execute: ({ input }) => input,
});

const Item = t.Object({
  id: t.Integer(),
  name: t.String(),
  value: t.Integer(),
});

benchService.action({
  name: "db",
  input: t.Object({ id: t.Integer({ minimum: 1 }) }),
  output: Item,
  errors: { NOT_FOUND: { status: 404, message: "No such item" } },
  execute: async ({ input, ctx, error }) => {
    const [item] = await ctx.db
      .select()
      .from(benchItemsTable)
      .where(eq(benchItemsTable.id, input.id));
    return item ?? error.NOT_FOUND();
  },
});

// The signed-in user, from the Better Auth session cookie. Go and Rust have the
// same action: they read the user from Better Auth's JWT instead
// (test/jwt.test.ts). Its own service, so the bench APIs don't load a session.
export const benchAuthService = defineService("benchAuth", {
  context: async ({ request, user }) => ({
    user:
      user ??
      (await getAuth().api.getSession({ headers: request.headers }))?.user ??
      null,
  }),
});

benchAuthService.action({
  name: "me",
  input: t.Object({}),
  output: t.Unknown(),
  authorize: ({ user }) => user != null,
  execute: ({ ctx }) => ctx.user,
});

// Go (services/bench-go) and Rust (services/bench-rust), run next to the app.
// Paths are relative to examples/pages, where every command runs.
export const benchGo = remoteService({
  name: "benchGo",
  dir: "services/bench-go",
  dev: "go run .",
  build: { command: "go build -o bin/bench-go .", run: "./bin/bench-go" },
});

export const benchRust = remoteService({
  name: "benchRust",
  dir: "services/bench-rust",
  dev: "cargo run -q",
  build: {
    command: "cargo build --release -q",
    run: "./target/release/bench-rust",
  },
});
