import type { Service } from "./types";

/**
 * Who a call comes from, as the service's `identity` hook says. Brick treats
 * the strings as opaque: it compares and stores them, never interprets them.
 */
export interface Identity {
  /** Who: the rate-limit key and the audit actor. */
  id: string;
  /** A display name for the audit log. */
  label?: string;
  /** Which tenant: scopes file storage and is recorded in the audit log. */
  tenant?: string;
}

/** On a resolved context: resolves its identity, once. Spreading the context keeps it. Global so a second core copy finds it. */
const IDENTITY = Symbol.for("brickkit.identity");

/**
 * Give a resolved context the service's identity: its hook runs on the first
 * ask, against the context as it is then (with the service's own `deps`), and
 * the result is kept for the rest of the call, copies of the context included.
 * Nothing is attached when the service has no hook.
 */
export function attachIdentity(
  ctx: Record<PropertyKey, unknown>,
  service: Service<any, any>,
  deps: Readonly<Record<string, unknown>>,
): void {
  const hook = service.options.identity;
  if (typeof hook !== "function") return;
  let identity: Promise<Identity | null> | undefined;
  ctx[IDENTITY] = () =>
    (identity ??= Promise.resolve()
      .then(() => hook({ ...ctx, deps } as any))
      .then((value) => checked(service.name, value)));
}

function checked(service: string, value: unknown): Identity | null {
  if (value === null || value === undefined) return null;
  const { id, label, tenant } = value as Partial<Identity>;
  if (
    typeof id !== "string" ||
    !id ||
    (label !== undefined && typeof label !== "string") ||
    (tenant !== undefined && typeof tenant !== "string")
  )
    throw new Error(
      `Service "${service}": identity must return { id: string, label?: string, tenant?: string } with a non-empty id, null or undefined`,
    );
  // Only these fields: a hook that returns a whole user must not hand on the rest.
  return {
    id,
    ...(label !== undefined && { label }),
    ...(tenant !== undefined && { tenant }),
  };
}

/**
 * The identity of the call a context belongs to: the service's `identity` hook,
 * run on the first ask and kept for the rest of the call. `null` for an
 * anonymous caller, a service without the hook, or a context no service resolved.
 */
export function identityOf(ctx: object): Promise<Identity | null> {
  const resolve = (ctx as Record<PropertyKey, unknown>)[IDENTITY];
  return typeof resolve === "function" ? resolve() : Promise.resolve(null);
}

/** Whether the service declares an `identity` hook, so a feature that needs one can fail at startup. */
export function hasIdentity(service: Service<any, any>): boolean {
  return typeof service.options.identity === "function";
}
