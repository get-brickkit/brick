// A TS service with a Go and a Rust one, for the deploy generators.
import { brick, defineService, remoteService, t } from "@brickkit/core";

const orders = defineService("orders");
orders.action({ name: "list", input: t.Object({}), execute: () => [] });

export const billing = remoteService({
  name: "billing",
  dir: "services/billing",
  dev: "go run .",
  build: { command: "go build -o bin/billing .", run: "./bin/billing" },
});

export const fx = remoteService({
  name: "fxRates",
  dir: "services/fx",
  dev: "cargo run -q",
  build: { command: "cargo build --release", run: "./target/release/fx" },
});

export const app = brick({
  services: [orders],
  remote: [billing, fx],
  docs: false,
  requestLogging: false,
  cors: { origin: ["https://app.example.com"], credentials: true },
});

export const tsOnly = brick({
  services: [orders],
  docs: false,
  requestLogging: false,
});
