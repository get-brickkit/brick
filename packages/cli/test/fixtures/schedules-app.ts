import {
  brick,
  defineDatabase,
  defineSchedule,
  defineService,
  scheduleTable,
  syncSchema,
} from "@brickkit/core";

const schedules = scheduleTable("sqlite");
const database = defineDatabase({ tables: { schedules } });
syncSchema([schedules], database.getDb());

export const ran: string[] = [];

export default brick({
  services: [defineService("schedules_cli_service", { database })],
  events: {
    schedules: [
      defineSchedule({
        name: "warm-cache",
        every: "6h",
        run: () => void ran.push("warm-cache"),
      }),
      defineSchedule({
        name: "report",
        cron: "0 2 * * *",
        timeZone: "Europe/Berlin",
        enabled: false,
        run: () => void ran.push("report"),
      }),
    ],
    dispatch: { intervalMs: 20 },
  },
  requestLogging: false,
  docs: false,
});
