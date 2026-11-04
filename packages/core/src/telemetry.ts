import {
  context,
  propagation,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";

const INSTRUMENTATION_SCOPE = "@brickkit/core";
const MAX_TEXT_LENGTH = 500;
const MAX_STATEMENT_LENGTH = 2000;
const DATABASE_INSTRUMENTED = Symbol.for("brickkit.telemetry.database");
const SQLITE_STATEMENT_METHODS = ["all", "get", "run", "values"] as const;

type Outcome =
  | { failed: false; value: unknown }
  | { failed: true; error: unknown };

/** Run `fn` as a child of the active span, ending the span when its result settles. */
export function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => T,
  kind: SpanKind = SpanKind.INTERNAL,
): T {
  return trace
    .getTracer(INSTRUMENTATION_SCOPE)
    .startActiveSpan(name, { kind, attributes }, (span) =>
      settle(fn, (outcome) => {
        if (outcome.failed) recordThrown(span, outcome.error);
        span.end();
      }),
    );
}

/**
 * Add a child span for an in-process call, but only inside a request that is
 * already traced. Calls made outside instrumented requests run unchanged.
 */
export function withCallSpan<T>(
  name: string,
  attributes: Attributes,
  fn: () => T,
): T {
  return trace.getActiveSpan() ? withSpan(name, attributes, fn) : fn();
}

interface HttpContext {
  request?: Request;
  headers?: Record<string, string | undefined>;
  set?: { status?: unknown; headers?: Record<string, unknown> };
}

/** What a raw route handler receives from `traceRoute`. Read the body from `request`. */
export interface RawRouteContext {
  request: Request;
  headers: Record<string, string | undefined>;
  set: { status?: unknown; headers?: Record<string, unknown> };
  params: Record<string, string>;
  query: Record<string, string | undefined>;
}

/**
 * Wrap a raw route handler so each of its requests gets a server span. Use it
 * for routes registered directly on the app, outside actions and endpoints,
 * such as auth or webhook routes. Spans are recorded whenever a tracer provider
 * is registered; `brick({ telemetry })` does not apply to these routes.
 *
 * The wrapper forwards only the fields listed in `RawRouteContext`. Elysia
 * decides what to parse from the handler's destructuring, and forwarding the
 * whole context would parse the body and leave `request.json()` with nothing.
 */
export function traceRoute<T>(
  route: string,
  handler: (context: RawRouteContext) => T,
): (context: RawRouteContext) => T {
  return ({ request, headers, set, params, query }) =>
    traceHttpRequest({ request, headers, set }, request.method, route, () =>
      handler({ request, headers, set, params, query }),
    );
}

/**
 * Wrap one HTTP request in a server span. The span continues the caller's
 * trace when a W3C `traceparent` arrives. Without an `x-trace-id` header, the
 * request id Brick returns is the span's trace id, so clients can find the
 * request in the dashboard.
 */
export function traceHttpRequest<T>(
  request: HttpContext,
  method: string,
  route: string,
  fn: () => T,
): T {
  const attributes: Attributes = {
    "http.request.method": method,
    "http.route": route,
  };
  if (request.request) {
    attributes["url.path"] = new URL(request.request.url).pathname;
  }
  const headers = request.headers ?? {};
  const parent = propagation.extract(context.active(), headers);
  return trace
    .getTracer(INSTRUMENTATION_SCOPE)
    .startActiveSpan(
      `${method} ${route}`,
      { kind: SpanKind.SERVER, attributes },
      parent,
      (span) => {
        if (!headers["x-trace-id"]) {
          headers["x-trace-id"] = span.spanContext().traceId;
        }
        const outgoing: Record<string, string> = {};
        propagation.inject(context.active(), outgoing);
        if (request.set?.headers) Object.assign(request.set.headers, outgoing);
        return settle(fn, (outcome) => {
          // Raw handlers often return a Response, whose status Elysia's `set` never sees.
          const status = outcome.failed
            ? 500
            : outcome.value instanceof Response
              ? outcome.value.status
              : responseStatus(request.set?.status);
          if (outcome.failed) recordThrown(span, outcome.error);
          span.setAttribute("http.response.status_code", status);
          const traceId = headers["x-trace-id"];
          if (traceId) span.setAttribute("brick.trace_id", traceId);
          if (status >= 500) {
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `HTTP ${status}`,
            });
          }
          span.end();
        });
      },
    );
}

/**
 * Attach a handled failure to the active span. Brick returns these as
 * responses rather than throwing, so only server faults (5xx) mark the span
 * as errored; client errors keep their code as an attribute.
 */
export function recordFailure(
  error: unknown,
  failure: { status: number; code: string; message: string },
): void {
  const span = trace.getActiveSpan();
  if (!span) return;
  span.setAttributes({
    "brick.error.code": failure.code,
    "brick.error.status": failure.status,
    "brick.error.message": truncate(failure.message),
  });
  if (failure.status >= 500) recordThrown(span, error);
}

