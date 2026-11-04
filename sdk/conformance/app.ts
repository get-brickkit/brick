// The TS side of the cross-language conformance test: one service per
// language with the same actions, served by one Bun gateway.
import {
  brick,
  defineService,
  remoteService,
  t,
  useService,
} from "@brickkit/core";

const userFrom = (request: Request) => {
  const auth = request.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? { id: auth.slice(7) } : undefined;
};

export const confGo = remoteService({
  name: "confGo",
  dir: "../go/conformance",
  dev: "go run .",
  build: { command: "go build -o bin/conformance .", run: "./bin/conformance" },
  context: ({ request }) => ({ user: userFrom(request) }),
});

export const confRust = remoteService({
  name: "confRust",
  dir: "../rust/conformance",
  dev: "cargo run -q",
  build: { command: "cargo build -q", run: "../target/debug/conformance" },
  context: ({ request }) => ({ user: userFrom(request) }),
});

// A call from Go or Rust carries its user in the envelope: keep it.
const confTs = defineService("confTs", {
  context: ({ request, user }) => ({ user: user ?? userFrom(request) }),
});

const who = (ctx: { user?: unknown; caller?: string; requestId?: string }) => ({
  service: "confTs",
  user: ctx.user,
  caller: ctx.caller,
  requestId: ctx.requestId,
});

confTs.action({
  name: "validate",
  input: t.Object({
    name: t.String({ minLength: 3, maxLength: 20 }),
    age: t.Integer({ minimum: 0, maximum: 150 }),
    role: t.Union([t.Literal("admin"), t.Literal("user")]),
  }),
  output: t.Object({ ok: t.Boolean() }),
  execute: () => ({ ok: true }),
});

confTs.action({
  name: "fail",
  input: t.Object({}),
  errors: { TEAPOT: { status: 418, message: "I am a teapot" } },
  execute: ({ error }) => error.TEAPOT(undefined, { kind: "tea" }),
});

confTs.action({
  name: "whoami",
  input: t.Object({}),
  execute: ({ ctx }) => who(ctx),
});

confTs.action({
  name: "chain",
  input: t.Object({}),
  execute: async ({ ctx }) => {
    const go = useService(confGo, { from: "confTs" });
    const next = await go.chain(
      {},
      { user: ctx.user, requestId: ctx.requestId },
    );
    return { ...who(ctx), next };
  },
});

export default brick({
  services: [confTs],
  remote: [confGo, confRust],
  docs: false,
  requestLogging: false,
});
