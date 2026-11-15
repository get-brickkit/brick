import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineService, defineStorage, memory, t } from "../src";
import type { InferActionFailure } from "../src/client";

const cache = defineStorage({ driver: memory() });
const auth = defineService("auth", {
  deps: { cache },
  context: () => ({ user: undefined as { id: string } | undefined }),
});
const input = t.Object({ email: t.String() });

export const login = auth.action({
  name: "login",
  input,
  rateLimit: [
    { per: "ip", max: 20, windowMs: 60_000 },
    {
      per: ({ input }) => input.email.toLowerCase(),
      max: 5,
      windowMs: 900_000,
    },
    { per: ({ ctx }) => ctx.user?.id, max: 5, windowMs: 900_000 },
  ],
  execute: ({ error }) => error.RATE_LIMITED(),
});

auth.action({
  name: "a",
  input,
  // @ts-expect-error
  rateLimit: { per: ({ input }) => input.password, max: 5, windowMs: 1000 },
  execute: () => 1,
});

auth.action({
  name: "b",
  // @ts-expect-error
  rateLimit: { per: () => 1, max: 5, windowMs: 1000 },
  execute: () => 1,
});

auth.action({
  name: "c",
  // @ts-expect-error
  rateLimit: { per: "user", max: 3, windowMs: 1000 },
  execute: () => 1,
});

const things = sqliteTable("things", { id: text("id").primaryKey() });
const thing = auth.resource({ name: "thing", table: things });
thing.command("touch", {
  access: "public",
  input: t.Object({ note: t.String() }),
  rateLimit: {
    per: ({ input }) => `${input.id}:${input.note}`,
    max: 1,
    windowMs: 1000,
  },
  decide: () => ({}),
});
thing.action({
  name: "count",
  rateLimit: { per: ({ ctx }) => ctx.user?.id, max: 1, windowMs: 1000 },
  execute: () => 1,
});

const sendOtp = auth.action({
  name: "sendOtp",
  errors: { TOO_SOON: { status: 409, message: "Wait" } },
  rateLimit: { per: "ip", max: 1, windowMs: 1000 },
  execute: () => 1,
});
const code: InferActionFailure<typeof sendOtp>["code"] = "RATE_LIMITED";
// @ts-expect-error
const other: InferActionFailure<typeof sendOtp>["code"] = "RATE_LIMITED_X";
void [code, other];
