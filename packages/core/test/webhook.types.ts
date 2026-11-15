import {
  defineService,
  defineStorage,
  hmacSignature,
  memory,
  standardWebhooks,
  t,
  twilioSignature,
  type WebhookVerifier,
} from "../src";

const cache = defineStorage({ driver: memory() });
const billing = defineService("billing", {
  deps: { cache },
  context: () => ({ tenant: "t1" }),
});

const payments = billing.webhook({
  name: "payments",
  verify: standardWebhooks({ secret: ["whsec_a", "whsec_b"] }),
  input: t.Object({ amount: t.Number() }),
  eventId: ({ input, headers }) => `${input.amount}${headers.get("x")}`,
  rateLimit: { per: ({ input }) => String(input.amount), max: 1, windowMs: 1 },
  execute: ({ input, ctx, eventId, error }) => {
    const amount: number = input.amount;
    const tenant: string = ctx.tenant;
    const id: string | undefined = eventId;
    // @ts-expect-error
    void input.email;
    void error.NOT_FOUND;
    void [amount, tenant, id];
    return new Response("ok");
  },
});
void payments.run({ amount: 1 });

const custom: WebhookVerifier = ({ rawBody, headers }) => {
  const bytes: Uint8Array = rawBody;
  return bytes.length > 0 && headers.has("x");
};
billing.webhook({
  name: "custom",
  verify: custom,
  replay: { ttlMs: 1000 },
  method: "GET",
  input: t.Object({}),
  execute: () => {},
});
void hmacSignature({ secret: "s", header: "h" });
void twilioSignature({ authToken: "t", url: ({ url }) => url });

// @ts-expect-error
billing.webhook({ name: "x", input: t.Object({}), execute: () => {} });
// @ts-expect-error
billing.webhook({ name: "y", verify: custom, execute: () => {} });
billing.webhook({
  name: "z",
  verify: custom,
  input: t.Object({}),
  // @ts-expect-error
  authorize: () => true,
  execute: () => {},
});
billing.webhook({
  name: "w",
  verify: custom,
  input: t.Object({}),
  // @ts-expect-error
  method: "PUT",
  execute: () => {},
});
