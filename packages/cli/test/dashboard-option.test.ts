import { beforeEach, describe, expect, it } from "bun:test";
import { defineService, resetGlobalRegistry, brick } from "@brickkit/core";

const token = "0123456789abcdef-secret";

describe("brick({ dashboard })", () => {
  beforeEach(() => resetGlobalRegistry());
  const services = () => [defineService("pages", {})];

  it("records the dashboard on the app definition, and turns telemetry on with it", () => {
    expect(
      brick({ services: services() }).definition.dashboard,
    ).toBeUndefined();
    expect(brick({ services: services() }).definition.telemetry).toBe(false);
    const { definition } = brick({
      services: services(),
      dashboard: { port: 9500, host: " 0.0.0.0 ", historyDays: 7 },
    });
    expect(definition.dashboard).toEqual({
      port: 9500,
      host: "0.0.0.0",
      historyDays: 7,
    });
    expect(definition.telemetry).toBe(true);
    expect(Object.isFrozen(definition.dashboard)).toBe(true);
  });

  it("keeps the secrets out of what logging the definition prints", () => {
    const authorize = () => true;
    const { definition } = brick({
      services: services(),
      dashboard: { auth: { token: [token], authorize } },
    });
    // Reachable for the server that uses them...
    expect(definition.dashboard?.auth?.token).toEqual([token]);
    expect(definition.dashboard?.auth?.authorize).toBe(authorize);
    // ...but not among the fields that are printed or serialized.
    expect(JSON.stringify(definition.dashboard)).not.toContain(token);
    expect(Bun.inspect(definition.dashboard)).not.toContain(token);
    expect(Object.keys(definition.dashboard!)).not.toContain("auth");
  });

  it("accepts a single token or an authorize function alone", () => {
    expect(
      brick({ services: services(), dashboard: { auth: { token } } }).definition
        .dashboard?.auth?.token,
    ).toEqual([token]);
    expect(
      brick({
        services: services(),
        dashboard: { auth: { authorize: () => false } },
      }).definition.dashboard?.auth?.authorize,
    ).toBeFunction();
  });

  it("refuses settings that cannot work", () => {
    const build = (dashboard: object) => () =>
      brick({ services: services(), dashboard });
    expect(build({ port: 0 })).toThrow(
      /port must be an integer from 1 to 65535/,
    );
    expect(build({ port: 70000 })).toThrow(/port/);
    expect(build({ port: 94.5 })).toThrow(/port/);
    expect(build({ host: " " })).toThrow(/host must be an address/);
    expect(build({ historyDays: -1 })).toThrow(/historyDays/);
    expect(build({ historyDays: 1.5 })).toThrow(/historyDays/);
    expect(build({ auth: { token: "short" } })).toThrow(
      /at least 16 characters/,
    );
    expect(build({ auth: { token: [token, "short"] } })).toThrow(
      /at least 16 characters/,
    );
    expect(build({ auth: {} })).toThrow(/needs a token or an authorize/);
    expect(build({ auth: { token: [] } })).toThrow(
      /needs a token or an authorize/,
    );
    expect(build({ auth: { authorize: "yes" } })).toThrow(
      /authorize must be a function/,
    );
  });
});
