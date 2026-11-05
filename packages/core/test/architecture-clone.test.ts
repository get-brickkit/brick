import { describe, expect, it } from "bun:test";
import { defineService, getGlobalRegistry } from "../src";

describe("architecture export", () => {
  it("can be structured-cloned when a service sets functions in its options", () => {
    const docs = defineService("architecture_clone_docs", {
      context: () => ({ tenant: "acme" }),
    });

    const architecture = getGlobalRegistry().exportArchitecture({
      services: [docs],
      routes: [],
    });

    // The dev dashboard sends the architecture over IPC, which uses structured
    // clone and throws on functions. The schema is data, so no function is in it.
    expect(() => structuredClone(architecture)).not.toThrow();
    expect(architecture.services[0].options).toEqual({});
  });
});
