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
    const claim: { stored: boolean; value: string } =
      await ctx.deps.cache.putIfAbsent("k", "v", 1000);
    void claim;
    // @ts-expect-error
    await ctx.deps.cache.put("k", 1);
    // @ts-expect-error
    await ctx.deps.cache.putIfAbsent("k", "v");
    // @ts-expect-error
    void ctx.deps.other;
    return { value, count: counter.count };
  },
});
