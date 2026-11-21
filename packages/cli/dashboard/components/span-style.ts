import type { SpanKind } from "@/format";

/** Fill class for each span type. The legend, bars, and graph all share these. */
export const SPAN_BG: Record<SpanKind, string> = {
  http: "bg-span-request",
  action: "bg-span-action",
  rpc: "bg-span-rpc",
  sql: "bg-span-sql",
  fetch: "bg-span-fetch",
  other: "bg-span-other",
};

export const SPAN_LABEL: Record<SpanKind, string> = {
  http: "Request",
  action: "Action",
  rpc: "Service call",
  sql: "SQL",
  fetch: "Outbound HTTP",
  other: "Other",
};