/**
 * Record SQL statements as client spans for the database behind a service.
 * Drizzle's logger has no timing, so the hook sits on the driver: each
 * statement is timed where the driver runs it. Statements outside traced
 * requests are not recorded. Calling this again on the same client is a no-op.
 */
export function instrumentDatabase(db: unknown): void {
  const client = (db as { $client?: unknown } | undefined)?.$client;
  // postgres.js clients are callable functions, so accept both shapes.
  if (
    (typeof client !== "object" && typeof client !== "function") ||
    client === null
  ) {
    return;
  }
  const driver = client as Record<PropertyKey, unknown>;
  if (driver[DATABASE_INSTRUMENTED]) return;
  if (typeof driver.prepare === "function") {
    instrumentBunSqlite(driver as unknown as BunSqliteClient);
  } else if (typeof driver.unsafe === "function") {
    instrumentPostgres(driver as unknown as PostgresClient);
  } else {
    return;
  }
  driver[DATABASE_INSTRUMENTED] = true;
}

type BunSqliteStatement = Record<
  (typeof SQLITE_STATEMENT_METHODS)[number],
  (...args: unknown[]) => unknown
>;

interface BunSqliteClient {
  prepare: (sql: string) => BunSqliteStatement;
}

function instrumentBunSqlite(client: BunSqliteClient): void {
  const prepare = client.prepare.bind(client);
  client.prepare = (sql: string) => {
    const statement = prepare(sql);
    for (const method of SQLITE_STATEMENT_METHODS) {
      const original = statement[method];
      if (typeof original !== "function") continue;
      statement[method] = (...args: unknown[]) =>
        recordStatement(sql, "sqlite", () => original.apply(statement, args));
    }
    return statement;
  };
}

interface PostgresQuery {
  then: (
    onFulfilled?: (value: unknown) => unknown,
    onRejected?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
}

interface PostgresClient {
  unsafe: (sql: string, ...rest: unknown[]) => PostgresQuery;
}

/**
 * postgres.js returns a query that runs when awaited, and `values()` returns
 * that same object, so overriding `then` on it times the whole round trip.
 */
function instrumentPostgres(client: PostgresClient): void {
  const unsafe = client.unsafe.bind(client);
  client.unsafe = (sql: string, ...rest: unknown[]) => {
    const query = unsafe(sql, ...rest);
    if (!trace.getActiveSpan() || typeof query?.then !== "function") {
      return query;
    }
    const span = startStatementSpan(sql, "postgresql");
    let finished = false;
    const finish = (outcome: Outcome) => {
      if (finished) return;
      finished = true;
      if (outcome.failed) recordThrown(span, outcome.error);
      span.end();
    };
    const then = query.then.bind(query);
    // The query is already thenable; this wraps its own `then` to time the
    // round trip, so the no-thenable rule does not apply.
    // oxlint-disable-next-line unicorn/no-thenable
    query.then = (onFulfilled, onRejected) =>
      then(
        (value) => {
          finish({ failed: false, value });
          return onFulfilled ? onFulfilled(value) : value;
        },
        (error: unknown) => {
          finish({ failed: true, error });
          if (onRejected) return onRejected(error);
          throw error;
        },
      );
    return query;
  };
}

function recordStatement<T>(sql: string, system: string, fn: () => T): T {
  if (!trace.getActiveSpan()) return fn();
  return withSpan(
    statementName(sql),
    statementAttributes(sql, system),
    fn,
    SpanKind.CLIENT,
  );
}

function startStatementSpan(sql: string, system: string): Span {
  return trace
    .getTracer(INSTRUMENTATION_SCOPE)
    .startSpan(
      statementName(sql),
      { kind: SpanKind.CLIENT, attributes: statementAttributes(sql, system) },
      context.active(),
    );
}

function statementName(sql: string): string {
  return `SQL ${operationOf(sql)}`;
}

function statementAttributes(sql: string, system: string): Attributes {
  return {
    "db.system": system,
    "db.operation": operationOf(sql),
    "db.statement": truncate(sql, MAX_STATEMENT_LENGTH),
  };
}

function operationOf(sql: string): string {
  return sql.trim().split(/\s+/, 1)[0]?.toUpperCase() || "SQL";
}

function settle<T>(fn: () => T, done: (outcome: Outcome) => void): T {
  let result: T;
  try {
    result = fn();
  } catch (error) {
    done({ failed: true, error });
    throw error;
  }
  if (isPromiseLike(result)) {
    return result.then(
      (value) => {
        done({ failed: false, value });
        return value;
      },
      (error: unknown) => {
        done({ failed: true, error });
        throw error;
      },
    ) as unknown as T;
  }
  done({ failed: false, value: result });
  return result;
}

function recordThrown(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: truncate(messageOf(error)),
  });
}

function responseStatus(value: unknown): number {
  const status = typeof value === "number" ? value : Number(value ?? 200);
  return Number.isInteger(status) ? status : 200;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string, limit = MAX_TEXT_LENGTH): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
