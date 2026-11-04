import type { Attributes } from "@opentelemetry/api";
import type { ApiDocument, ArchitectureSchema } from "@brickkit/core";
import type { DevHistory } from "./dev-history";
import type {
  SerializedError,
  SpanEndRecord,
  SpanEventRecord,
  SpanStartRecord,
  TelemetryRecord,
  WorkerErrorPhase,
} from "./dev-telemetry";

export type SpanOutcome = "running" | "ok" | "error" | "interrupted";

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startMs: number;
  endMs?: number;
  status: SpanOutcome;
  statusMessage?: string;
  attributes: Attributes;
  events: SpanEventRecord[];
}

export interface TraceSummary {
  traceId: string;
  name: string;
  method?: string;
  route?: string;
  /** The request's actual path, which differs from a wildcard route template. */
  path?: string;
  httpStatus?: number;
  generation: number;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  status: SpanOutcome;
  truncated: boolean;
  /** The service and action that handled the request, when it ran one. */
  service?: string;
  action?: string;
  /** Why it failed, when it did. */
  message?: string;
  spans: TraceSpan[];
}

export interface FailureSummary {
  id: number;
  at: number;
  phase: "request" | WorkerErrorPhase;
  code: string;
  message: string;
  status?: number;
  stack?: string;
  traceId?: string;
  route?: string;
  service?: string;
  action?: string;
  generation: number;
}

export type ReloadKind = "started" | "restarting" | "exited" | "contract-ready";

export interface ReloadSummary {
  id: number;
  at: number;
  kind: ReloadKind;
  generation: number;
  detail?: string;
}

/** Services, actions, and routes of the application as last started. */
export interface ArchitectureSnapshot {
  generation: number;
  schema: ArchitectureSchema;
}

/** The OpenAPI documents the app offers, for the dashboard's APIs view. */
export interface ApiSnapshot {
  /** Changes each time the documents are replaced, so views know to reload. */
  revision: number;
  /** Where the app listens; Try it in the APIs view sends requests here. */
  appUrl?: string;
  /** Names of the documents, in order. */
  titles: string[];
}

/** What the dashboard knows about the app's developer documentation. */
export interface DocsSnapshot {
  /** Changes whenever the pages change, so the Docs tab reloads. */
  revision: number;
  status: "ready" | "missing" | "error";
  title: string;
  /** Whether the project supplied components of its own. */
  components: boolean;
  /** Why the docs cannot be shown, when `status` is not ready. */
  message?: string;
  /** Packages to install, when `status` is "missing". */
  packages?: string[];
}

export type DevTelemetryEvent =
  | { type: "trace"; trace: TraceSummary }
  | { type: "failure"; failure: FailureSummary }
  | { type: "reload"; reload: ReloadSummary }
  | { type: "architecture"; architecture: ArchitectureSnapshot }
  | { type: "api"; api: ApiSnapshot }
  | { type: "docs"; docs: DocsSnapshot | null }
  | { type: "inspector"; inspector: boolean };

export interface DevTelemetrySnapshot {
  traces: TraceSummary[];
  failures: FailureSummary[];
  reloads: ReloadSummary[];
  architecture: ArchitectureSnapshot | null;
  api: ApiSnapshot | null;
  /** Null when the app has no `documentation`. */
  docs: DocsSnapshot | null;
  /** Whether the app serves the workflow inspector the dashboard can show. */
  inspector: boolean;
}

const LIMITS = { traces: 200, spansPerTrace: 500, failures: 200, reloads: 100 };

const WORKER_FAILURE_CODES: Record<WorkerErrorPhase, string> = {
  startup: "STARTUP_FAILED",
  uncaught: "UNCAUGHT_EXCEPTION",
  "unhandled-rejection": "UNHANDLED_REJECTION",
};

interface TraceEntry {
  traceId: string;
  generation: number;
  spans: Map<string, TraceSpan>;
  rootSpanId?: string;
  name: string;
  method?: string;
  route?: string;
  path?: string;
  httpStatus?: number;
  startMs: number;
  endMs?: number;
  status: SpanOutcome;
  failureRecorded: boolean;
  truncated: boolean;
  message?: string;
}

