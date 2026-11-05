import type { Static, TSchema } from "@sinclair/typebox";
import { validateWithSchema } from "../typebox";

/** A service's declared events: payload schema by event name. */
export type EventCatalog = Record<string, TSchema>;

/**
 * One declared event, as `service.events.<name>`. Pass it to `defineListener({ on })`
 * for a typed payload, or to `emitEvent` for a checked one.
 */
export interface EventRef<TPayload = unknown> {
  /** The event name on the wire: `<service>.<event>`, such as `orders.shipped`. */
  readonly name: string;
  readonly service: string;
  readonly schema: TSchema;
  /** The plugin that declared it, for events a `definePlugin` adds. */
  readonly plugin?: string;
  /** Type-level only: the payload this event carries. */
  readonly __payload?: TPayload;
}

/** `service.events`: one `EventRef` per catalog entry. */
export type EventRefs<C extends EventCatalog> = {
  readonly [K in keyof C & string]: EventRef<Static<C[K]>>;
};

/** What a service with a catalog checks before recording an event. */
export interface EventChecker {
  readonly name: string;
  readonly events: Readonly<Record<string, EventRef>>;
  /** Whether the service has a catalog at all. */
  readonly hasCatalog: boolean;
  listResources(): readonly { name: string }[];
}

export function isEventRef(value: unknown): value is EventRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as EventRef).name === "string" &&
    typeof (value as EventRef).service === "string" &&
    typeof (value as EventRef).schema === "object"
  );
}

/** Build `service.events` from its catalog. */
export function eventRefs(
  service: string,
  catalog: EventCatalog | undefined,
): Record<string, EventRef> {
  const refs: Record<string, EventRef> = Object.create(null);
  for (const [key, schema] of Object.entries(catalog ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key))
      throw new Error(
        `Event "${key}" in service "${service}" must be a plain name such as shipped or itemAdded`,
      );
    if (!schema || typeof schema !== "object")
      throw new Error(
        `Event "${service}.${key}" needs a payload schema, such as t.Object({ ... })`,
      );
    refs[key] = Object.freeze({ name: `${service}.${key}`, service, schema });
  }
  return Object.freeze(refs);
}

/** @throws When the payload does not match the event's schema. */
export function checkPayload(ref: EventRef, payload: unknown): void {
  const result = validateWithSchema(ref.schema, payload);
  if (!result.success)
    throw new Error(
      `Event "${ref.name}" payload does not match its schema: ${result.errors
        .map((error) => `${error.path || "/"} ${error.message}`)
        .join("; ")}`,
    );
}

const CRUD_EVENT = /^(create|update|delete)$/;

/**
 * Check an event against the catalog of the service recording it. Without a
 * catalog any name goes. With one, the name must be `<service>.<event>` from it
 * (the payload is checked against its schema) or a CRUD event of one of the
 * service's resources (`<resource>.create|update|delete`).
 *
 * @throws When the name is not declared or the payload does not match.
 */
export function checkEvent(
  service: EventChecker,
  name: string,
  payload: unknown,
): void {
  const prefix = `${service.name}.`;
  const ref = name.startsWith(prefix)
    ? service.events[name.slice(prefix.length)]
    : undefined;
  if (ref) return checkPayload(ref, payload);
  if (!service.hasCatalog) return;
  const dot = name.indexOf(".");
  if (
    dot > 0 &&
    CRUD_EVENT.test(name.slice(dot + 1)) &&
    service.listResources().some((r) => r.name === name.slice(0, dot))
  )
    return;
  throw new Error(
    `Event "${name}" is not in the event catalog of service "${service.name}" (declared: ${
      Object.values(service.events)
        .map((ref) => ref.name)
        .join(", ") || "none"
    })`,
  );
}
