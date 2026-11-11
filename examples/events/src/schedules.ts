import { defineSchedule, eq } from "@brickkit/core";
import { notifications, orders } from "./schema";

/**
 * A weekday-morning reminder for every order still waiting to ship. It runs at
 * 09:00 Berlin time once among all processes, and writes each reminder under
 * the run key, so a retried run adds nothing twice.
 */
export function createSchedules(db: any) {
  return [
    defineSchedule({
      name: "unshipped-reminder",
      cron: "0 9 * * mon-fri",
      timeZone: "Europe/Berlin",
      run: async ({ runKey }) => {
        const waiting = await db
          .select()
          .from(orders)
          .where(eq(orders.status, "placed"));
        for (const order of waiting)
          await db
            .insert(notifications)
            .values({
              id: `${runKey}:${order.id}`,
              kind: "unshipped",
              orderId: order.id,
              recipient: "warehouse@example.com",
            })
            .onConflictDoNothing();
      },
    }),
  ];
}
