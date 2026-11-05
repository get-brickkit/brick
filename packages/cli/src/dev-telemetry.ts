import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type HrTime,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  TracerProvider,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { GLOBAL_SYMBOL } from "@brickkit/core";
import type {
  ApiDocument,
  ArchitectureSchema,
  DocumentationOptions,
} from "@brickkit/core";

/** Read by @brickkit/core's logger; see `createLogger` there. */
const LOG_CAPTURE = Symbol.for(GLOBAL_SYMBOL.logsCapture);
/** Core's function that records a line on the running span; see `recordActive` there. */
const LOG_RECORD = Symbol.for(GLOBAL_SYMBOL.logsRecord);
const CONSOLE_CAPTURED = Symbol.for("brickkit.console.captured");

const CONSOLE_LEVELS = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
} as const;

const MAX_TEXT_LENGTH = 500;
const MAX_STACK_LENGTH = 4000;
const FLUSH_DELAY_MS = 20;
const MAX_BATCH_SIZE = 200;
const SEND_TIMEOUT_MS = 1000;

export interface SpanEventRecord {
  name: string;
  timeMs: number;
  attributes: Attributes;
}

export interface SpanStartRecord {
  phase: "start";
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  attributes: Attributes;
}

export interface SpanEndRecord {
  phase: "end";
  traceId: string;
  spanId: string;
  name: string;
  endMs: number;
  status: "unset" | "ok" | "error";
  statusMessage?: string;
  attributes: Attributes;
  events: SpanEventRecord[];
}

export type TelemetryRecord = SpanStartRecord | SpanEndRecord;

export type WorkerErrorPhase = "startup" | "uncaught" | "unhandled-rejection";

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

/** Messages the dev worker sends to the supervisor over the IPC channel. */
export type WorkerMessage =
  | { type: "brick:telemetry"; records: TelemetryRecord[] }
  | { type: "brick:error"; phase: WorkerErrorPhase; error: SerializedError }
  | { type: "brick:architecture"; architecture: ArchitectureSchema }
  | { type: "brick:api-documents"; documents: ApiDocument[] }
  | {
      type: "brick:inspector";
      /** The loopback port the workflow inspector listens on. */
      port: number;
      /** What the dashboard sends with each request to prove who it is. */
      token: string;
    }
  | {
      type: "brick:documentation";
      /** The app's `documentation` option; absent when it has none. */
      documentation?: DocumentationOptions;
    };

/**
 * Register the tracer provider, context manager, and W3C trace context
 * propagator. Span records are batched and passed to `onRecords`. Returns false
 * when another tracer provider was already registered, in which case
 * `onRecords` never runs.
 */
export function installTracing(
  onRecords: (records: TelemetryRecord[]) => void,
): boolean {
  const batcher = new RecordBatcher(onRecords);
  const registered = trace.setGlobalTracerProvider(
    new TracerProvider({
      spanProcessors: [new SupervisorSpanProcessor(batcher)],
    }),
  );
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  // From here the dashboard shows what actions and tools log, as span events,
  // so @brickkit/core stops printing it. The key is shared by name because the
  // app and the dev server may each hold their own copy of core.
  if (registered) {
    (globalThis as Record<symbol, unknown>)[LOG_CAPTURE] = true;
    captureConsole();
  }
  return registered;
}

type Restore = () => void;

/**
 * Send `console.log`, `info`, `warn`, `error`, and `debug` to the dashboard
 * while a traced request is running, as `ctx.logger` does, so code that logs
 * with `console` needs no change. Lines logged outside a request print as
 * usual. Only a dashboard turns this on, `brick dev`'s or the monitoring one
 * of `brick start`: with neither, the console is left alone. Calling it again
 * does nothing; the returned function puts the console back.
 */
