// The TS side of the cross-language conformance test: one service per
// language with the same actions, served by one Bun gateway.
import {
  brick,
  defineService,
  remoteService,
  t,
  useService,
} from "@brickkit/core";

// A stand-in for Better Auth's jwt plugin: an Ed25519 key served as a JWKS
// at /jwks, and EdDSA tokens with the user's fields as claims.
export const ISSUER = "http://conformance.test";
const keys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const jwk = {
  ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
  kid: "conf-1",
  alg: "EdDSA",
};
const b64 = (data: string | ArrayBuffer) =>
  Buffer.from(data as ArrayBuffer).toString("base64url");

export async function signJwt(user: { id: string }, ttlSeconds = 900) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: "EdDSA", kid: jwk.kid, typ: "JWT" }));
  const body = b64(
    JSON.stringify({
      ...user,
      sub: user.id,
      iss: ISSUER,
      aud: ISSUER,
      iat: now,
      exp: now + ttlSeconds,
    }),
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keys.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64(signature)}`;
}

/** The TS side verifies the same token, so all three languages see one user. */
async function userFrom(request: Request) {
  const auth = request.headers.get("authorization");
  const [head, body, signature] = auth?.startsWith("Bearer ")
    ? auth.slice(7).split(".")
    : [];
  if (!head || !body || !signature) return undefined;
  const valid = await crypto.subtle.verify(
    "Ed25519",
    keys.publicKey,
    Buffer.from(signature, "base64url"),
    new TextEncoder().encode(`${head}.${body}`),
  );
  if (!valid) return undefined;
  const {
    sub: _sub,
    iss,
    aud,
    iat: _iat,
    exp,
    ...user
  } = JSON.parse(Buffer.from(body, "base64url").toString());
  return iss === ISSUER && aud === ISSUER && exp > Date.now() / 1000
    ? (user as { id: string })
    : undefined;
}

export const confGo = remoteService({
  name: "confGo",
  dir: "../go/conformance",
  dev: "go run .",
  build: { command: "go build -o bin/conformance .", run: "./bin/conformance" },
});

export const confRust = remoteService({
  name: "confRust",
  dir: "../rust/conformance",
  dev: "cargo run -q",
  build: { command: "cargo build -q", run: "../target/debug/conformance" },
});

// A call from Go or Rust carries its user in the envelope: keep it.
const confTs = defineService("confTs", {
  context: async ({ request, user }) => ({
    user: user ?? (await userFrom(request)),
  }),
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
  name: "me",
  input: t.Object({}),
  authorize: ({ user }) => user != null,
  execute: ({ ctx }) => ctx.user,
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

const app = brick({
  services: [confTs],
  remote: [confGo, confRust],
  docs: false,
  requestLogging: false,
});
app.get("/jwks", () => ({ keys: [jwk] }));

export default app;
