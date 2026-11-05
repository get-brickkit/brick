import type { BaseContext, Logger } from "./types";
import { createLogger, DEFAULT_LOG_PREFIXES } from "./logger";

const DEFAULT_REQUEST = new Request("http://localhost");
const EMPTY = Object.freeze({});
const defaultLogger: Logger = createLogger(DEFAULT_LOG_PREFIXES);
let sequence = 0;

/**
 * The framework fields of an action context: what the caller gave, the rest
 * defaulted. A missing trace or request id gets a fresh `tr_`/`req_` one.
 */
export function baseContext(
  fields: Partial<BaseContext> & { deps?: Readonly<Record<string, unknown>> },
): BaseContext & { deps: Readonly<Record<string, unknown>> } {
  const seq = (++sequence).toString(36);
  return {
    request: fields.request ?? DEFAULT_REQUEST,
    db: fields.db,
    logger: fields.logger ?? defaultLogger,
    traceId: fields.traceId ?? `tr_${seq}`,
    requestId: fields.requestId ?? `req_${seq}`,
    services: fields.services ?? EMPTY,
    metadata: fields.metadata ?? EMPTY,
    deps: fields.deps ?? EMPTY,
  };
}

type ContextEnvelope = Pick<
  BaseContext,
  "caller" | "traceId" | "requestId" | "tenantId"
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
  return envelope;
}
