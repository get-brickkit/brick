import type { Event, WorkflowRunStatus } from "@workflow/world";
import { useEffect, useMemo, useState } from "react";
import { getCancellationReason } from "~/lib/cancellation-reason";
import { unwrapServerActionResult } from "../workflow-errors";
import { rpc } from "~/lib/rpc-client";

/**
 * Reads the cancellation reason from loaded trace events, falling back to the
 * terminal event for long runs whose initial trace page does not include it.
 */
export function useCancellationReason(
  runId: string,
  status: WorkflowRunStatus | undefined,
  events: readonly Event[] | null | undefined,
): string | undefined {
  const loadedReason = useMemo(() => getCancellationReason(events), [events]);
  const [terminalReason, setTerminalReason] = useState<string>();

  useEffect(() => {
    setTerminalReason(undefined);
    if (status !== "cancelled" || loadedReason) return;

    let ignore = false;
    void unwrapServerActionResult(
      rpc("fetchEvents", {
        runId,
        sortOrder: "desc",
        limit: 1,
        withData: false,
      }),
    ).then(({ error, result }) => {
      if (!ignore && !error) {
        setTerminalReason(getCancellationReason(result.data));
      }
    });

    return () => {
      ignore = true;
    };
  }, [runId, status, loadedReason]);

  return loadedReason ?? terminalReason;
}
