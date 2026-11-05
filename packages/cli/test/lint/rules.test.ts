import { describe, expect, it } from "bun:test";
import * as core from "@brickkit/core";
import { DEFINE_FUNCTIONS } from "../../src/lint/ast";
import { rules } from "../../src/lint/presets";
import { lintCases, type Case } from "./helpers";

const S = "src/services";
const action = (name: string, extra = "") =>
  `import { orders } from "../orders.service";\nexport default orders.action({ name: "${name}", input: t.Object({}), output: t.Object({})${extra}, execute: () => ({}) });\n`;

const CASES: Record<string, Case[]> = {
  "one-action-per-file": [
    {
      file: `${S}/orders/actions/get-summary.action.ts`,
      code: action("getSummary"),
      errors: 0,
    },
    {
      file: `${S}/orders/actions/two.action.ts`,
      code: action("a") + `orders.action({ name: "b" });\n`,
      errors: 1,
    },
    {
      file: `${S}/orders/actions/none.action.ts`,
      code: "export {};\n",
      errors: 1,
    },
    {
      file: `${S}/orders/orders.service.ts`,
      code: `orders.action({ name: "x" });\n`,
      errors: 1,
    },
    {
      file: `${S}/orders/actions/get-summary.test.ts`,
      code: action("a") + `orders.action({ name: "b" });\n`,
      errors: 0,
    },
  ],
  "file-suffixes": [
    {
      file: `${S}/orders/orders.service.ts`,
      code: `export const orders = defineService("orders", {});\n`,
      errors: 0,
    },
    {
      file: `${S}/orders/resources/order/order.resource.ts`,
      code: `export const order = orders.resource({ name: "order", table });\nexport const items = sqliteTable("items", {});\n`,
      errors: 0,
    },
    {
      file: "src/app.ts",
      code: `const s = defineService("orders");\norders.tool({ name: "find" });\n`,
      errors: 2,
    },
    {
      file: `${S}/orders/orders.events.ts`,
      code: `export const t = pgTable("outbox", {});\n`,
      errors: 1,
    },
  ],
  "kind-folders": [
    { file: `${S}/orders/orders.service.ts`, code: "export {};\n", errors: 0 },
    {
      file: `${S}/orders/actions/get-summary.action.ts`,
      code: "export {};\n",
      errors: 0,
    },
    {
      file: `${S}/orders/resources/order/order.table.ts`,
      code: "export {};\n",
      errors: 0,
    },
    {
      file: `${S}/orders/resources/order/commands/ship.command.ts`,
      code: "export {};\n",
      errors: 0,
    },
    {
      file: `${S}/orders/workflows/book-carrier.step.ts`,
      code: "export {};\n",
      errors: 0,
    },
    {
      file: `${S}/orders/get-summary.action.ts`,
      code: "export {};\n",
      errors: 1,
    },
    {
      file: `${S}/orders/commands/ship.command.ts`,
      code: "export {};\n",
      errors: 1,
    },
    {
      file: `${S}/orders/resources/order/actions/x.tool.ts`,
      code: "export {};\n",
      errors: 1,
    },
    { file: "src/lib/send.listener.ts", code: "export {};\n", errors: 1 },
  ],
  "resource-folder": [
    {
      file: `${S}/orders/resources/order-item/order-item.resource.ts`,
      code: `export const orderItem = orders.resource({ name: "orderItem", table });\n`,
      errors: 0,
    },
    {
      file: `${S}/orders/resources/order/order.resource.ts`,
      code: `export const order = orders.resource({ name: "invoice", table });\n`,
      errors: 1,
    },
    {
      file: `${S}/orders/resources/order/order.resource.ts`,
      code: `export const order = defineResource(orders, { name: "invoice", table });\n`,
      errors: 1,
    },
    {
      file: `${S}/orders/resources/order/commands/ship.command.ts`,
      code: `import { order } from "../order.resource";\nexport default order.command("ship", {});\n`,
      errors: 0,
    },
    {
      file: `${S}/orders/resources/order/actions/archive.action.ts`,
      code: `import { invoice } from "../../invoice/invoice.resource";\nexport default invoice.action({ name: "archive" });\n`,
      errors: 1,
    },
    {
      file: `${S}/orders/actions/ship.action.ts`,
      code: `order.command("ship", {});\n`,
      errors: 1,
    },
  ],
  "file-name-matches": [
    {
      file: `${S}/orders/actions/get-summary.action.ts`,
      code: `orders.action({ name: "getSummary" });\n`,
      errors: 0,
    },
    {
      file: `${S}/orders/resources/order/commands/add-item.command.ts`,
      code: `order.command("addItem", {});\n`,
      errors: 0,
    },
    {
      file: `${S}/orders/actions/summary.action.ts`,
      code: `orders.action({ name: "getSummary" });\n`,
      errors: 1,
    },
    // The URL segment's kebab-case: acronyms split, underscores stay.
    {
      file: `${S}/orders/actions/import-csv.action.ts`,
      code: `orders.action({ name: "importCSV" });\n`,
      errors: 0,
    },
    {
      file: `${S}/orders/actions/sync_stock.action.ts`,
      code: `orders.action({ name: "sync_stock" });\n`,
      errors: 0,
    },
  ],
  "service-folder": [
    {
      file: `${S}/orders/orders.service.ts`,
      code: `export const orders = defineService("orders", {});\n`,
      errors: 0,
    },
    {
      file: `${S}/order-billing/order-billing.service.ts`,
      code: `export const s = defineService("orderBilling", {});\n`,
      errors: 0,
    },
    {
      file: `${S}/billing/billing.service.ts`,
      code: `export const a = defineService("orders");\nexport const b = defineService("billing");\n`,
      errors: 2,
    },
  ],
  "colocate-in-service": [
    {
      file: `${S}/orders/actions/get-summary.action.ts`,
      code: `import { orders } from "../orders.service";\norders.action({ name: "getSummary" });\n`,
      errors: 0,
    },
    {
      file: `${S}/orders/actions/charge.action.ts`,
      code: `import { billing } from "../../billing/billing.service";\nbilling.action({ name: "charge" });\n`,
      errors: 1,
    },
  ],
  "workflow-directive": [
    {
      file: `${S}/orders/workflows/fulfil-order.workflow.ts`,
      code: `export async function fulfil() {\n  "use workflow";\n}\n`,
      errors: 0,
    },
    {
      file: `${S}/orders/workflows/book.step.ts`,
      code: `export async function book() {}\n`,
      errors: 1,
      output: `"use step";\n\nexport async function book() {}\n`,
    },
    {
      file: `${S}/orders/actions/x.action.ts`,
      code: `async function f() {\n  "use workflow";\n}\n`,
      errors: 1,
    },
  ],
  "no-server-in-client": [
    {
      file: "web/main.ts",
      code: `import { createBrickClient } from "@brickkit/core/client";\nimport type { AppContract } from "../_brick/contract";\nimport React from "react";\nimport { x } from "./x";\n`,
      errors: 0,
    },
    {
      file: "web/bad.ts",
      code: `import { brick } from "@brickkit/core";\nimport { orders } from "../src/services/orders/orders.service";\nimport "../_brick/services.gen";\n`,
      errors: 3,
    },
  ],
  "no-global-context": [
    {
      file: `${S}/orders/context.ts`,
      code: `let ctx;\nexport function setOrdersContext(c) { ctx = c; }\n`,
      errors: 1,
    },
    {
      file: `${S}/orders/count.ts`,
      code: `let n = 0;\nn = 1;\nconst m = new Map();\n`,
      errors: 0,
    },
  ],
  "no-env-outside-secrets": [
    {
      file: "src/secrets.ts",
      code: `export const x = process.env.X;\n`,
      errors: 0,
    },
    {
      file: "brick.config.ts",
      code: `export default { dev: { port: Number(process.env.P) } };\n`,
      errors: 0,
    },
    {
      file: "src/db.ts",
      code: `const a = process.env.DB;\nconst b = Bun.env.DB;\n`,
      errors: 2,
    },
  ],
  "action-schemas": [
    {
      file: "src/a.ts",
      code: `s.action({ name: "a", input: x, output: y });\no.command("ship", { input: x, output: y });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.action({ name: "a", input: x });\no.command("ship", { decide });\ndefineTool({ name: "t", output: y });\n`,
      errors: 3,
    },
  ],
  "declared-errors": [
    {
      file: "src/a.ts",
      code: `s.action({ name: "a", errors: { NOT_PAID: {} }, execute: ({ error }) => { if (x) return error.NOT_PAID(); return error.NOT_FOUND(); } });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.action({ name: "a", execute: ({ error }) => error.NOT_PAID() });\n`,
      errors: 1,
    },
  ],
  "return-error": [
    {
      file: "src/a.ts",
      code: `s.action({ name: "a", execute: ({ error }) => { if (x) return error.NOT_FOUND(); throw error.CONFLICT(); } });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.action({ name: "a", execute: ({ error }) => {\n  if (x) error.NOT_FOUND();\n} });\n`,
      errors: 1,
      output: `s.action({ name: "a", execute: ({ error }) => {\n  if (x) return error.NOT_FOUND();\n} });\n`,
    },
  ],
  "path-params-in-input": [
    {
      file: "src/a.ts",
      code: `s.action({ name: "a", path: "/:id/summary", input: t.Object({ id: t.String() }) });\no.action({ name: "b", path: "/:id/x", record: true, input: t.Object({}) });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.action({ name: "a", path: "/:id/:slug", input: t.Object({ id: t.String() }) });\n`,
      errors: 1,
    },
  ],
  "get-is-read-only": [
    {
      file: "src/a.ts",
      code: `s.action({ name: "a", method: "GET", execute: ({ ctx }) => { cache.delete(k); return ctx.db.select().from(x); } });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.action({ name: "a", method: "GET", execute: async ({ ctx }) => { await ctx.db.insert(x).values({}); await emitEvent(ctx, "a.b", {}); } });\n`,
      errors: 2,
    },
  ],
  "emit-in-transaction": [
    {
      file: "src/a.ts",
      code: `await db.transaction(async (tx) => { await emitEvent(ctx, "o.p", p, { tx }); live.emit("doc:1", "updated", c, { after: tx }); });\nlive.emit("doc:1", "updated", c);\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `await db.transaction(async (tx) => {\n  live.emit("doc:1", "updated", c);\n});\n`,
      errors: 1,
      output: `await db.transaction(async (tx) => {\n  live.emit("doc:1", "updated", c, { after: tx });\n});\n`,
    },
  ],
  "deterministic-workflow": [
    {
      file: "src/a.workflow.ts",
      code: `export async function w() {\n  "use workflow";\n  await step();\n}\nasync function step() {\n  "use step";\n  return fetch(Date.now());\n}\n`,
      errors: 0,
    },
    {
      file: "src/b.workflow.ts",
      code: `export async function w(ctx) {\n  "use workflow";\n  const a = Date.now() + Math.random();\n  await fetch("x");\n  return ctx.db;\n}\n`,
      errors: 4,
    },
  ],
  "idempotent-listener": [
    {
      file: "src/a.ts",
      code: `defineListener({ name: "a", run: ({ deliveryId, ctx }) => ctx.db.insert(t).values({ id: deliveryId }) });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `defineListener({ name: "b", run: ({ ctx }) => ctx.db.insert(t).values({}) });\n`,
      errors: 1,
    },
  ],
  "socket-schemas": [
    {
      file: "src/a.ts",
      code: `s.socket({ name: "live", input: { typing: t.Object({ doc: t.String() }) }, output: {} });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.socket({ name: "live", input: { $join: t.Object({}), at: t.String({ format: "date-time" }) }, output: { $left: t.Object({}) } });\n`,
      errors: 3,
    },
  ],
  "no-unregistered-format": [
    {
      file: "src/a.ts",
      code: `FormatRegistry.Set("slug", (v) => true);\nconst A = t.String({ format: "slug" });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `const A = t.String({ format: "email" });\n`,
      errors: 1,
    },
  ],
  "no-floating-calls": [
    {
      file: "src/a.ts",
      code: `const billing = useService(b, { from: "orders" });\nasync function f() { await billing.charge({}); void emitEvent(ctx, "a.b", {}); }\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `const billing = useService(b);\nasync function f() {\n  billing.charge({});\n}\n`,
      errors: 1,
      output: `const billing = useService(b);\nasync function f() {\n  await billing.charge({});\n}\n`,
    },
  ],
  "explicit-access": [
    {
      file: "src/a.ts",
      code: `s.action({ name: "a", authorize: () => true });\ns.action({ name: "b", access: "public" });\nr.use(crud({ access: "public" }));\nr.action({ name: "c", record: true, access: "public" });\nr.command("d", { access: { scope } });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.action({ name: "a" });\nr.use(crud({ fields: {} }));\nr.use(crud({ access: "public" }));\nr.action({ name: "c", record: true, authorize: () => true });\nr.command("d", { authorize: () => true });\n`,
      errors: 4,
    },
  ],
  "socket-authorize": [
    {
      file: "src/a.ts",
      code: `s.socket({ name: "a", authorize: () => true, join: () => true });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.socket({ name: "a", authorize: () => true });\ns.socket({ name: "b", public: true });\n`,
      errors: 2,
    },
  ],
  "no-wildcard-origins": [
    {
      file: "src/a.ts",
      code: `const o = { allowedOrigins: ["https://a.dev"] };\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `const o = { allowedOrigins: ["*"], trustedOrigins: "*" };\n`,
      errors: 2,
    },
  ],
  "strict-input": [
    {
      file: "src/a.ts",
      code: `s.action({ name: "a", input: t.Object({}, { additionalProperties: false }) });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.action({ name: "a", input: t.Object({ id: t.String() }) });\n`,
      errors: 1,
      output: `s.action({ name: "a", input: t.Object({ id: t.String() }, { additionalProperties: false }) });\n`,
    },
  ],
  "description-required": [
    {
      file: "src/a.ts",
      code: `s.action({ name: "a", description: "A" });\ndefineService("o", { events: { placed: t.Object({}, { description: "Placed" }) } });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.socket({ name: "a" });\ndefineService("o", { events: { placed: t.Object({}) } });\n`,
      errors: 2,
    },
  ],
  naming: [
    {
      file: "src/a.ts",
      code: `s.action({ name: "getUser" });\no.command("ship", {});\nawait emitEvent(ctx, "order.shipped", {});\nlive.emit(\`doc:\${id}\`, "updated", {});\ndefineService("o", { events: { itemAdded: x, sent: y } });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.action({ name: "user_get" });\nawait emitEvent(ctx, "ship-order", {});\nlive.emit("everyone", "updated", {});\ndefineService("o", { events: { place: x } });\n`,
      errors: 4,
    },
  ],
  "no-console": [
    {
      file: "src/a.ts",
      code: `console.log("boot");\ns.action({ name: "a", execute: ({ ctx }) => ctx.logger.info("x") });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `s.action({ name: "a", execute: () => console.log("x") });\n`,
      errors: 1,
    },
  ],
  "plugin-manifest": [
    {
      file: "src/a.ts",
      code: `definePlugin({ name: "@acme/brick-comments", brick: "^0.11.0", options: t.Object({ maxLength: t.Integer({ default: 2000, description: "Longest comment" }) }), app: ({ on }) => { let client; on("start", async () => { client = new RedisClient(); await client.connect(); }); } });\n`,
      errors: 0,
    },
    {
      file: "src/b.ts",
      code: `definePlugin({ name: "comments", app: async () => {} });\n`,
      errors: 4,
    },
    {
      file: "src/c.ts",
      code: `definePlugin({ name: "@acme/brick-cache", brick: "^0.11.0", options: t.Object({ ttl: t.Integer({ default: 60 }) }), tables: async () => ({}), app: () => { const client = createClient(); } });\n`,
      errors: 3,
    },
  ],
};

describe("lint file rules", () => {
  it("has valid and invalid cases for every rule", () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(rules).sort());
  });

  for (const [rule, cases] of Object.entries(CASES))
    it(rule, () => {
      const result = lintCases(rule, cases);
      for (const c of cases) {
        expect({ file: c.file, errors: result.count(c.file) }).toEqual({
          file: c.file,
          errors: c.errors,
        });
        if (c.output !== undefined)
          expect(result.output(c.file)).toBe(c.output);
      }
      for (const message of result.messages) {
        expect(message.rule).toBe(`brick/${rule}`);
        expect(message.line).toBeGreaterThan(0);
      }
    });

  it("takes the formats option of no-unregistered-format", () => {
    const result = lintCases(
      "no-unregistered-format",
      [
        {
          file: "src/a.ts",
          code: `const A = t.String({ format: "email" });\n`,
          errors: 0,
        },
      ],
      { ruleOptions: { formats: ["email"] } },
    );
    expect(result.messages).toEqual([]);
  });

  it("points no-global-context at deps", () => {
    const result = lintCases("no-global-context", [
      {
        file: `${S}/orders/context.ts`,
        code: `export let carrier;\nexport function setCarrier(c) { carrier = c; }\n`,
        errors: 1,
      },
    ]);
    expect(result.messages[0]?.message).toContain("ctx.deps");
    expect(result.messages[0]?.message).toContain("useDeps()");
  });

  it("maps every define* export of @brickkit/core, or ignores it on purpose", () => {
    // Not definitions the rules check: values, errors and low-level plugin builders.
    const ignored = [
      "defineDatabase",
      "defineError",
      "defineSecret",
      "defineServicePlugin",
      "defineResourcePlugin",
    ];
    for (const name of Object.keys(core).filter((key) =>
      key.startsWith("define"),
    ))
      expect([
        name,
        name in DEFINE_FUNCTIONS || ignored.includes(name),
      ]).toEqual([name, true]);
  });
});
