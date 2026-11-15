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

const IDENTITY = Symbol.for("brickkit.identity");

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
      .then(() => {
        const { [IDENTITY]: _own, ...withoutIdentity } = ctx;
        return hook({ ...withoutIdentity, deps } as any);
      })
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
  return {
    id,
    ...(label !== undefined && { label }),
    ...(tenant !== undefined && { tenant }),
  };
}

export function identityOf(ctx: object): Promise<Identity | null> {
  const resolve = (ctx as Record<PropertyKey, unknown>)[IDENTITY];
  return typeof resolve === "function" ? resolve() : Promise.resolve(null);
}

export function hasIdentity(service: Service<any, any>): boolean {
  return typeof service.options.identity === "function";
}
