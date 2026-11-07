import type { WorkflowRunStatus } from "@workflow/world";

/** One color per status, for the status badge and the status filter. */
export const STATUS_COLORS: Record<WorkflowRunStatus, string> = {
  pending: "bg-gray-500",
  running: "bg-geist-warning",
  completed: "bg-geist-cyan",
  failed: "bg-geist-error",
  cancelled: "bg-gray-500",
};

export function getStatusColorClass(status: string): string {
  return STATUS_COLORS[status as WorkflowRunStatus] ?? "bg-gray-500";
}
