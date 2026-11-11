import { describe, expect, it } from "bun:test";
import { runSchedule } from "../dashboard/schedules";

const answer = (body: string, status = 200) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

describe("runSchedule", () => {
  it("says nothing when the schedule started", async () => {
    expect(await runSchedule("backup", answer('{"started":true}'))).toBeNull();
  });

  it("says why when it did not start", async () => {
    expect(await runSchedule("backup", answer('{"started":false}'))).toBe(
      "'backup' is running now, so it was not started again.",
    );
    expect(
      await runSchedule("nope", answer("No schedule named 'nope'", 404)),
    ).toBe("No schedule named 'nope'");
  });

  it("turns a failed request into a message instead of rejecting", async () => {
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await runSchedule("backup", down)).toBe("Failed to fetch");
    expect(await runSchedule("backup", answer("<html>"))).toContain("JSON");
  });
});
