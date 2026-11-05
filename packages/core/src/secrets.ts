/**
 * Type-safe secrets & environment variables.
 *
 * Declare each secret once at module scope instead of scattering untyped
 * `process.env.FOO` reads:
 *
 *   const port = defineSecret("PORT").default("3333").transform(Number).require();
 *   const baseUrl = defineSecret("BASE_URL").url().require();
 *   const key = defineSecret("STRIPE_KEY").validate((v) =>
 *     v.startsWith("sk_") || "must start with sk_"
 *   ).require();
 *
 * Values resolve from the environment (Bun populates `process.env` from
 * `.env` locally; in prod the same env source applies — a future
 * `SecretSource` such as AWS can slot in without touching call sites).
 *
 * Resolution order per secret: test/session override → source (`process.env`
 * by default) → declared `default`. `resolveSecrets()` validates every
 * registered secret at boot and throws listing all missing required ones.
 */

import { definitionSite } from "./definition-site";

export interface SecretSource {
  get(name: string): string | undefined;
}

/** Default source: `process.env` (Bun loads `.env` into it automatically). */
export const envSource: SecretSource = {
  get: (name: string) => process.env[name],
};

export interface SecretOptions {
  /** Fallback when the source has no value. Secrets without a default are required. */
  default?: string;
}

/** A validator: return `true`/`void` when ok, `false`/reason/`throw` when not. */
export type SecretValidator<T> = (value: T) => void | boolean | string;

const registry = new Map<string, SecretRef<any>>();
const overrides = new Map<string, string>();
/** Where each secret was first declared. */
const sites = new Map<string, string | undefined>();

export class SecretRef<T = string> {
  readonly name: string;
  readonly options: SecretOptions;
  private transformFn?: (raw: string) => T;
  private validators: SecretValidator<T>[] = [];

  constructor(name: string, options: SecretOptions = {}) {
    this.name = name;
    this.options = options;
  }

  /** True when a default was declared (i.e. the secret is optional). */
  get hasDefault(): boolean {
    return this.options.default !== undefined;
  }

  /** Fallback used when the source has no value. Makes the secret optional. */
  default(value: string): this {
    this.options.default = value;
    return this;
  }

  /**
   * Convert the raw string (e.g. `Number`, `JSON.parse`, `v === "true"`).
   * Runs before validators; a throwing transform fails resolution.
   */
  transform<U>(fn: (raw: string) => U): SecretRef<U> {
    this.transformFn = fn as unknown as (raw: string) => T;
    return this as unknown as SecretRef<U>;
  }

  /** Run a custom check on the (transformed) value at every resolution. */
  validate(fn: SecretValidator<T>): this {
    this.validators.push(fn);
    return this;
  }

  /** Shorthand validator: value must parse as a URL. String refs only. */
  url(this: SecretRef<string>): SecretRef<string> {
    this.validators.push((v) => {
      try {
        new URL(v);
      } catch {
        return "must be a valid URL";
      }
    });
    return this;
  }

  private resolveRaw(source: SecretSource): string | undefined {
    return (
      overrides.get(this.name) ?? source.get(this.name) ?? this.options.default
    );
  }

  private coerce(raw: string): T {
    let value: T;
    if (this.transformFn) {
      try {
        value = this.transformFn(raw);
      } catch (err) {
        throw new Error(
          `Invalid value for secret "${this.name}": transform failed (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    } else {
      value = raw as unknown as T;
    }
    for (const fn of this.validators) {
      let result: void | boolean | string;
      try {
        result = fn(value);
      } catch (err) {
        throw new Error(
          `Invalid value for secret "${this.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (result === false) {
        throw new Error(
          `Invalid value for secret "${this.name}": validation failed`,
        );
      }
      if (typeof result === "string") {
        throw new Error(`Invalid value for secret "${this.name}": ${result}`);
      }
    }
    return value;
  }

  /** Resolved (transformed, validated) value or `undefined`. Never throws on missing. */
  value(source: SecretSource = envSource): T | undefined {
    const raw = this.resolveRaw(source);
    if (raw === undefined) return undefined;
    return this.coerce(raw);
  }

  /** Resolved value, or throws naming the missing/invalid secret. */
  require(source: SecretSource = envSource): T {
    const raw = this.resolveRaw(source);
    if (raw === undefined) {
      throw new Error(
        `Missing required secret "${this.name}": set it in .env (local) or the environment (prod)`,
      );
    }
    return this.coerce(raw);
  }

  /** True when a value would resolve (override, source, or default). */
  isSet(source: SecretSource = envSource): boolean {
    return this.resolveRaw(source) !== undefined;
  }
}

/**
 * Declare a secret. Calling it again for the name returns the same ref. From
 * the same line (a module evaluated again) it starts the declaration over, so
 * its builder calls replace the earlier ones instead of adding to them.
 */
export function defineSecret(
  name: string,
  options: SecretOptions = {},
): SecretRef<string> {
  const site = definitionSite();
  const existing = registry.get(name);
  if (existing) {
    if (site !== undefined && sites.get(name) === site) {
      (existing as { options: SecretOptions }).options = options;
      existing["validators"] = [];
      existing["transformFn"] = undefined;
    }
    return existing;
  }
  sites.set(name, site);
  const ref = new SecretRef<string>(name, options);
  registry.set(name, ref);
  return ref;
}

/**
 * Validate every registered secret at boot. Throws a single error listing
 * all missing required secrets. Returns the resolved values.
 */
export function resolveSecrets(
  opts: { source?: SecretSource } = {},
): Record<string, unknown> {
  const source = opts.source ?? envSource;
  const missing: string[] = [];
  const resolved: Record<string, unknown> = {};
  for (const ref of registry.values()) {
    const v = ref.value(source);
    if (v === undefined) missing.push(ref.name);
    else resolved[ref.name] = v;
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets: ${missing.join(", ")}. Set them in .env (local) or the environment (prod)`,
    );
  }
  return resolved;
}

/** Metadata for introspection (values never exposed — future dashboard use). */
export function listSecrets(
  opts: { source?: SecretSource } = {},
): Array<{ name: string; hasDefault: boolean; isSet: boolean }> {
  const source = opts.source ?? envSource;
  return [...registry.values()].map((ref) => ({
    hasDefault: ref.hasDefault,
    isSet: ref.isSet(source),
    name: ref.name,
  }));
}

/** Test/session override for one secret (`undefined` clears the override). */
export function overrideSecret(name: string, value: string | undefined): void {
  if (value === undefined) overrides.delete(name);
  else overrides.set(name, value);
}

/** Clear registry and overrides. Test-only. */
export function resetSecrets(): void {
  registry.clear();
  overrides.clear();
  sites.clear();
}
