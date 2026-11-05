import { checkPayload, type EventRef } from "./catalog";
import { recordingServices } from "./hub";

/**
 * Record an event of your own from an action, a tool or a hook. Listeners get it
 * as they get a generated CRUD event, with the payload you give.
 *
 * By default the event is committed in a transaction of its own. Pass the `tx`
 * of a transaction you have open to commit it with your writes instead: then it
 * is delivered at the dispatcher's next poll, because Brick does not see your
 * commit. Nothing is recorded when no listener wants the event.
 *
 * @param ctx - The action context: its `db` finds the service's outbox, and its
 * `traceId` follows the event to its listeners.
 * @param event - A declared event, such as `orders.events.shipped`, whose payload
 * is typed and checked against its schema; or an event name such as
 * `orders.refunded`. A service with an event catalog only records names from it
 * (and the CRUD events of its resources).
 * @param payload - JSON data for the listeners.
 * @param options - `tx`: an open transaction on the service's database. `source`:
 * what emitted it, shown to listeners.
 * @throws When the context's database has no outbox table, or the app has no
 * `events`; when the event is not in the service's catalog, or its payload does
 * not match the declared schema.
 * @example
 * refund: service.action({
 *   name: "refund",
 *   execute: async ({ ctx, input }) => {
 *     await ctx.db.update(orders).set({ status: "refunded" }).where(eq(orders.id, input.id));
 *     await emitEvent(ctx, orders.events.refunded, { id: input.id });
 *   },
 * });
 */
export async function emitEvent<TPayload>(
  ctx: { db?: unknown; traceId?: string },
  event: EventRef<TPayload>,
  payload: NoInfer<TPayload>,
  options?: { tx?: unknown; source?: string },
): Promise<void>;
export async function emitEvent(
  ctx: { db?: unknown; traceId?: string },
  name: string,
  payload: unknown,
  options?: { tx?: unknown; source?: string },
): Promise<void>;
export async function emitEvent(
  ctx: { db?: unknown; traceId?: string },
  event: string | EventRef,
  payload: unknown,
  options: { tx?: unknown; source?: string } = {},
): Promise<void> {
  const name = typeof event === "string" ? event : event.name;
  const service =
    ctx.db && typeof ctx.db === "object"
      ? recordingServices.get(ctx.db)
      : undefined;
  // The recording service checks its own events; one declared elsewhere is checked here.
  if (typeof event !== "string" && event.service !== service?.name)
    checkPayload(event, payload);
  const events = service?.recorder;
  if (!events)
    throw new Error(
      `Cannot emit '${name}': ctx.db is not the database of a service with an outbox table (the app needs events, and ctx.db must be the service's own database, not a transaction)`,
    );
  const context = { traceId: ctx.traceId, source: options.source };
  if (options.tx !== undefined)
    return events.record(options.tx, context, name, payload);
  await events.transaction(ctx.db, context, async (_tx, record) => {
    await record(name, payload);
  });
}
