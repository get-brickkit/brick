import * as React from "react";

import { SourceCode } from "@/components/source-code";
import { cn } from "@/lib/utils";

// Snippets follow the docs pages each tab names; keep them in step with those pages.
const stops = [
  {
    id: "action",
    label: "Action",
    serves: ["POST /api/users/get-user", "api.users.getUser()"],
    code: `export const getUser = usersService.action({
  name: "getUser",
  input: t.Object({ id: t.String() }),
  execute: ({ input, error }) => {
    const user = users.get(input.id);
    if (!user) error.NOT_FOUND("User not found");
    return user;
  },
});`,
  },
  {
    id: "resource",
    label: "Resource",
    serves: [
      "POST /api/orders/order/query",
      "GET PATCH DELETE /api/orders/order/:id",
    ],
    code: `export const order = orders
  .resource({ name: "order", table: ordersTable, id: ordersTable.id })
  .use(
    crud({
      access: "public",
      fields: {
        id: { read: true, filter: ["eq", "in"] },
        status: { read: true, update: true, sort: true },
      },
    }),
  );`,
  },
  {
    id: "command",
    label: "Command",
    serves: ["POST /api/orders/order/:id/ship", "api.orders.order.ship()"],
    code: `export default order.command("ship", {
  access: "public",
  input: t.Object({ trackingId: t.String() }),
  errors: { NOT_PAID: { status: 409, message: "Only paid orders can ship" } },
  decide: (row, input, { error }) =>
    row.status !== "paid"
      ? error.NOT_PAID()
      : {
          set: { status: "shipped" },
          emit: { shipped: { id: row.id, trackingId: input.trackingId } },
        },
});`,
  },
  {
    id: "event",
    label: "Event",
    serves: ["orders.shipped → send-tracking"],
    code: `export const orders = defineService("orders", {
  database,
  events: {
    shipped: t.Object({ id: t.String(), trackingId: t.String() }),
  },
});

export const sendTracking = defineListener({
  name: "send-tracking",
  on: orders.events.shipped,
  run: ({ payload }) => mailer.tracking(payload.id, payload.trackingId),
});`,
  },
  {
    id: "socket",
    label: "Socket",
    serves: ["GET /api/chat/live (upgrade)", "api.chat.live.connect()"],
    code: `chat.socket({
  name: "live",
  input: {
    say: t.Object({ text: t.String({ minLength: 1, maxLength: 2000 }) }),
  },
  output: {
    message: t.Object({ text: t.String() }),
  },
  authorize: ({ ctx }) => ctx.user != null,
  handlers: {
    say: ({ input, socket }) => {
      socket.send("message", { text: input.text });
    },
  },
});`,
  },
  {
    id: "tool",
    label: "MCP",
    serves: ["tools/list", "tools/call search_docs"],
    code: `export const searchDocs = docsService.tool({
  name: "search_docs",
  description: "Search knowledge base documents by query string",
  input: t.Object({
    query: t.String({ description: "Search terms or keywords" }),
    limit: t.Optional(t.Number({ default: 5 })),
  }),
  output: t.Array(t.Object({ id: t.String(), title: t.String() })),
  execute: ({ input }) => search(input.query, input.limit),
});`,
  },
];

/**
 * The hero's one animation: the active tab's underline fills, and its
 * animationend moves to the next tab. Reduced motion drops the animation, so
 * nothing advances; picking a tab stops the tour.
 */
export function HomeTour() {
  const [active, setActive] = React.useState(0);
  const [touring, setTouring] = React.useState(true);
  return (
    <div className="home-tour">
      <div
        role="tablist"
        aria-label="Brick building blocks"
        className="tour-tabs"
      >
        {stops.map((stop, i) => (
          <button
            key={stop.id}
            type="button"
            role="tab"
            id={`tour-tab-${stop.id}`}
            aria-selected={active === i}
            aria-controls={`tour-panel-${stop.id}`}
            onClick={() => {
              setActive(i);
              setTouring(false);
            }}
            className="tour-tab"
          >
            {stop.label}
            {active === i && touring && (
              <span
                aria-hidden="true"
                className="tour-progress"
                onAnimationEnd={() => setActive((i + 1) % stops.length)}
              />
            )}
          </button>
        ))}
      </div>
      {/* Every panel stays mounted and stacked so highlighting runs once and the window never resizes. */}
      <div className="tour-panels">
        {stops.map((stop, i) => (
          <div
            key={stop.id}
            role="tabpanel"
            id={`tour-panel-${stop.id}`}
            aria-labelledby={`tour-tab-${stop.id}`}
            className={cn("tour-panel", active !== i && "invisible")}
          >
            <div className="tour-code">
              <SourceCode code={stop.code} />
            </div>
            <p className="tour-serves">
              <span>serves</span>
              {stop.serves.map((line) => (
                <code key={line}>{line}</code>
              ))}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
