import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  defineSecret,
  resolveSecrets,
  listSecrets,
  overrideSecret,
  resetSecrets,
  type SecretSource,
} from "../src/secrets";

const ENV_KEYS = ["BRICK_TEST_REQ", "BRICK_TEST_OPT", "BRICK_TEST_MISSING"];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  resetSecrets();
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetSecrets();
});

describe("defineSecret() type-safe env loading", () => {
  it("returns the default when env is unset", () => {
    const s = defineSecret("BRICK_TEST_OPT", { default: "fallback" });
    expect(s.value()).toBe("fallback");
    expect(s.require()).toBe("fallback");
    expect(s.isSet()).toBe(true);
  });

  it("prefers env over the default", () => {
    process.env.BRICK_TEST_OPT = "from-env";
    const s = defineSecret("BRICK_TEST_OPT", { default: "fallback" });
    expect(s.value()).toBe("from-env");
    expect(s.require()).toBe("from-env");
  });

  it("require() throws naming the missing secret", () => {
    const s = defineSecret("BRICK_TEST_MISSING");
    expect(s.value()).toBeUndefined();
    expect(s.isSet()).toBe(false);
    expect(() => s.require()).toThrow(
      'Missing required secret "BRICK_TEST_MISSING"',
    );
  });

  it("re-declaring the same name returns the same ref, set to the new declaration", () => {
    let checks = 0;
    const declare = (fallback: string) =>
      defineSecret("BRICK_TEST_REQ", { default: fallback }).validate(() => {
        checks++;
      });
    const a = declare("early");
    const b = declare("late");
    expect(b).toBe(a);
    expect(b.value()).toBe("late");
    // A module evaluated twice declares its validator twice; it still runs once.
    expect(checks).toBe(1);
  });

  it("resolveSecrets() throws listing all missing required secrets", () => {
    defineSecret("BRICK_TEST_REQ");
    defineSecret("BRICK_TEST_MISSING");
    defineSecret("BRICK_TEST_OPT", { default: "fallback" });
    expect(() => resolveSecrets()).toThrow(
      "Missing required secrets: BRICK_TEST_REQ, BRICK_TEST_MISSING",
    );
  });

  it("resolveSecrets() passes when everything is set and returns values", () => {
    process.env.BRICK_TEST_REQ = "req-val";
    defineSecret("BRICK_TEST_REQ");
    defineSecret("BRICK_TEST_OPT", { default: "fallback" });
    expect(resolveSecrets()).toEqual({
      BRICK_TEST_OPT: "fallback",
      BRICK_TEST_REQ: "req-val",
    });
  });

  it("resolveSecrets() is a no-op when nothing is registered", () => {
    expect(resolveSecrets()).toEqual({});
  });

  it("overrides win over env and defaults", () => {
    process.env.BRICK_TEST_OPT = "from-env";
    const s = defineSecret("BRICK_TEST_OPT", { default: "fallback" });
    overrideSecret("BRICK_TEST_OPT", "override");
    expect(s.value()).toBe("override");
    overrideSecret("BRICK_TEST_OPT", undefined);
    expect(s.value()).toBe("from-env");
  });

  it("accepts a custom source without touching call sites", () => {
    const staticSource: SecretSource = {
      get: (name) => (name === "BRICK_TEST_REQ" ? "from-source" : undefined),
    };
    const s = defineSecret("BRICK_TEST_REQ");
    expect(s.value(staticSource)).toBe("from-source");
    expect(resolveSecrets({ source: staticSource })).toEqual({
      BRICK_TEST_REQ: "from-source",
    });
  });

  describe("defineSecret() fluent chain", () => {
    it("default().transform().require() converts types", () => {
      const portRef = defineSecret("BRICK_TEST_REQ")
        .default("3333")
        .transform(Number);
      expect(portRef.require()).toBe(3333);
      process.env.BRICK_TEST_REQ = "8080";
      expect(portRef.require()).toBe(8080);
    });

    it("transform failure names the secret", () => {
      process.env.BRICK_TEST_REQ = "raw";
      defineSecret("BRICK_TEST_REQ").transform(() => {
        throw new Error("boom");
      });
      expect(() => defineSecret("BRICK_TEST_REQ").require()).toThrow(
        'Invalid value for secret "BRICK_TEST_REQ": transform failed (boom)',
      );
    });

    it("validate() accepts, rejects with reason, and propagates throws", () => {
      process.env.BRICK_TEST_REQ = "sk_live_1";
      const key = defineSecret("BRICK_TEST_REQ").validate(
        (v) => v.startsWith("sk_") || "must start with sk_",
      );
      expect(key.require()).toBe("sk_live_1");

      process.env.BRICK_TEST_REQ = "nope";
      expect(() => key.require()).toThrow(
        'Invalid value for secret "BRICK_TEST_REQ": must start with sk_',
      );

      const throwing = defineSecret("BRICK_TEST_OPT").validate(() => {
        throw new Error("custom check");
      });
      process.env.BRICK_TEST_OPT = "x";
      expect(() => throwing.require()).toThrow(
        'Invalid value for secret "BRICK_TEST_OPT": custom check',
      );

      const boolCheck = defineSecret("BRICK_TEST_MISSING").validate(
        () => false,
      );
      overrideSecret("BRICK_TEST_MISSING", "x");
      expect(() => boolCheck.require()).toThrow(
        'Invalid value for secret "BRICK_TEST_MISSING": validation failed',
      );
    });

    it("url() validates URL shape", () => {
      process.env.BRICK_TEST_REQ = "http://localhost:3333";
      expect(defineSecret("BRICK_TEST_REQ").url().require()).toBe(
        "http://localhost:3333",
      );
      process.env.BRICK_TEST_REQ = "not a url";
      expect(() => defineSecret("BRICK_TEST_REQ").require()).toThrow(
        'Invalid value for secret "BRICK_TEST_REQ": must be a valid URL',
      );
    });

    it("validators run on defaults too", () => {
      const s = defineSecret("BRICK_TEST_OPT").default("not a url").url();
      expect(() => s.require()).toThrow(
        'Invalid value for secret "BRICK_TEST_OPT"',
      );
    });
  });

  it("listSecrets() exposes metadata without values", () => {
    process.env.BRICK_TEST_REQ = "req-val";
    defineSecret("BRICK_TEST_REQ");
    defineSecret("BRICK_TEST_OPT", { default: "fallback" });
    defineSecret("BRICK_TEST_MISSING");
    expect(listSecrets()).toEqual([
      { hasDefault: false, isSet: true, name: "BRICK_TEST_REQ" },
      { hasDefault: true, isSet: true, name: "BRICK_TEST_OPT" },
      { hasDefault: false, isSet: false, name: "BRICK_TEST_MISSING" },
    ]);
  });
});
