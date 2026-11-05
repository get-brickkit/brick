import { checkRules } from "./rules/checks";
import { layoutRules } from "./rules/layout";

export type Severity = "error" | "warn" | "off";
export type PresetName = "recommended" | "layout" | "strict" | "plugin";

/** Rules that check one file at a time, in ESLint, oxlint or brick lint. */
export const rules = { ...layoutRules, ...checkRules };

/** Rules that need the loaded app; only `brick lint` runs them. */
export const APP_RULES = [
  "single-app-entry",
  "no-cross-service-tables",
  "unique-names",
  "declared-events",
  "test-colocated",
] as const;

/** Always an error: no preset or rule setting turns it down. */
export const ALWAYS_ERROR = "no-cross-service-tables";

const RECOMMENDED: Record<string, Severity> = {
  "workflow-directive": "error",
  "no-cross-service-tables": "error",
  "unique-names": "error",
  "no-server-in-client": "error",
  "action-schemas": "error",
  "declared-errors": "error",
  "return-error": "error",
  "path-params-in-input": "error",
  "get-is-read-only": "error",
  "emit-in-transaction": "error",
  "declared-events": "error",
  "deterministic-workflow": "error",
  "idempotent-listener": "warn",
  "socket-schemas": "error",
  "no-unregistered-format": "error",
  "no-floating-calls": "error",
  "explicit-access": "error",
  "socket-authorize": "error",
  "no-wildcard-origins": "error",
};

/** Every preset, with app rules, by bare rule name. */
export const PRESETS: Record<PresetName, Record<string, Severity>> = {
  recommended: RECOMMENDED,
  layout: {
    "one-action-per-file": "error",
    "file-suffixes": "error",
    "kind-folders": "error",
    "resource-folder": "error",
    "file-name-matches": "error",
    "service-folder": "error",
    "colocate-in-service": "error",
    "single-app-entry": "error",
  },
  strict: {
    ...RECOMMENDED,
    "no-global-context": "error",
    "no-env-outside-secrets": "error",
    "strict-input": "error",
    "description-required": "error",
    naming: "error",
    "no-console": "error",
    "test-colocated": "error",
  },
  plugin: {
    "plugin-manifest": "error",
    "explicit-access": "error",
    "description-required": "error",
  },
};

const KNOWN = new Set<string>([...Object.keys(rules), ...APP_RULES]);

/**
 * Severity of every rule, keyed `brick/<rule>`, from presets then per-rule
 * settings. Throws on an unknown rule, or on turning down no-cross-service-tables.
 */
export function resolveRules(
  presets: PresetName[] = ["recommended"],
  overrides: Record<string, Severity> = {},
): Record<string, Severity> {
  const resolved: Record<string, Severity> = {};
  for (const preset of presets) {
    if (!PRESETS[preset]) throw new Error(`Brick: unknown preset "${preset}"`);
    for (const [name, severity] of Object.entries(PRESETS[preset]))
      resolved[`brick/${name}`] = severity;
  }
  for (const [key, severity] of Object.entries(overrides)) {
    const name = key.replace(/^brick\//, "");
    if (!KNOWN.has(name)) throw new Error(`Brick: unknown rule "${key}"`);
    if (name === ALWAYS_ERROR && severity !== "error")
      throw new Error(
        `Brick: brick/${ALWAYS_ERROR} is always an error and cannot be turned off`,
      );
    resolved[`brick/${name}`] = severity;
  }
  resolved[`brick/${ALWAYS_ERROR}`] = "error";
  return resolved;
}

/** The file rules of a resolved rule set, as ESLint and oxlint take them. */
export function fileRules(
  resolved: Record<string, Severity>,
): Record<string, Severity> {
  return Object.fromEntries(
    Object.entries(resolved).filter(
      ([key]) => key.replace(/^brick\//, "") in rules,
    ),
  );
}
