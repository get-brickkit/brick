import type { Carrier } from "./carrier";

/**
 * What the orders service gives its code: `defineService({ deps })` holds the
 * values, actions read `ctx.deps`, and the steps of a workflow, which cannot
 * close over the service that started them, read `useDeps<OrdersDeps>()`.
 */
export type OrdersDeps = {
  db: any;
  carrier: Carrier;
};
