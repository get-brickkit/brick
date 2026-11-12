import type { BaseContext, Logger } from "./types";
import { createLogger, DEFAULT_LOG_PREFIXES } from "./logger";
import { dashboardIdentity } from "./dashboard-identity";

const DEFAULT_REQUEST = new Request("http://localhost");
const EMPTY = Object.freeze({});
const defaultLogger: Logger = createLogger(DEFAULT_LOG_PREFIXES);
/** Random, so ids never repeat across restarts or processes. */
const newId = (kind: "tr" | "req") => `${kind}_${crypto.randomUUID()}`;

/**
 * The trace and request ids of an HTTP request: the caller's `x-trace-id` and
 * `x-request-id` headers, else fresh ones. Both are echoed on the response.
 */
export function requestIds(
  headers: Record<string, string | undefined> | undefined,
  set: { headers?: Record<string, unknown> } | undefined,
): { traceId: string; requestId: string } {
  const traceId = headers?.["x-trace-id"] || newId("tr");
  const requestId = headers?.["x-request-id"] || newId("req");
  if (set?.headers) {
    set.headers["x-trace-id"] = traceId;
    set.headers["x-request-id"] = requestId;
  }
  return { traceId, requestId };
}

/**
 * The framework fields of an action context: what the caller gave, the rest
 * defaulted. A missing trace or request id gets a fresh `tr_`/`req_` one.
 */
export function baseContext(
  fields: Partial<BaseContext> & { deps?: Readonly<Record<string, unknown>> },
): BaseContext & { deps: Readonly<Record<string, unknown>> } {
  return {
    request: fields.request ?? DEFAULT_REQUEST,
    db: fields.db,
    logger: fields.logger ?? defaultLogger,
    traceId: fields.traceId ?? newId("tr"),
    requestId: fields.requestId ?? newId("req"),
    services: fields.services ?? EMPTY,
    metadata: fields.metadata ?? EMPTY,
    deps: fields.deps ?? EMPTY,
    dashboard: fields.dashboard ?? dashboardIdentity(fields.request),
  };
}

type ContextEnvelope = Pick<
  BaseContext,
  "caller" | "traceId" | "requestId" | "tenantId" | "dashboard"
> & { user?: unknown };

export function pickContextEnvelope(
  context?: Partial<BaseContext> & { user?: unknown },
): Partial<ContextEnvelope> {
  if (!context) return {};
  const envelope: Partial<ContextEnvelope> = {};
  if (context.caller !== undefined) envelope.caller = context.caller;
  if (context.user !== undefined) envelope.user = context.user;
  if (context.traceId !== undefined) envelope.traceId = context.traceId;
  if (context.requestId !== undefined) envelope.requestId = context.requestId;
  if (context.tenantId !== undefined) envelope.tenantId = context.tenantId;
  // In process only: the identity was verified when the outer request arrived.
  if (context.dashboard !== undefined) envelope.dashboard = context.dashboard;
  return envelope;
}
