import { createMonitorApp } from "./create-app";

const { app } = createMonitorApp({
  path: process.env.DB_PATH ?? ".data/uptime.sqlite",
});

export default app;
