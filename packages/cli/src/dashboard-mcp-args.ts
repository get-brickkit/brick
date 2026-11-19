import type { McpToolDefinition } from "@brickkit/core";
import type { DevDocs } from "./dev-docs";
import type { DevHistory } from "./dev-history";
import type { DevTelemetryStore } from "./dev-telemetry-store";

/*
 * What the dashboard's MCP tools share: how they read their arguments, how
 * they shorten what they return, and what data they may read.
 */

export type Args = Record<string, unknown>;

/** Where the tools read, as the dashboard has them. */
export interface McpSources {
  store: DevTelemetryStore;
  /** Stored requests; absent when history is off. */
  history?: DevHistory;
  mode: "dev" | "production";
  /** Whether this dashboard serves the workflow inspector and schedules: always in dev, in production with `dashboard.inspector`. */
  inspector: boolean;
  /** The app's developer documentation, when it has any, as of this call. */
  docs?: () => DevDocs | undefined;
}

/** A tool the dashboard offers, listed only while the data it reads exists. */
export interface BuiltInTool {
  definition: McpToolDefinition;
  run(args: Args): string | Promise<string>;
  available?(): boolean;
}

export const MINUTE = 60_000;
const UNITS = { s: 1000, m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE };
export const DAY = UNITS.d;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;
const EPOCH_MS_MIN_DIGITS = 10;
const EPOCH_MS = new RegExp(`^\\d{${EPOCH_MS_MIN_DIGITS},}$`);

export const TIME_HELP =
  'An ISO 8601 time, epoch milliseconds, or a time ago such as "30m", "2h" or "7d".';

export const READ_ONLY = { readOnlyHint: true } as const;

export function time(
  value: unknown,
  name: string,
  now: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    if (EPOCH_MS.test(value.trim())) return Number(value.trim());
    const ago = /^(\d+)\s*([smhd])$/.exec(value.trim());
    if (ago) return now - Number(ago[1]) * UNITS[ago[2] as keyof typeof UNITS];
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  throw new Error(
    `${name} must be an ISO 8601 time, epoch milliseconds, or a time ago such as "30m", "2h" or "7d".`,
  );
}

export function window(args: Args, defaultSpanMs: number) {
  const now = Date.now();
  const to = time(args.to, "to", now) ?? now;
  const from = time(args.from, "from", now) ?? to - defaultSpanMs;
  if (from > to) throw new Error("from must not be after to.");
  return { from, to };
}

export function integer(
  args: Args,
  name: string,
  min: number,
  max: number,
  fallback?: number,
): number | undefined {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${name} must be a whole number.`);
  return Math.min(Math.max(value, min), max);
}

export function text(args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  return value.trim() || undefined;
}

export const iso = (ms: number) => new Date(ms).toISOString();
export const round = (ms: number | undefined) =>
  ms === undefined ? undefined : Math.round(ms * 10) / 10;
export const cut = (value: string | undefined, limit: number) =>
  value !== undefined && value.length > limit
    ? `${value.slice(0, limit)}… [${value.length - limit} more characters]`
    : value;
export const compactJson = (value: unknown) => JSON.stringify(value);
