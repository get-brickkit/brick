import {
  defineService,
  defineStorage,
  memory,
  redis,
  type Counter,
  type KeyValueStorage,
} from "../src";

const cache = defineStorage({ driver: redis({ url: process.env.REDIS_URL }) });
const local: KeyValueStorage = defineStorage({ driver: memory() });
void local;

const auth = defineService("auth", { deps: { cache } });
auth.action({
  name: "otp",
  execute: async ({ ctx }) => {
    const value: string | null = await ctx.deps.cache.get("k");
    const counter: Counter = await ctx.deps.cache.increment("k", 1000);
    // @ts-expect-error values are strings
    await ctx.deps.cache.put("k", 1);
    // @ts-expect-error putIfAbsent needs ttlMs
    await ctx.deps.cache.putIfAbsent("k", "v");
    // @ts-expect-error not a declared dep
    void ctx.deps.other;
    return { value, count: counter.count };
  },
});
