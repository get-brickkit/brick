import { useCallback, useEffect, useRef, useState } from "react";
import { listStreams } from "~/lib/client/workflow-streams";

const STREAMS_REFRESH_INTERVAL_MS = 10000;

/**
 * Hook to fetch and manage stream list for a run
 */
export function useWorkflowStreams(
  runId: string,
  refreshInterval: number = STREAMS_REFRESH_INTERVAL_MS,
) {
  const [streams, setStreams] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const hasFetchedRef = useRef(false);

  const fetchData = useCallback(async () => {
    if (!hasFetchedRef.current) {
      setLoading(true);
    }
    setError(null);
    try {
      const result = await listStreams(runId);
      setStreams(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      hasFetchedRef.current = true;
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    hasFetchedRef.current = false;
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!refreshInterval || refreshInterval <= 0) {
      return;
    }

    const interval = setInterval(fetchData, refreshInterval);
    return () => clearInterval(interval);
  }, [refreshInterval, fetchData]);

  return {
    streams,
    loading,
    error,
    refresh: fetchData,
  };
}
