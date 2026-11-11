import {
  brick,
  defineDatabase,
  defineService,
  syncSchema,
  t,
  type DispatchOptions,
  type EventsWorld,
} from "@brickkit/core";
import { orderEvents } from "./events";
import { crud } from "@brickkit/crud";
import { createCarrier, type Carrier } from "./carrier";
import { ordersDeps } from "./deps";
import { createListeners } from "./listeners";
import { createSchedules } from "./schedules";
import { auditLog, notifications, orders, outbox, schedules } from "./schema";

export interface OrdersAppOptions {
  /** SQLite file, or `:memory:`. */
  path: string;
  /** Unique per app in one process. */
  serviceName?: string;
  carrier?: Carrier;
  dispatch?: boolean | DispatchOptions;
  /** A Redis world. With it, shipping runs as a durable workflow. */
  world?: EventsWorld;
}

const readOnly = { create: false, update: false, delete: false } as const;

export function createOrdersApp(options: OrdersAppOptions) {
  const carrier = options.carrier ?? createCarrier();
  const database = defineDatabase({
    path: options.path,
    tables: { orders, auditLog, notifications, outbox, schedules },
  });
  syncSchema(database.tables, database.getDb());

  const service = defineService(options.serviceName ?? "orders", {
    database,
    events: orderEvents,
    deps: ordersDeps,
  });

  const order = service
    .resource({ name: "order", table: orders, id: orders.id })
    .use(
      crud({
        access: "public",
        fields: {
          id: { read: true, filter: ["eq"] },
          customer: { read: true, create: true },
          totalCents: { read: true, create: true },
          // Status changes only through commands, such as ship.
          status: { read: true, filter: ["eq"] },
          internalNote: { create: true, update: true },
        },
      }),
    );

  // POST /api/orders/order/:id/ship: the status change and the `shipped` event
  // commit together, and only a placed order ships.
  order.command("ship", {
    description: "Ship a placed order",
    access: "public",
    errors: {
      NOT_PLACED: { status: 409, message: "Only a placed order can ship" },
    },
    output: t.Object({ id: t.String(), status: t.String() }),
    decide: (row, _input, { error }) =>
      row.status !== "placed"
        ? error.NOT_PLACED()
        : {
            set: { status: "shipped" },
            emit: { shipped: { id: row.id, customer: row.customer } },
          },
  });

  service
    .resource({ name: "auditEntry", table: auditLog, id: auditLog.id })
    .use(
      crud({
        access: "public",
        operations: readOnly,
        fields: {
          id: { read: true },
          event: { read: true, filter: ["eq"] },
          orderId: { read: true, filter: ["eq"] },
          detail: { read: true },
        },
      }),
    );
  service
    .resource({
      name: "notification",
      table: notifications,
      id: notifications.id,
    })
    .use(
      crud({
        access: "public",
        operations: readOnly,
        fields: {
          id: { read: true },
          kind: { read: true, filter: ["eq"] },
          orderId: { read: true, filter: ["eq"] },
          recipient: { read: true },
        },
      }),
    );

  const app = brick({
    services: [service],
    deps: { db: database.getDb(), carrier },
    events: {
      listeners: createListeners(
        database.getDb() as never,
        carrier,
        service.events,
        { workflows: options.world !== undefined },
      ),
      schedules: createSchedules(database.getDb()),
      dispatch: options.dispatch ?? { intervalMs: 250 },
      ...(options.world ? { world: options.world } : {}),
    },
    requestLogging: false,
    docs: false,
  });
  return { app, database, carrier };
}
