import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { defineService, t } from "../src";

const shop = defineService("shop", { context: () => ({}) });
const input = t.Object({ orderId: t.Number() });
const output = t.Object({ refunded: t.Boolean() });

export const refund = shop.action({
  name: "refund",
  input,
  output,
  audit: {
    resource: "order",
    // Typed from the action: the validated input and the result.
    record: ({ input, result }) => {
      const done: boolean = result.refunded;
      return done ? input.orderId : undefined;
    },
  },
  execute: () => ({ refunded: true }),
});

shop.action({ name: "search", method: "POST", audit: false, execute: () => 1 });

shop.action({
  name: "a",
  input,
  // @ts-expect-error not a field of the input
  audit: { record: ({ input }) => input.missing },
  execute: () => 1,
});

shop.action({
  name: "b",
  // @ts-expect-error a record id is a string or a number
  audit: { record: () => ({}) },
  execute: () => 1,
});

shop.action({
  name: "c",
  // @ts-expect-error only `false` or an object
  audit: true,
  execute: () => 1,
});

const orders = sqliteTable("orders", { id: text("id").primaryKey() });
const order = shop.resource({ name: "order", table: orders });
order.command("ship", {
  access: "public",
  input: t.Object({ carrier: t.String() }),
  // The command's `id` joins its input.
  audit: { record: ({ input }) => `${input.id}/${input.carrier}` },
  decide: () => ({}),
});
order.command("quiet", { access: "public", audit: false, decide: () => ({}) });
order.action({
  name: "cancel",
  record: true,
  access: "public",
  audit: { record: ({ input }) => input.id },
  execute: () => 1,
});
