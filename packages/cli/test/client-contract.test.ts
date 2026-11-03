import { beforeEach, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { brick, defineService, resetGlobalRegistry, t } from "@brickkit/core";
import { createBrickClient } from "@brickkit/core/client";
import { generateClientContract } from "../src/client-contract";

beforeEach(resetGlobalRegistry);

async function checkTypes(dir: string, types: string): Promise<void> {
  const root = resolve(import.meta.dir, "../../..");
  await Bun.write(join(dir, "types.ts"), types);
  await Bun.write(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: join(root, "tsconfig.json"),
      compilerOptions: { noEmit: true },
      include: ["*.ts"],
    }),
  );
  const proc = Bun.spawn(
    [
      process.execPath,
      "x",
      "--no-install",
      "tsc",
      "-p",
      join(dir, "tsconfig.json"),
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(out + err).toBe("");
  expect(code).toBe(0);
}

async function checkContractTypes(
  source: string,
  types: string,
): Promise<void> {
  const root = resolve(import.meta.dir, "../../../.brick");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "contract-types-"));
  try {
    await Bun.write(join(dir, "contract.ts"), source);
    await checkTypes(dir, types);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it("generates a typed browser contract from two services without an action list", async () => {
  const root = resolve(import.meta.dir, "../../..");
  await mkdir(join(root, ".brick"), { recursive: true });
  const dir = await mkdtemp(join(root, ".brick/client-test-"));
  try {
    const output = join(dir, "contract.ts");
    const app = (await import("./fixtures/client-app")).default;
    await Bun.write(output, generateClientContract(app));
    const { contract } = await import(output);
    expect(Object.keys(contract)).toEqual(["records", "users"]);
    expect(Object.keys(contract.records)).toEqual(["get_value", "search"]);
    expect(Object.keys(contract.users)).toEqual(["profile", "update"]);
    expect(contract.records.get_value.config).toEqual({
      path: "/v2/records/:doctype/value",
      method: "POST",
    });
    expect(contract.records.search.config.path).toBe("/v2/records/search");
    expect(JSON.stringify(contract)).not.toContain("execute");

    const bundle = await Bun.build({
      entrypoints: [output],
      target: "browser",
    });
    expect(bundle.success).toBe(true);
    const browserSource = await bundle.outputs[0]!.text();
    expect(browserSource).not.toContain("__backend_only__");
    expect(browserSource).not.toContain("defineService");
    expect(browserSource).not.toContain("bun:sqlite");

    await checkTypes(
      dir,
      `
import { createBrickClient, type InferActionErrorCodes } from "@brickkit/core/client";
import { contract, type AppContract } from "./contract";
const api = createBrickClient<AppContract>({ baseUrl: "http://localhost", contract });
const inferred = createBrickClient({ baseUrl: "http://localhost", contract });
const inferredValue: Promise<string> = inferred.records.get_value({ doctype: "CRMDeal", fields: [] });
// @ts-expect-error Inference preserves input types without an explicit generic.
inferred.records.get_value({ doctype: "Other", fields: [] });
const value: Promise<string> = api.records.get_value({ doctype: "CRMDeal", fields: ["name"] });
const search: Promise<string[]> = api.records.search({ term: "hello" });
const profile: Promise<{ id: string; roles: ("admin" | "member")[] }> = api.users.profile.get({ id: "u1" });
const update: Promise<boolean> = api.users.update({ id: "u1", name: "Sam" });
const code: InferActionErrorCodes<AppContract["records"]["get_value"]> = "MISSING";
// @ts-expect-error Missing fields.
api.records.get_value({ doctype: "CRMDeal" });
// @ts-expect-error Invalid doctype literal.
api.records.get_value({ doctype: "Other", fields: [] });
// @ts-expect-error Wrong input type.
api.records.search({ term: 42 });
// @ts-expect-error Non-HTTP tools are absent.
api.records.private_tool();
// @ts-expect-error Unknown action.
api.users.missing();

// The contract also types useService on the server.
import { defineService, useService } from "@brickkit/core";
const records = useService(defineService("records"), { from: "users" });
const viaService: Promise<string> = records.get_value({ doctype: "CRMDeal", fields: [] });
// @ts-expect-error A renamed action is a compile error.
records.getValue({ doctype: "CRMDeal", fields: [] });
// @ts-expect-error So is a changed input.
records.search({ term: 42 });
const users = useService(defineService("users"));
const nested: Promise<{ id: string; roles: ("admin" | "member")[] }> = users.profile.get({ id: "u1" });
`,
    );

    const calls: { url: string; init?: RequestInit }[] = [];
    const api = createBrickClient<any>({
      baseUrl: "http://localhost",
      contract,
      fetch: (url, init) => {
        calls.push({ url: String(url), init });
        return app.handle(new Request(url, init));
      },
    });
    expect(
      await api.records.get_value({ doctype: "CRMDeal", fields: ["name"] }),
    ).toBe("CRMDeal:name");
    expect(calls[0]!.url).toBe("http://localhost/v2/records/CRMDeal/value");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      fields: ["name"],
    });
    expect(await api.records.search({ term: "hello" })).toEqual(["hello"]);
    expect(await api.users.profile.get({ id: "a b", details: true })).toEqual({
      id: "a b",
      roles: ["member"],
    });
    expect(calls[2]!.url).toBe("http://localhost/v2/users/a%20b?details=true");
    expect(await api.users.update({ id: "u1", name: "Sam" })).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 20000);

it("rejects ambiguous namespaces and unsupported schemas instead of silently weakening types", () => {
  const service = defineService("records");
  service.action({ name: "lookup", execute: () => "ok" });
  service.action({ name: "lookup.detail", execute: () => "ok" });
  expect(() =>
    generateClientContract(
      brick({ services: [service], requestLogging: false }),
    ),
  ).toThrow("namespace collision");
  const unsupported = defineService("unsupported");
  const action = unsupported.action({
    name: "ref",
    input: t.String(),
    execute: () => "ok",
  });
  const app = brick({ services: [unsupported], requestLogging: false });
  action.config.input = t.Ref("Missing") as any;
  expect(() => generateClientContract(app)).toThrow(
    "unresolved schema reference 'Missing'",
  );
});

it("resolves recursive TypeBox schemas and local references without weakening client types", async () => {
  const json = t.Recursive(
    (self) =>
      t.Union([
        t.Null(),
        t.Boolean(),
        t.Number(),
        t.String(),
        t.Array(self),
        t.Record(t.String(), self),
      ]),
    { $id: "T0", title: "JsonValue" },
  );
  const service = defineService("crm");
  service.action({
    name: "crm_get_fields_layout",
    input: t.Object({ filters: json }),
    output: t.Object({
      tabs: t.Array(
        t.Object({
          sections: t.Array(
            t.Object({
              columns: t.Array(
                t.Object({
                  fields: t.Array(t.Object({ link_filters: json })),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
    execute: () => ({ tabs: [] }),
  });
  service.action({
    name: "tree",
    // Reusing an ID in a different document must not resolve to the JSON union.
    output: t.Recursive(
      (self) => t.Object({ value: t.Number(), children: t.Array(self) }),
      { $id: "T0" },
    ),
    execute: () => ({ value: 1, children: [] }),
  });
  const local = service.action({
    name: "local",
    output: t.String(),
    execute: () => "ok",
  });
  const app = brick({ services: [service], requestLogging: false });
  // Forward references, mutual recursion, and escaped JSON Pointer segments.
  local.config.output = {
    $ref: "#/$defs/a~1b~0c",
    $defs: {
      "a/b~c": {
        type: "object",
        properties: { next: { $ref: "#/$defs/other" } },
      },
      other: {
        type: "object",
        properties: {
          value: { type: "string" },
          next: { $ref: "#/$defs/a~1b~0c" },
        },
        required: ["value"],
      },
    },
  } as any;
  const source = generateClientContract(app);
  expect(source).toContain("export type BrickJsonValue =");
  expect(source).toContain("Array<BrickJsonValue>");
  expect(source).toContain("{ [key: string]: BrickJsonValue }");
  expect(source).toContain("export type BrickT0 =");
  expect(source.split("export type AppContract")[0]).not.toContain("unknown");

  await checkContractTypes(
    source,
    `
import { createBrickClient } from "@brickkit/core/client";
import { contract } from "./contract";
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const api = createBrickClient({ baseUrl: "http://localhost", contract });
api.crm.crm_get_fields_layout({ filters: { nested: [null, true, 1, "hello", { deeper: [] }] } });
// @ts-expect-error Functions are not JSON values, even deep inside a recursive branch.
api.crm.crm_get_fields_layout({ filters: { nested: [{ invalid: () => 1 }] } });
// @ts-expect-error Undefined is not a JSON value.
api.crm.crm_get_fields_layout({ filters: { nested: undefined } });
async function check() {
  const layout = await api.crm.crm_get_fields_layout({ filters: null });
  const filters: JsonValue = layout.tabs[0]!.sections[0]!.columns[0]!.fields[0]!.link_filters;
  // @ts-expect-error The generated union must not be any.
  const invalid: string = filters;
  const tree = await api.crm.tree();
  const value: number = tree.children[0]!.children[0]!.value;
  // @ts-expect-error Recursive tree values remain numbers.
  const wrong: string = tree.children[0]!.value;
  const local = await api.crm.local();
  const text: string | undefined = local.next?.next?.next?.value;
}
`,
  );
}, 20000);

it("reports missing local reference targets with the action name", () => {
  const service = defineService("refs");
  const action = service.action({
    name: "missing",
    output: t.String(),
    execute: () => "ok",
  });
  const app = brick({ services: [service], requestLogging: false });
  action.config.output = { $ref: "#/$defs/Missing", $defs: {} } as any;
  expect(() => generateClientContract(app)).toThrow(
    "Brick client: cannot generate 'refs.missing': unresolved schema reference '#/$defs/Missing'",
  );
});

it("shares profitable transport shapes across actions while preserving exact filter types", async () => {
  const operator = t.Union(
    [
      "=",
      "!=",
      ">",
      ">=",
      "<",
      "<=",
      "like",
      "not like",
      "in",
      "not in",
      "is",
      "between",
    ].map((value) => t.Literal(value)),
  );
  const condition = (bounded: boolean) => {
    const scalar = t.Union([
      t.String(bounded ? { maxLength: 140 } : {}),
      t.Null(),
    ]);
    const operand = t.Union([
      scalar,
      t.Array(scalar),
      t.Literal("set"),
      t.Literal("not set"),
    ]);
    return t.Union([scalar, t.Tuple([operator, operand])]);
  };
  const service = defineService("filters");
  for (let i = 0; i < 12; i++) {
    service.action({
      name: `query${i}`,
      input: t.Object({
        name: t.Optional(condition(false)),
        creation: condition(true),
        choice: t.Union([
          t.Object({ kind: t.Literal("text"), value: t.String() }),
          t.Object({ kind: t.Literal("count"), value: t.Number() }),
        ]),
      }),
      output: t.Array(condition(i % 2 === 0)),
      execute: () => [],
    });
  }
  const app = brick({ services: [service], requestLogging: false });
  const source = generateClientContract(app);
  expect(generateClientContract(app)).toBe(source);
  expect(source.match(/"not like"/g)).toHaveLength(1);
  expect(source).toContain("export type BrickSchema_");
  expect(source).not.toMatch(/export type \w+ = (string|number|null);/);
  expect(source).not.toContain("\0");
  // A literal that resembles source or an internal marker must remain a literal.
  const odd = service.action({
    name: "odd",
    output: t.Literal("BrickSchema_abc | string\0"),
    execute: () => "BrickSchema_abc | string\0" as const,
  });
  expect(generateClientContract(app)).toContain(
    JSON.stringify(odd.config.output!.const),
  );
  await checkContractTypes(
    source,
    `
import type { InferActionInput, InferActionOutput } from "@brickkit/core/client";
import type { AppContract } from "./contract";
type Operator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "like" | "not like" | "in" | "not in" | "is" | "between";
type Scalar = string | null;
type Condition = Scalar | [Operator, Scalar | Scalar[] | "set" | "not set"];
type Expected = {
  name?: Condition;
  creation: Condition;
  choice: { kind: "text"; value: string } | { kind: "count"; value: number };
};
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type Input = Assert<Equal<InferActionInput<AppContract["filters"]["query0"]>, Expected>>;
type Output = Assert<Equal<InferActionOutput<AppContract["filters"]["query11"]>, Condition[]>>;
`,
  );
}, 20000);

it("keeps small fragments inline and generated alias names stable as unrelated actions are added", () => {
  const service = defineService("small");
  service.action({
    name: "one",
    input: t.Object({
      a: t.String(),
      b: t.String(),
      c: t.Union([t.Null(), t.String()]),
    }),
    execute: () => true,
  });
  const app = brick({ services: [service], requestLogging: false });
  expect(generateClientContract(app)).not.toContain("export type BrickSchema_");
  const large = t.Object(
    Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`field${i}`, t.String()]),
    ),
  );
  service.action({
    name: "large",
    input: large,
    output: large,
    execute: () => ({}) as any,
  });
  const before = generateClientContract(app).match(
    /export type (BrickSchema_\w+)/g,
  );
  service.action({
    name: "unrelated",
    output: t.Array(t.Boolean()),
    execute: () => [],
  });
  expect(
    generateClientContract(app).match(/export type (BrickSchema_\w+)/g),
  ).toEqual(before);
});

it("does not share identical reference spellings from different document scopes", () => {
  const service = defineService("scopes");
  const app = brick({ services: [service], requestLogging: false });
  for (const [name, type] of [
    ["text", "string"],
    ["count", "number"],
  ] as const) {
    const action = service.action({
      name,
      output: t.String(),
      execute: () => "ok",
    });
    action.config.output = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          `field${i}`,
          { $ref: "#/$defs/Value" },
        ]),
      ),
      required: ["field0"],
      $defs: { Value: { type } },
    } as any;
  }
  const source = generateClientContract(app);
  expect(source).toContain("export type BrickSchema = string;");
  expect(source).toContain("export type BrickSchema_2 = number;");
  expect(source).toContain('"field0": BrickSchema;');
  expect(source).toContain('"field0": BrickSchema_2;');
});
