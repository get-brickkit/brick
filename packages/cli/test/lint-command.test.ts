import { afterEach, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const cli = resolve(import.meta.dir, "../src/bin.ts");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const S = "src/services";
const BASE: Record<string, string> = {
  "src/app.ts": `import { brick } from "@brickkit/core";
import "../_brick/services.gen";
import { orders } from "./services/orders/orders.service";
import { billing } from "./services/billing/billing.service";

export default brick({ services: [orders, billing] });
`,
  [`${S}/orders/orders.service.ts`]: `import { defineDatabase, defineService } from "@brickkit/core";
import { ordersTable } from "./tables/orders.table";

export const orders = defineService("orders", {
  database: defineDatabase({ tables: { ordersTable } }),
});
`,
  [`${S}/orders/tables/orders.table.ts`]: `import { sqliteTable, text } from "@brickkit/core";

export const ordersTable = sqliteTable("orders", { id: text("id").primaryKey() });
`,
  [`${S}/orders/schema.ts`]: `export { ordersTable } from "./tables/orders.table";\n`,
  [`${S}/orders/actions/get-summary.action.ts`]: `import { t } from "@brickkit/core";
import { orders } from "../orders.service";

export default orders.action({
  name: "getSummary",
  input: t.Object({}),
  output: t.Object({ count: t.Number() }),
  authorize: () => true,
  execute: () => ({ count: 0 }),
});
`,
  [`${S}/orders/actions/get-summary.test.ts`]: "export {};\n",
  [`${S}/billing/billing.service.ts`]: `import { defineService } from "@brickkit/core";

export const billing = defineService("billing");
`,
};

async function project(files: Record<string, string>) {
  const root = await mkdtemp(resolve(import.meta.dir, "../.brick-lint-test-"));
  roots.push(root);
  for (const [file, source] of Object.entries(files))
    await Bun.write(join(root, file), source);
  return root;
}

async function lint(root: string) {
  const child = Bun.spawn([process.execPath, cli, "lint"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

it("passes a project laid out by the rules", async () => {
  const root = await project({
    ...BASE,
    "brick.config.ts": `export default { lint: { presets: ["recommended", "layout"], rules: { "brick/test-colocated": "error" } } };\n`,
  });
  const result = await lint(root);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("No lint problems");
  expect(result.code).toBe(0);
});

it("reports file and app rules with file:line, and fails on errors", async () => {
  const root = await project({
    ...BASE,
    "brick.config.ts": `export default { lint: { presets: ["recommended", "layout"], rules: { "brick/test-colocated": "warn" } } };\n`,
    [`${S}/billing/actions/charge.action.ts`]: `import { t } from "@brickkit/core";
import { billing } from "../billing.service";
import { ordersTable } from "../../orders/tables/orders.table";

export default billing.action({
  name: "charge",
  input: t.Object({}),
  output: t.Object({}),
  execute: () => ({ table: String(ordersTable) }),
});
`,
    [`${S}/billing/lib/report.ts`]: `import { ordersTable } from "../../orders/schema";\n\nexport const source = ordersTable;\n`,
    "src/extra.ts": `import { brick } from "@brickkit/core";\n\nexport const second = brick({});\n`,
  });
  const result = await lint(root);
  expect(result.stderr).toBe("");
  const lines = result.stdout.split("\n");
  const has = (file: string, rule: string, severity = "error") =>
    expect(
      lines.some(
        (line) =>
          line.startsWith(file) &&
          line.includes(`  ${severity}  `) &&
          line.endsWith(rule),
      ),
    ).toBe(true);
  has(
    `${S}/billing/actions/charge.action.ts:3:1`,
    "brick/no-cross-service-tables",
  );
  has(`${S}/billing/actions/charge.action.ts:6:`, "brick/explicit-access");
  has(
    `${S}/billing/actions/charge.action.ts:1:1`,
    "brick/test-colocated",
    "warning",
  );
  has(`${S}/billing/lib/report.ts:1:1`, "brick/no-cross-service-tables");
  has("src/extra.ts:3:", "brick/single-app-entry");
  expect(result.stdout).toContain("✖ 5 problems (4 errors, 1 warning)");
  expect(result.code).toBe(1);
});

it("refuses to turn off no-cross-service-tables", async () => {
  const root = await project({
    ...BASE,
    "brick.config.ts": `export default { lint: { rules: { "brick/no-cross-service-tables": "off" } } };\n`,
  });
  const result = await lint(root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("always an error and cannot be turned off");
});

it("declared-events checks emitted names against the service's catalog", async () => {
  const root = await project({
    ...BASE,
    "brick.config.ts": `export default { lint: { presets: [], rules: { "brick/declared-events": "error" } } };\n`,
    [`${S}/billing/billing.service.ts`]: `import { defineDatabase, defineService, sqliteTable, text, t } from "@brickkit/core";

const invoices = sqliteTable("invoices", { id: text("id").primaryKey() });
export const billing = defineService("billing", {
  database: defineDatabase({ tables: { invoices } }),
  events: { charged: t.Object({ id: t.String() }) },
});
billing.resource({ name: "invoice", table: invoices });
`,
    [`${S}/billing/listeners/emit.ts`]: `import { emitEvent } from "@brickkit/core";

export const ok = (ctx: any) => emitEvent(ctx, "billing.charged", { id: "1" });
export const bad = (ctx: any) => emitEvent(ctx, "billing.refunded", {});
export const crud = (ctx: any) => emitEvent(ctx, "invoice.create", {});
export const notCrud = (ctx: any) => emitEvent(ctx, "invoice.archive", {});
`,
  });
  const result = await lint(root);
  expect(result.stderr).toBe("");
  const problems = result.stdout
    .split("\n")
    .filter((line) => line.endsWith("brick/declared-events"));
  expect(problems).toHaveLength(2);
  expect(problems[0]).toStartWith(`${S}/billing/listeners/emit.ts:4:`);
  expect(problems[0]).toContain(`"billing.refunded"`);
  expect(problems[1]).toStartWith(`${S}/billing/listeners/emit.ts:6:`);
  expect(problems[1]).toContain(`"invoice.archive"`);
});