export function captureConsole(): Restore {
  const target = console as unknown as Record<string | symbol, unknown>;
  const existing = target[CONSOLE_CAPTURED];
  if (typeof existing === "function") return existing as Restore;

  const globals = globalThis as Record<symbol, unknown>;
  const originals = new Map<string, (...args: unknown[]) => void>();
  for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
    const original = target[method] as (...args: unknown[]) => void;
    originals.set(method, original);
    target[method] = function (this: unknown, ...args: unknown[]) {
      const record = globals[LOG_RECORD];
      if (
        globals[LOG_CAPTURE] === true &&
        typeof record === "function" &&
        record(level, args) === true
      )
        return;
      original.apply(this, args);
    };
  }
  const restore: Restore = () => {
    for (const [method, original] of originals) target[method] = original;
    delete target[CONSOLE_CAPTURED];
  };
  target[CONSOLE_CAPTURED] = restore;
  return restore;
}

/**
 * Install tracing in the dev worker, so spans from apps built with
 * `brick({ telemetry: true })` reach the supervisor and join callers' traces.
 * Call before the app entry is imported.
 */
export function installWorkerTelemetry(): void {
  installTracing((records) => {
    void sendToSupervisor({ type: "brick:telemetry", records });
  });
}

/** Resolves once the message is written, or after a short timeout if the channel is gone. */
export function sendToSupervisor(message: WorkerMessage): Promise<void> {
  if (!process.send) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SEND_TIMEOUT_MS);
    try {
      process.send!(message, () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

export function reportWorkerError(
  phase: WorkerErrorPhase,
  error: unknown,
): Promise<void> {
  return sendToSupervisor({
    type: "brick:error",
    phase,
    error: serializeError(error),
  });
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: truncate(error.message),
      stack:
        error.stack === undefined
          ? undefined
          : truncate(error.stack, MAX_STACK_LENGTH),
    };
  }
  return { name: "Error", message: truncate(String(error)) };
}

function truncate(text: string, limit = MAX_TEXT_LENGTH): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function toMs(time: HrTime): number {
  return time[0] * 1000 + time[1] / 1e6;
}

function statusName(code: SpanStatusCode): "unset" | "ok" | "error" {
  if (code === SpanStatusCode.ERROR) return "error";
  if (code === SpanStatusCode.OK) return "ok";
  return "unset";
}

function boundAttributes(attributes: Attributes | undefined): Attributes {
  const bounded: Attributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    bounded[key] =
      typeof value === "string" ? truncate(value, MAX_STACK_LENGTH) : value;
  }
  return bounded;
}

class RecordBatcher {
  #records: TelemetryRecord[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  readonly #send: (records: TelemetryRecord[]) => void;

  constructor(send: (records: TelemetryRecord[]) => void) {
    this.#send = send;
  }

  push(record: TelemetryRecord): void {
    this.#records.push(record);
    if (this.#records.length >= MAX_BATCH_SIZE) this.flush();
    else this.#timer ??= setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }

  flush(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#records.length === 0) return;
    const records = this.#records;
    this.#records = [];
    this.#send(records);
  }
}

class SupervisorSpanProcessor implements SpanProcessor {
  readonly #batcher: RecordBatcher;

  constructor(batcher: RecordBatcher) {
    this.#batcher = batcher;
  }

  onStart(span: Span): void {
    const { traceId, spanId } = span.spanContext();
    this.#batcher.push({
      phase: "start",
      traceId,
      spanId,
      parentSpanId: span.parentSpanContext?.spanId,
      name: span.name,
      startMs: toMs(span.startTime),
      attributes: boundAttributes(span.attributes),
    });
  }

  onEnd(span: ReadableSpan): void {
    const { traceId, spanId } = span.spanContext();
    this.#batcher.push({
      phase: "end",
      traceId,
      spanId,
      name: span.name,
      endMs: toMs(span.endTime),
      status: statusName(span.status.code),
      statusMessage: span.status.message,
      attributes: boundAttributes(span.attributes),
      events: span.events.map((event) => ({
        name: event.name,
        timeMs: toMs(event.time),
        attributes: boundAttributes(event.attributes),
      })),
    });
  }

  async forceFlush(): Promise<void> {
    this.#batcher.flush();
  }

  async shutdown(): Promise<void> {
    this.#batcher.flush();
  }
}
