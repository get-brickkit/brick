import { describe, it, expect, beforeEach } from "bun:test";
import {
  defineService,
  defineAction,
  resetGlobalRegistry,
  t,
  brick,
} from "@brickkit/core";

describe("server", () => {
  beforeEach(() => {
    resetGlobalRegistry();
  });

  it("should mount services and execute POST and GET actions", async () => {
    const dealsService = defineService("deals");

    const dealsDb: Array<{ id: string; title: string; amount: number }> = [];

    const createDeal = defineAction({
      name: "createDeal",
      input: t.Object({
        title: t.String({ minLength: 3 }),
        amount: t.Number({ minimum: 0 }),
      }),
      output: t.Object({
        id: t.String(),
        title: t.String(),
        amount: t.Number(),
      }),
      execute: async ({ input }) => {
        const record = {
          id: `deal_${dealsDb.length + 1}`,
          title: input.title,
          amount: input.amount,
        };
        dealsDb.push(record);
        return record;
      },
    });

    const listDeals = defineAction({
      name: "listDeals",
      method: "GET",
      output: t.Object({
        deals: t.Array(
          t.Object({
            id: t.String(),
            title: t.String(),
            amount: t.Number(),
          }),
        ),
      }),
      execute: async () => {
        return { deals: dealsDb };
      },
    });

    dealsService.action(createDeal);
    dealsService.action(listDeals);

    const app = brick({ services: [dealsService] });

    const healthRes = await app.handle(
      new Request("http://localhost:4000/_health"),
    );
    expect(healthRes.status).toBe(200);
    const healthJson = await healthRes.json();
    expect(healthJson.status).toBe("ok");

    const infoRes = await app.handle(
      new Request("http://localhost:4000/_brick/services"),
    );
    expect(infoRes.status).toBe(200);
    const infoJson = await infoRes.json();
    expect(infoJson.services.length).toBe(1);
    expect(infoJson.services[0].name).toBe("deals");

    const createRes = await app.handle(
      new Request("http://localhost:4000/api/deals/create-deal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Enterprise License", amount: 50000 }),
      }),
    );
    expect(createRes.status).toBe(200);
    const createData = await createRes.json();
    expect(createData.id).toBe("deal_1");
    expect(createData.title).toBe("Enterprise License");
    expect(createRes.headers.get("x-trace-id")).toMatch(/.+/);

    const invalidRes = await app.handle(
      new Request("http://localhost:4000/api/deals/create-deal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Bad Deal", amount: -10 }),
      }),
    );
    expect(invalidRes.status).toBe(400);
    const invalidData = await invalidRes.json();
    expect(invalidData.name).toBe("ValidationError");
    expect(invalidData.errors.length).toBeGreaterThan(0);

    const listRes = await app.handle(
      new Request("http://localhost:4000/api/deals/list-deals"),
    );
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.deals.length).toBe(1);
    expect(listData.deals[0].title).toBe("Enterprise License");
  });
});