/**
 * Supervisor-side history of requests, failures, and reloads. It lives in the
 * parent process, so it survives application restarts.
 */
export class DevTelemetryStore {
  readonly #traces = new Map<string, TraceEntry>();
  readonly #failures: FailureSummary[] = [];
  readonly #reloads: ReloadSummary[] = [];
  readonly #listeners = new Set<(event: DevTelemetryEvent) => void>();
  readonly #history: DevHistory | undefined;
  #architecture: ArchitectureSnapshot | null = null;
  #api: ApiSnapshot | null = null;
  #docs: DocsSnapshot | null = null;
  #inspector: { port: number; token: string } | undefined;
  #apiDocuments: ApiDocument[] = [];
  #sequence = 0;
  #generation = 0;

  /** Finished requests and failures are also kept in `history`, when given. */
  constructor(options: { history?: DevHistory } = {}) {
    this.#history = options.history;
  }

  /** Replace the architecture with the one from the latest successful start. */
  setArchitecture(schema: ArchitectureSchema, generation: number): void {
    this.#architecture = { generation, schema };
    this.#emit({ type: "architecture", architecture: this.#architecture });
  }

  ingest(records: TelemetryRecord[], generation: number): void {
    const touched = new Set<TraceEntry>();
    for (const record of records) {
      const timeMs = record.phase === "start" ? record.startMs : record.endMs;
      const entry = this.#entry(record.traceId, generation, timeMs);
      touched.add(entry);
      if (record.phase === "start") this.#start(entry, record);
      else this.#end(entry, record);
    }
    for (const entry of touched) {
      const trace = summarize(entry);
      this.#emit({ type: "trace", trace });
      // A request cut off by a restart is not a result worth keeping, and one
      // still running will be saved when it finishes.
      if (entry.status === "ok" || entry.status === "error") {
        this.#history?.saveTrace(trace);
      }
    }
  }

