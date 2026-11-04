// A TypeScript-only app: polyglot services must change nothing for it.
import { brick, defineService, t } from "@brickkit/core";

const orders = defineService("orders");
orders.action({
  name: "list",
  input: t.Object({ limit: t.Integer({ minimum: 1 }) }),
  output: t.Array(t.String()),
  execute: () => [],
});

export default brick({
  services: [orders],
  docs: false,
  requestLogging: false,
});
