// Type-level tests for declared deps and useService. Checked by tsc (tsconfig.types.json), not run.
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  brick,
  defineService,
  defineListener,
  port,
  t,
  useDeps,
  useService,
} from "../src";

interface Carrier {
  book(orderId: string): Promise<string>;
}

// --- deps -------------------------------------------------------------------

const ordersDeps = { carrier: port<Carrier>() };
const orders = defineService("orders", { deps: ordersDeps });

orders.action({
  name: "ship",
  input: t.Object({ id: t.String() }),
  execute: async ({ input, ctx }) => {
    const tracking: string = await ctx.deps.carrier.book(input.id);
    // @ts-expect-error: only declared deps exist
    void ctx.deps.mailer;
    // @ts-expect-error: book takes a string
    await ctx.deps.carrier.book(1);
    return tracking;
  },
});

orders.socket({
  name: "live",
  input: { ping: t.Object({}) },
  output: {},
  handlers: {
    ping: ({ ctx }) => void ctx.deps.carrier.book("x"),
  },
});

const plain = defineService("plain");

defineListener({
  name: "book",
  on: "order.update",
  run: async () => {
    const carrier: Carrier = useDeps(ordersDeps).carrier;
    const typed: Carrier = useDeps<{ carrier: Carrier }>().carrier;
    void carrier;
    void typed;
  },
});

brick({ services: [orders], deps: { carrier: {} as Carrier } });

// --- useService ---------------------------------------------------------------

// A name no other test file uses: the augmentation below is global to the typecheck.
const billingService = defineService("typed_billing");
const charge = billingService.action({
  name: "charge",
  input: t.Object({ orderId: t.String(), amountCents: t.Integer() }),
  output: t.Object({ ok: t.Boolean() }),
  execute: async () => ({ ok: true }),
});
const invoice = billingService.resource({
  name: "invoice",
  table: sqliteTable("types_invoices", { id: text("id").primaryKey() }),
});
const voidInvoice = invoice.action({
  name: "void",
  input: t.Object({ reason: t.String() }),
  output: t.String(),
  execute: async ({ input }) => input.reason,
});

const closeInvoice = invoice.command("close", {
  access: "public",
  decide: () => ({}),
});

// What the generated `_brick/contract.ts` declares for the app.
declare module "../src/client" {
  interface BrickServices {
    typed_billing: {
      charge: typeof charge;
      invoice: { void: typeof voidInvoice; close: typeof closeInvoice };
    };
  }
}

const billing = useService(billingService, { from: "orders" });

async function calls() {
  const result: { ok: boolean } = await billing.charge({
    orderId: "o1",
    amountCents: 100,
  });
  const voided: string = await billing.invoice.void(
    { reason: "dup" },
    { traceId: "tr_1" },
  );
  const closed: { id: string | number } = await billing.invoice.close({
    id: "i1",
  });
  void result;
  void voided;
  void closed;
  // @ts-expect-error: a command needs the record id
  await billing.invoice.close({});

  // @ts-expect-error: a renamed or missing action is a compile error
  await billing.chargeOrder({ orderId: "o1", amountCents: 1 });
  // @ts-expect-error: the input follows the action's schema
  await billing.charge({ orderId: "o1", amountCents: "100" });
  // @ts-expect-error: required input
  await billing.charge();
  // @ts-expect-error: resource actions sit under the resource
  await billing.void({ reason: "dup" });
}
void calls;

// A service the contract does not describe yet is untyped, not an error.
const unknown = useService(plain);
void unknown.anything({});