  recordWorkerError(
    phase: WorkerErrorPhase,
    error: SerializedError,
    generation: number,
  ): void {
    this.#pushFailure({
      phase,
      code: WORKER_FAILURE_CODES[phase],
      message: error.message,
      stack: error.stack,
      generation,
    });
  }

  recordReload(reload: Omit<ReloadSummary, "id" | "at">): void {
    const summary: ReloadSummary = {
      id: ++this.#sequence,
      at: Date.now(),
      ...reload,
    };
    this.#reloads.unshift(summary);
    if (this.#reloads.length > LIMITS.reloads) {
      this.#reloads.length = LIMITS.reloads;
    }
    this.#emit({ type: "reload", reload: summary });
  }

  /** Newest generation; spans reported without a process identity belong to it. */
  get latestGeneration(): number {
    return this.#generation;
  }

  /** Begin a generation when an application process loads, and record the reload. */
  startGeneration(detail: string): number {
    this.#generation += 1;
    this.recordReload({
      kind: "started",
      generation: this.#generation,
      detail,
    });
    return this.#generation;
  }

  /** Mark requests still running in a process that has exited as interrupted. */
  interruptGeneration(generation: number): void {
    const now = Date.now();
    for (const entry of this.#traces.values()) {
      if (entry.generation !== generation || entry.status !== "running")
        continue;
      entry.status = "interrupted";
      entry.endMs = now;
      for (const span of entry.spans.values()) {
        if (span.status !== "running") continue;
        span.status = "interrupted";
        span.endMs = now;
      }
      this.#emit({ type: "trace", trace: summarize(entry) });
    }
  }

  /** Replace the OpenAPI documents with the ones from the latest start. */
  setApiDocuments(documents: ApiDocument[], appUrl?: string): void {
    this.#apiDocuments = documents;
    this.#api = {
      revision: (this.#api?.revision ?? 0) + 1,
      ...(appUrl ? { appUrl } : {}),
      titles: documents.map((item) => item.title),
    };
    this.#emit({ type: "api", api: this.#api });
  }

  /** Set what the Docs tab shows; null when the app has no documentation. */
  setDocs(docs: DocsSnapshot | null): void {
    this.#docs = docs;
    this.#emit({ type: "docs", docs });
  }

  /**
   * Set where the app serves its workflow inspector, or `undefined` when it
   * stops. The address stays here: the snapshot says only whether there is one.
   */
  setInspector(target: { port: number; token: string } | undefined): void {
    this.#inspector = target;
    this.#emit({ type: "inspector", inspector: Boolean(target) });
  }

  /** Where the dashboard proxies the workflow inspector, when the app serves one. */
  inspectorTarget(): { port: number; token: string } | undefined {
    return this.#inspector;
  }

  /** What the APIs view knows about the documents, without the documents. */
  apiSnapshot(): ApiSnapshot | null {
    return this.#api;
  }

  /** The documents themselves; the snapshot carries only their names. */
  apiDocuments(): ApiDocument[] {
    return this.#apiDocuments;
  }

  snapshot(): DevTelemetrySnapshot {
    return {
      traces: [...this.#traces.values()].reverse().map(summarize),
      failures: [...this.#failures],
      reloads: [...this.#reloads],
      architecture: this.#architecture,
      api: this.#api,
      docs: this.#docs,
      inspector: Boolean(this.#inspector),
    };
  }

  subscribe(listener: (event: DevTelemetryEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #entry(traceId: string, generation: number, timeMs: number): TraceEntry {
    let entry = this.#traces.get(traceId);
    if (!entry) {
      entry = {
        traceId,
        generation,
        spans: new Map(),
        name: "",
        startMs: timeMs,
        status: "running",
        failureRecorded: false,
        truncated: false,
      };
      this.#traces.set(traceId, entry);
      if (this.#traces.size > LIMITS.traces) {
        const oldest = this.#traces.keys().next().value;
        if (oldest !== undefined) this.#traces.delete(oldest);
      }
    }
    return entry;
  }

  #start(entry: TraceEntry, record: SpanStartRecord): void {
    entry.startMs = Math.min(entry.startMs, record.startMs);
    // The local root has no parent here: either none, or a remote caller's span
    // from an incoming traceparent. Children start after it in this process.
    const parentIsLocal =
      record.parentSpanId !== undefined && entry.spans.has(record.parentSpanId);
    if (!parentIsLocal && entry.rootSpanId === undefined) {
      entry.rootSpanId = record.spanId;
      entry.name = record.name;
      entry.method = stringAttribute(record.attributes, "http.request.method");
      entry.route = stringAttribute(record.attributes, "http.route");
      entry.path = stringAttribute(record.attributes, "url.path");
    }
    if (entry.spans.size >= LIMITS.spansPerTrace) {
      entry.truncated = true;
      return;
    }
    entry.spans.set(record.spanId, {
      spanId: record.spanId,
      parentSpanId: record.parentSpanId,
      name: record.name,
      startMs: record.startMs,
      status: "running",
      attributes: record.attributes,
      events: [],
    });
  }

  #end(entry: TraceEntry, record: SpanEndRecord): void {
    const existing = entry.spans.get(record.spanId);
    const span: TraceSpan = existing ?? {
      spanId: record.spanId,
      name: record.name,
      startMs: record.endMs,
      status: "running",
      attributes: {},
      events: [],
    };
    if (!existing) {
      if (entry.spans.size < LIMITS.spansPerTrace) {
        entry.spans.set(record.spanId, span);
      } else {
        entry.truncated = true;
      }
    }
    span.endMs = record.endMs;
    span.status = record.status === "error" ? "error" : "ok";
    span.statusMessage = record.statusMessage;
    span.attributes = { ...span.attributes, ...record.attributes };
    span.events = record.events;

    const code = stringAttribute(record.attributes, "brick.error.code");
    if (code !== undefined) {
      const exception = findException(record.events);
      this.#pushFailure({
        phase: "request",
        code,
        message:
          stringAttribute(exception, "exception.message") ??
          stringAttribute(record.attributes, "brick.error.message") ??
          code,
        status: numberAttribute(record.attributes, "brick.error.status"),
        stack: stringAttribute(exception, "exception.stacktrace"),
        traceId: entry.traceId,
        route: entry.route,
        service: stringAttribute(record.attributes, "brick.service"),
        action: stringAttribute(record.attributes, "brick.action"),
        generation: entry.generation,
      });
      entry.failureRecorded = true;
    }

    if (record.spanId !== entry.rootSpanId) return;
    entry.endMs = record.endMs;
    entry.httpStatus = numberAttribute(
      record.attributes,
      "http.response.status_code",
    );
    // Server faults make the trace an error. Client errors still show in the
    // Errors tab, so a raw route's 401 is visible without a coded failure.
    const status = entry.httpStatus ?? 0;
    const serverFault = status >= 500;
    const failed = record.status === "error" || serverFault;
    entry.status = failed ? "error" : "ok";
    if ((failed || status >= 400) && !entry.failureRecorded) {
      const exception = findException(record.events);
      this.#pushFailure({
        phase: "request",
        code: status >= 400 ? `HTTP_${status}` : "UNHANDLED_ERROR",
        message:
          stringAttribute(exception, "exception.message") ??
          record.statusMessage ??
          describeResponse(entry, status),
        status: entry.httpStatus,
        stack: stringAttribute(exception, "exception.stacktrace"),
        traceId: entry.traceId,
        route: entry.route,
        generation: entry.generation,
      });
      entry.failureRecorded = true;
    }
  }

  #pushFailure(failure: Omit<FailureSummary, "id" | "at">): void {
    const entry: FailureSummary = {
      id: ++this.#sequence,
      at: Date.now(),
      ...failure,
    };
    this.#failures.unshift(entry);
    if (this.#failures.length > LIMITS.failures) {
      this.#failures.length = LIMITS.failures;
    }
    // The request keeps the first reason it failed, to show beside it.
    const trace =
      failure.traceId === undefined
        ? undefined
        : this.#traces.get(failure.traceId);
    if (trace) trace.message ??= failure.message;
    this.#emit({ type: "failure", failure: entry });
  }

  #emit(event: DevTelemetryEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        this.#listeners.delete(listener);
      }
    }
  }
}

