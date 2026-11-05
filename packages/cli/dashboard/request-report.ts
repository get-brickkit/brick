import { describeTrace, formatDuration, spanDepths, spanKind } from "@/format";
import type { LogRow } from "@/filters";
import { logsOfTrace } from "@/logs";
import {
  SPAN,
  type TraceSpan,
  type TraceSummary,
} from "../src/dashboard-protocol";

const pad = (width: number, text: string) => text.padEnd(width);

/** `text` with every line after the first moved in by `spaces`. */
function indent(text: string, spaces: number): string {
  return text.split("\n").join(`\n${" ".repeat(spaces)}`);
}

/** `key: value` on one line, or `key:` with a longer value in a block beneath. */
function entry(margin: string, key: string, attribute: unknown): string {
  const text = value(attribute);
  return text.includes("\n")
    ? `${margin}${key}:\n${margin}  ${indent(text, margin.length + 2)}`
    : `${margin}${key}: ${text}`;
}

function value(attribute: unknown): string {
  return typeof attribute === "string" ? attribute : JSON.stringify(attribute);
}

function describeSpan(
  span: TraceSpan,
  trace: TraceSummary,
  depth: number,
): string {
  const margin = "  ".repeat(depth);
  const took =
    span.endMs === undefined
      ? "running"
      : formatDuration(span.endMs - span.startMs);
  const lines = [
    `${margin}- ${span.name} [${spanKind(span)}] +${formatDuration(span.startMs - trace.startMs)}, ${took}, ${span.status}${span.statusMessage ? `: ${span.statusMessage}` : ""}`,
  ];
  const detail = `${margin}    `;
  for (const [key, attribute] of Object.entries(span.attributes)) {
    if (attribute !== undefined) lines.push(entry(detail, key, attribute));
  }
  for (const event of span.events) {
    // Log lines have a section of their own.
    if (event.name === SPAN.logEvent) continue;
    lines.push(
      `${detail}event ${event.name} at +${formatDuration(event.timeMs - trace.startMs)}`,
    );
    for (const [key, attribute] of Object.entries(event.attributes)) {
      if (attribute !== undefined)
        lines.push(entry(`${detail}  `, key, attribute));
    }
  }
  return lines.join("\n");
}

/**
 * Everything the dashboard knows about one request, as text to paste into an
 * issue or a chat: when it ran and how it ended, the error with its stack
 * trace, the lines it logged, and every span with all its attributes and
 * events (SQL statements included). `trace` is the request with its spans;
 * without it, only what the list knows about `source` is reported.
 */
export function requestReport(
  source: LogRow | TraceSummary,
  trace: TraceSummary | undefined,
  options: { loading?: boolean } = {},
): string {
  const basis = trace ?? source;
  const route = basis.method
    ? `${basis.method} ${basis.path ?? basis.route ?? basis.name}`
    : (basis.path ?? basis.route ?? basis.name);
  const started = new Date(basis.startMs);
  const out: string[] = [`# ${route}`, ""];
  const facts: [string, string | undefined][] = [
    ["Trace ID", basis.traceId],
    [
      "Started",
      `${started.toISOString()} (${started.toLocaleString([], { hour12: false })}.${String(started.getMilliseconds()).padStart(3, "0")} local)`,
    ],
    [
      "Status",
      // "ok" says the request finished, which an HTTP status already does.
      [
        basis.httpStatus === undefined
          ? "no HTTP status"
          : `HTTP ${basis.httpStatus}`,
        basis.status === "ok" && basis.httpStatus !== undefined
          ? undefined
          : basis.status,
      ]
        .filter(Boolean)
        .join(", "),
    ],
    ["Duration", formatDuration(basis.durationMs)],
    ["Route", basis.route],
    ["Path", basis.path],
    [
      "Handled by",
      basis.service
        ? `${basis.service}${basis.action ? `.${basis.action}` : ""}`
        : undefined,
    ],
  ];
  for (const [label, text] of facts)
    if (text !== undefined) out.push(`${pad(12, `${label}:`)}${text}`);

  const breakdown = trace ? describeTrace(trace) : undefined;
  const exception = breakdown?.exception;
  if (exception || basis.message) {
    out.push("", "## Error", "");
    if (exception?.code) out.push(`Code: ${exception.code}`);
    out.push(`Message: ${exception?.message ?? basis.message ?? ""}`);
    if (exception?.span) out.push(`Raised in: ${exception.span}`);
    if (exception?.stack) out.push("Stack trace:", exception.stack);
  }

  if (trace) {
    const logs = logsOfTrace(trace);
    if (logs.entries.length > 0 || logs.dropped > 0) {
      out.push("", `## Logs (${logs.entries.length})`, "");
      for (const entry of logs.entries)
        out.push(
          `+${formatDuration(entry.timeMs - trace.startMs)} ${entry.level.toUpperCase()} [${entry.span}] ${indent(entry.message, 2)}`,
        );
      if (logs.dropped > 0)
        out.push(`(${logs.dropped} more lines were not kept)`);
    }
    const depths = spanDepths(trace.spans);
    out.push("", `## Spans (${trace.spans.length})`, "");
    for (const span of trace.spans)
      out.push(describeSpan(span, trace, depths.get(span.spanId) ?? 0));
  } else {
    out.push(
      "",
      options.loading
        ? "(The spans were still loading when this was copied.)"
        : "(The spans are not available: the request is no longer kept.)",
    );
  }
  return `${out.join("\n")}\n`;
}
