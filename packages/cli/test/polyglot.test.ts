import { describe, expect, it } from "bun:test";
import {
  goClient,
  rustClient,
  writePolyglotContract,
  type PolyglotContract,
} from "../src/polyglot";

const contract = (input: unknown): PolyglotContract => ({
  version: 1,
  services: [
    { name: "self", language: "go", actions: [], errors: {} },
    {
      name: "tags",
      language: "ts",
      actions: [{ name: "count", input, output: { type: "number" } }],
      errors: {},
    },
  ],
});

describe("polyglot clients", () => {
  it("maps a TypeBox Record (patternProperties) to a map, not an empty struct", () => {
    const record = {
      type: "object",
      patternProperties: { "^(.*)$": { type: "integer" } },
    };
    expect(goClient(contract(record), "self")).toContain(
      "func TagsCount(ctx context.Context, in map[string]int64) (float64, error)",
    );
    expect(rustClient(contract(record), "self")).toContain(
      "input: &std::collections::HashMap<String, i64>",
    );
  });

  it("renames Rust fields that can't be raw identifiers", () => {
    const input = {
      type: "object",
      properties: { self: { type: "string" }, type: { type: "string" } },
      required: ["self", "type"],
    };
    const source = rustClient(contract(input), "self");
    expect(source).toContain("pub self_: String,");
    expect(source).toContain("pub r#type: String,");
  });

  it("writes no Go imports when no other service has actions", () => {
    const source = goClient(contract(undefined), "tags");
    expect(source).not.toContain("import");
    expect(source).toContain("package brickclient");
  });

  it("never overwrites the app entry with the TS contract", async () => {
    await expect(
      writePolyglotContract("src/app.ts", "src/app.ts"),
    ).rejects.toThrow("must not overwrite the app entry");
  });
});