function summarize(entry: TraceEntry): TraceSummary {
  const spans = [...entry.spans.values()].sort((a, b) => a.startMs - b.startMs);
  const actionSpan = spans.find((span) => span.name.startsWith("action "));
  return {
    traceId: entry.traceId,
    name: entry.name || spans[0]?.name || entry.traceId,
    method: entry.method,
    route: entry.route,
    path: entry.path,
    httpStatus: entry.httpStatus,
    generation: entry.generation,
    startMs: entry.startMs,
    endMs: entry.endMs,
    durationMs:
      entry.endMs === undefined ? undefined : entry.endMs - entry.startMs,
    status: entry.status,
    truncated: entry.truncated,
    service: stringAttribute(actionSpan?.attributes, "brick.service"),
    action: stringAttribute(actionSpan?.attributes, "brick.action"),
    message: entry.message,
    spans,
  };
}

function describeResponse(entry: TraceEntry, status: number): string {
  const target = entry.path ?? entry.route ?? entry.name;
  const request = entry.method ? `${entry.method} ${target}` : target;
  return status ? `${request} returned ${status}` : request;
}

function findException(events: SpanEventRecord[]): Attributes | undefined {
  return events.find((event) => event.name === "exception")?.attributes;
}

function stringAttribute(
  attributes: Attributes | undefined,
  key: string,
): string | undefined {
  const value = attributes?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberAttribute(
  attributes: Attributes | undefined,
  key: string,
): number | undefined {
  const value = attributes?.[key];
  return typeof value === "number" ? value : undefined;
}
