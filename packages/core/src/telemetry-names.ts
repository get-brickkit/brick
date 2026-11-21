// Names core writes into traces and onto globalThis, read by the CLI and its
// dashboard page. Browser-safe: constants only.

export const SPAN = {
  /** `action <service>.<action>` */
  actionPrefix: "action ",
  /** `rpc <service>.<action>` */
  rpcPrefix: "rpc ",
  exceptionEvent: "exception",
  /** The span event a `ctx.logger` line becomes. */
  logEvent: "log",
} as const;

export const ATTR = {
  httpMethod: "http.request.method",
  httpRoute: "http.route",
  httpStatus: "http.response.status_code",
  urlPath: "url.path",
  /** An outbound request's scheme, host and path. Never the query, credentials, headers or body. */
  urlFull: "url.full",
  serverAddress: "server.address",
  service: "brick.service",
  action: "brick.action",
  /** A webhook delivery: the webhook's name, its event id and what became of it. Never the body or the signature. */
  webhook: "brick.webhook",
  webhookEventId: "brick.webhook.event_id",
  webhookOutcome: "brick.webhook.outcome",
  traceId: "brick.trace_id",
  errorCode: "brick.error.code",
  errorMessage: "brick.error.message",
  errorStatus: "brick.error.status",
  logsDropped: "brick.logs.dropped",
  dbStatement: "db.statement",
  dbSystem: "db.system",
  dbOperation: "db.operation",
  exceptionMessage: "exception.message",
  exceptionStack: "exception.stacktrace",
  logLevel: "log.level",
  logMessage: "log.message",
} as const;

/**
 * `Symbol.for` names shared through globalThis, because the CLI and the app may
 * each hold their own copy of core.
 */
export const GLOBAL_SYMBOL = {
  /** Set by the CLI while a dashboard collects logs. */
  logsCapture: "brickkit.logs.capture",
  /** Core's function that records a log line on the running span. */
  logsRecord: "brickkit.logs.record",
  /** The set of running event hubs, so the CLI can stop them all. */
  eventsStarted: "brickkit.events.started",
  /** The key the dashboard signs `/app/*` identities with. */
  dashboardKey: "brickkit.dashboard.key",
} as const;
