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

/** On a resolved context: resolves its identity, once. Spreading the context keeps it. */
const IDENTITY = Symbol("identity");

/** Give a resolved context its identity, resolved by `hook` on first ask and kept for the rest of the call. */
export function attachIdentity(
  ctx: Record<PropertyKey, unknown>,
  service: string,
  hook: (() => unknown) | undefined,
): void {
  let identity: Promise<Identity | null> | undefined;
  ctx[IDENTITY] = () =>
    (identity ??= hook
      ? Promise.resolve()
          .then(hook)
          .then((value) => checked(service, value))
      : Promise.resolve(null));
}

function checked(service: string, value: unknown): Identity | null {
  if (value === null || value === undefined) return null;
  const { id, label, tenant } = value as Partial<Identity>;
  if (
    typeof id !== "string" ||
    (label !== undefined && typeof label !== "string") ||
    (tenant !== undefined && typeof tenant !== "string")
  )
    throw new Error(
      `Service "${service}": identity must return { id: string, label?: string, tenant?: string }, null or undefined`,
    );
  return value as Identity;
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
