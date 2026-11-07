import { parseWorkflowName } from "@workflow/utils/parse-name";
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workflow/web-shared";
import {
  BULK_CANCEL_MAX_RUN_IDS,
  type Event,
  type WorkflowRun,
  type WorkflowRunStatus,
} from "@workflow/world";
import { STATUS_COLORS } from "~/lib/status-colors";
import {
  AlertCircle,
  ArrowDownAZ,
  ArrowUpAZ,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  XCircle,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Card, CardContent } from "~/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  bulkCancelToastSeverity,
  shouldRetainSelectionAfterBulkCancel,
} from "~/lib/bulk-cancel-ui";
import { useTableSelection } from "~/lib/hooks/use-table-selection";
import { getRunReplayDisabledReason } from "~/lib/run-replay";
import { CopyableText } from "./display-utils/copyable-text";
import { RelativeTime } from "./display-utils/relative-time";
import { SelectionBar } from "./display-utils/selection-bar";
import { StatusBadge } from "./display-utils/status-badge";
import { RunActionsDropdownItems } from "./run-actions";
import { Checkbox } from "./ui/checkbox";
import { useWorkflowRunsInfinite } from "~/lib/client/hooks/use-infinite-list";
import { useLoadMoreOnScroll } from "~/lib/client/hooks/use-load-more-on-scroll";
import { getErrorMessage, unwrapOrThrow } from "~/lib/client/workflow-errors";
import { rpc } from "~/lib/rpc-client";

// Inner content that fetches events when it mounts (only rendered when dropdown is open)
function RunActionsDropdownContentInner({
  runId,
  runStatus,
  onSuccess,
}: {
  runId: string;
  runStatus: WorkflowRunStatus | undefined;
  onSuccess: () => void;
}) {
  const [events, setEvents] = useState<Event[] | undefined>(undefined);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [run, setRun] = useState<WorkflowRun | undefined>(undefined);
  const [runIdentityLoading, setRunIdentityLoading] = useState(true);
  const status = run?.status || runStatus;

  useEffect(() => {
    setRun(undefined);
    setRunIdentityLoading(true);
    rpc("fetchRun", { runId, resolveData: "none" })
      .then((runResult) => {
        if (runResult.success) {
          setRun(runResult.data);
        }
      })
      .catch((err: unknown) => {
        console.error("Failed to fetch run:", err);
      })
      .finally(() => {
        setRunIdentityLoading(false);
      });

    setEvents(undefined);
    setEventsLoading(true);
    rpc("fetchEvents", { runId, limit: 1000, sortOrder: "desc" })
      .then((eventsResult) => {
        if (eventsResult.success) {
          setEvents(eventsResult.data.data);
        }
      })
      .catch((err: unknown) => {
        console.error("Failed to fetch events:", err);
      })
      .finally(() => {
        setEventsLoading(false);
      });
  }, [runId]);

  return (
    <RunActionsDropdownItems
      runId={runId}
      runStatus={status}
      events={events}
      eventsLoading={eventsLoading}
      replayDisabledReason={getRunReplayDisabledReason(run, runIdentityLoading)}
      stopPropagation
      callbacks={{ onSuccess }}
    />
  );
}

// Wrapper that only renders content when dropdown is open (lazy loading)
function LazyDropdownMenu({
  runId,
  runStatus,
  onSuccess,
}: {
  runId: string;
  runStatus: WorkflowRunStatus | undefined;
  onSuccess: () => void;
}) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="tertiary"
          size="small"
          shape="square"
          aria-label="Run actions"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      {isOpen && (
        <DropdownMenuContent align="end">
          <RunActionsDropdownContentInner
            runId={runId}
            runStatus={runStatus}
            onSuccess={onSuccess}
          />
        </DropdownMenuContent>
      )}
    </DropdownMenu>
  );
}

interface RunsTableProps {
  onRunClick: (runId: string) => void;
}

const statusMap: Record<WorkflowRunStatus, { label: string; color: string }> = {
  pending: { label: "Pending", color: STATUS_COLORS.pending },
  running: { label: "Running", color: STATUS_COLORS.running },
  completed: { label: "Completed", color: STATUS_COLORS.completed },
  failed: { label: "Failed", color: STATUS_COLORS.failed },
  cancelled: { label: "Cancelled", color: STATUS_COLORS.cancelled },
};

function useWorkflowFilter() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();

  return useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all") {
        params.delete("workflow");
        params.delete("status");
      } else {
        params.set("workflow", value);
      }
      navigate(`${pathname}?${params.toString()}`);
    },
    [navigate, pathname, searchParams],
  );
}

function useStatusFilter() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();

  return useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all") {
        params.delete("status");
      } else {
        params.set("status", value);
      }
      navigate(`${pathname}?${params.toString()}`);
    },
    [navigate, pathname, searchParams],
  );
}

interface FilterControlsProps {
  workflowNameFilter: string | "all";
  status: WorkflowRunStatus | "all" | undefined;
  seenWorkflowNames: Set<string>;
  sortOrder: "asc" | "desc";
  loading: boolean;
  onWorkflowChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onSortToggle: () => void;
  onRefresh: () => void;
  lastRefreshTime: Date | null;
}

function FilterControls({
  workflowNameFilter,
  status,
  seenWorkflowNames,
  sortOrder,
  loading,
  onWorkflowChange,
  onStatusChange,
  onSortToggle,
  onRefresh,
  lastRefreshTime,
}: FilterControlsProps) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-end gap-2">
        <p className="text-sm text-muted-foreground">Last refreshed</p>
        {lastRefreshTime && (
          <RelativeTime
            date={lastRefreshTime}
            className="text-sm text-muted-foreground"
            type="distance"
          />
        )}
      </div>
      <div className="flex items-center gap-4">
        <Select
          value={workflowNameFilter ?? "all"}
          onValueChange={onWorkflowChange}
          disabled={loading}
        >
          <SelectTrigger className="w-[180px] h-9">
            <SelectValue placeholder="Filter by workflow" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Workflows</SelectItem>
            {Array.from(seenWorkflowNames)
              .sort()
              .map((name) => (
                <SelectItem key={name} value={name}>
                  {parseWorkflowName(name)?.shortName || name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <Select
                value={status || "all"}
                onValueChange={onStatusChange}
                disabled={loading}
              >
                <SelectTrigger className="w-[140px] h-9">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any status</SelectItem>
                  {Object.entries(statusMap).map(
                    ([status, { label, color }]) => (
                      <SelectItem key={status} value={status}>
                        <div className="flex items-center">
                          <span
                            className={`${color} size-1.5 rounded-full mr-2`}
                          />
                          {label}
                        </div>
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
          </TooltipTrigger>
          <TooltipContent>Filter runs by status</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="small"
              onClick={onSortToggle}
              disabled={loading}
            >
              {sortOrder === "desc" ? (
                <ArrowDownAZ className="h-4 w-4" />
              ) : (
                <ArrowUpAZ className="h-4 w-4" />
              )}
              {sortOrder === "desc" ? "Newest" : "Oldest"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {sortOrder === "desc"
              ? "Showing newest first"
              : "Showing oldest first"}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="small"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw className={loading ? "animate-spin" : ""} />
              Refresh
            </Button>
          </TooltipTrigger>
          <TooltipContent>Note that this resets pages</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

/** Workflow runs, loading further pages from the server as the list scrolls. */
export function RunsTable({ onRunClick }: RunsTableProps) {
  const [searchParams] = useSearchParams();
  const handleWorkflowFilter = useWorkflowFilter();
  const handleStatusFilter = useStatusFilter();

  const rawStatus = searchParams.get("status");
  const validStatuses = Object.keys(statusMap) as WorkflowRunStatus[];
  const status: WorkflowRunStatus | "all" | undefined =
    rawStatus === "all" ||
    (rawStatus && validStatuses.includes(rawStatus as WorkflowRunStatus))
      ? (rawStatus as WorkflowRunStatus | "all")
      : undefined;
  const workflowNameFilter = searchParams.get("workflow") as string | "all";
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(
    () => new Date(),
  );
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);

  // The world has no list of workflow names, so the filter offers the ones seen so far.
  const [seenWorkflowNames, setSeenWorkflowNames] = useState<Set<string>>(
    new Set(),
  );

  const {
    items: runs,
    error,
    isLoading,
    isLoadingMore,
    hasMore,
    loadMore,
    reload,
  } = useWorkflowRunsInfinite({
    sortOrder,
    workflowName: workflowNameFilter === "all" ? undefined : workflowNameFilter,
    status: status === "all" ? undefined : status,
  });

  // Scroll container doubles as the IntersectionObserver root so the
  // sentinel's rootMargin prefetch is measured against the table viewport.
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useLoadMoreOnScroll(loadMore, {
    hasMore,
    isLoadingMore,
    root: scrollRoot,
  });

  const selection = useTableSelection<WorkflowRun>({
    getItemId: (run) => run.runId,
  });

  const [isBulkCancelling, setIsBulkCancelling] = useState(false);
  const [isBulkReenqueuing, setIsBulkReenqueuing] = useState(false);

  useEffect(() => {
    if (runs.length > 0) {
      const newNames = new Set(runs.map((run) => run.workflowName));
      setSeenWorkflowNames((prev) => {
        const updated = new Set(prev);
        for (const name of newNames) {
          updated.add(name);
        }
        return updated;
      });
    }
  }, [runs]);

  const loading = isLoading;

  useEffect(() => {
    if (!loading && !hasLoadedOnce) {
      setHasLoadedOnce(true);
    }
  }, [loading, hasLoadedOnce]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Want to reset on any filter change
  useEffect(() => {
    setHasLoadedOnce(false);
  }, [workflowNameFilter, status, sortOrder]);

  const onReload = useCallback(() => {
    setLastRefreshTime(() => new Date());
    setHasLoadedOnce(false);
    reload();
  }, [reload]);

  const selectedRuns = useMemo(() => {
    return runs.filter((run) => selection.selectedIds.has(run.runId));
  }, [runs, selection.selectedIds]);

  const cancellableSelectedRuns = useMemo(() => {
    return selectedRuns.filter(
      (run) => run.status === "pending" || run.status === "running",
    );
  }, [selectedRuns]);

  const hasCancellableSelection = cancellableSelectedRuns.length > 0;
  // A single bulk request cancels at most BULK_CANCEL_MAX_RUN_IDS runs; above
  // that the action is disabled rather than silently truncated.
  const exceedsBulkCancelLimit =
    cancellableSelectedRuns.length > BULK_CANCEL_MAX_RUN_IDS;

  const handleBulkCancel = useCallback(async () => {
    if (
      isBulkCancelling ||
      cancellableSelectedRuns.length === 0 ||
      cancellableSelectedRuns.length > BULK_CANCEL_MAX_RUN_IDS
    ) {
      return;
    }

    setIsBulkCancelling(true);
    try {
      const { summary, results } = await unwrapOrThrow(
        rpc("bulkCancelRuns", {
          runIds: cancellableSelectedRuns.map((run) => run.runId),
        }),
      );

      // Summarize as a single toast, listing only the categories that occurred.
      const parts: string[] = [];
      if (summary.cancelled > 0) parts.push(`${summary.cancelled} cancelled`);
      if (summary.alreadyCancelled > 0)
        parts.push(`${summary.alreadyCancelled} already cancelled`);
      if (summary.notCancellable > 0)
        parts.push(`${summary.notCancellable} not cancellable`);
      if (summary.notFound > 0) parts.push(`${summary.notFound} not found`);
      if (summary.failed > 0) parts.push(`${summary.failed} failed`);
      const message = parts.join(", ") || "No runs cancelled";

      const severity = bulkCancelToastSeverity(summary);
      if (severity === "error") {
        toast.error(message);
      } else if (severity === "warning") {
        toast.warning(message);
      } else {
        toast.success(message);
      }

      // Deselect every run that reached a terminal outcome, but keep retryable
      // failures selected so the user can retry them without reselecting.
      for (const result of results) {
        if (!shouldRetainSelectionAfterBulkCancel(result)) {
          selection.deselectById(result.runId);
        }
      }
      onReload();
    } catch (err) {
      toast.error("Failed to cancel runs", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setIsBulkCancelling(false);
    }
  }, [cancellableSelectedRuns, isBulkCancelling, selection, onReload]);

  const handleBulkReenqueue = useCallback(async () => {
    if (isBulkReenqueuing || selectedRuns.length === 0) return;

    setIsBulkReenqueuing(true);
    try {
      const results = await Promise.allSettled(
        selectedRuns.map((run) =>
          unwrapOrThrow(rpc("reenqueueRun", { runId: run.runId })),
        ),
      );

      const succeeded = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.filter((r) => r.status === "rejected").length;

      if (failed === 0) {
        toast.success(
          `Re-enqueued ${succeeded} run${succeeded !== 1 ? "s" : ""}`,
        );
      } else if (succeeded === 0) {
        toast.error(
          `Failed to re-enqueue ${failed} run${failed !== 1 ? "s" : ""}`,
        );
      } else {
        toast.warning(
          `Re-enqueued ${succeeded} run${succeeded !== 1 ? "s" : ""}, ${failed} failed`,
        );
      }

      selection.clearSelection();
      onReload();
    } catch (err) {
      toast.error("Failed to re-enqueue runs", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setIsBulkReenqueuing(false);
    }
  }, [selectedRuns, isBulkReenqueuing, selection, onReload]);

  const toggleSortOrder = () => {
    setSortOrder((prev) => (prev === "desc" ? "asc" : "desc"));
  };

  // Refresh when tab regains focus after a delay, to prevent stale UI.
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && lastRefreshTime) {
        const timeSinceLastRefresh = Date.now() - lastRefreshTime.getTime();
        if (timeSinceLastRefresh >= 10000) {
          onReload();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [lastRefreshTime, onReload]);

  return (
    <div>
      <FilterControls
        workflowNameFilter={workflowNameFilter}
        status={status}
        seenWorkflowNames={seenWorkflowNames}
        sortOrder={sortOrder}
        loading={loading}
        onWorkflowChange={handleWorkflowFilter}
        onStatusChange={handleStatusFilter}
        onSortToggle={toggleSortOrder}
        onRefresh={onReload}
        lastRefreshTime={lastRefreshTime}
      />

      <Card className="overflow-hidden mt-4 bg-background">
        <CardContent
          ref={setScrollRoot}
          className="p-0 max-h-[calc(100vh-280px)] overflow-auto"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10 w-10">
                  <Checkbox
                    checked={selection.isAllSelected(runs)}
                    indeterminate={selection.isSomeSelected(runs)}
                    onCheckedChange={() => selection.toggleSelectAll(runs)}
                    aria-label="Select all runs"
                    disabled={!runs.length}
                  />
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                  Workflow
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                  Run ID
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                  Status
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                  Started
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                  Completed
                </TableHead>
                <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10 w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {error ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-[400px]">
                    <div className="flex items-center justify-center h-full">
                      <Alert variant="destructive" className="max-w-md">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>Error loading runs</AlertTitle>
                        <AlertDescription>
                          {getErrorMessage(error)}
                        </AlertDescription>
                      </Alert>
                    </div>
                  </TableCell>
                </TableRow>
              ) : loading && !hasLoadedOnce ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-[400px]">
                    <div className="flex items-center justify-center h-full">
                      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    </div>
                  </TableCell>
                </TableRow>
              ) : runs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="h-[400px]">
                    <div className="text-sm text-center text-muted-foreground flex flex-col items-center justify-center gap-3 h-full">
                      <span className="text-sm">No workflow runs found.</span>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                runs.map((run) => (
                  <TableRow
                    key={run.runId}
                    className="cursor-pointer group relative"
                    onClick={() => onRunClick(run.runId)}
                    data-selected={selection.isSelected(run)}
                  >
                    <TableCell className="py-2">
                      <Checkbox
                        checked={selection.isSelected(run)}
                        onCheckedChange={() => selection.toggleSelection(run)}
                        aria-label={`Select run ${run.runId}`}
                      />
                    </TableCell>
                    <TableCell className="py-2">
                      <CopyableText text={run.workflowName} overlay>
                        {parseWorkflowName(run.workflowName)?.shortName || "?"}
                      </CopyableText>
                    </TableCell>
                    <TableCell className="font-mono text-xs py-2">
                      <CopyableText text={run.runId} overlay>
                        {run.runId}
                      </CopyableText>
                    </TableCell>
                    <TableCell className="py-2">
                      <StatusBadge
                        status={run.status}
                        context={run}
                        durationMs={
                          run.startedAt
                            ? (run.completedAt
                                ? new Date(run.completedAt).getTime()
                                : Date.now()) -
                              new Date(run.startedAt).getTime()
                            : undefined
                        }
                      />
                    </TableCell>
                    <TableCell className="py-2 text-muted-foreground text-xs">
                      {run.startedAt ? (
                        <RelativeTime date={run.startedAt} />
                      ) : (
                        "-"
                      )}
                    </TableCell>
                    <TableCell className="py-2 text-muted-foreground text-xs">
                      {run.completedAt ? (
                        <RelativeTime date={run.completedAt} />
                      ) : (
                        "-"
                      )}
                    </TableCell>
                    <TableCell className="py-2">
                      <LazyDropdownMenu
                        runId={run.runId}
                        runStatus={run.status}
                        onSuccess={onReload}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
              {isLoadingMore && (
                <TableRow>
                  <TableCell colSpan={7} className="py-3">
                    <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading more runs…
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {/* Infinite-scroll sentinel: observed against the scroll container
              so the next page is fetched before the user reaches the end. */}
          <div ref={sentinelRef} aria-hidden className="h-px" />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
        <div>
          {runs.length > 0 && (
            <>
              Showing {runs.length} run{runs.length === 1 ? "" : "s"}
              {!hasMore && !loading ? " · end of list" : ""}
            </>
          )}
        </div>
      </div>

      <SelectionBar
        selectionCount={selection.selectionCount}
        onClearSelection={selection.clearSelection}
        itemLabel="runs"
        actions={
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="tertiary"
                  size="small"
                  className="h-7 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
                  onClick={handleBulkReenqueue}
                  disabled={isBulkReenqueuing || selectedRuns.length === 0}
                >
                  {isBulkReenqueuing ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Zap className="h-4 w-4 mr-1" />
                  )}
                  {isBulkReenqueuing ? "Re-enqueuing..." : "Re-enqueue"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Re-enqueue the workflow orchestration layer for selected runs.
                Useful if workflows appear stuck.
              </TooltipContent>
            </Tooltip>
            {hasCancellableSelection && (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* span wrapper keeps the tooltip reachable while the
                      button is disabled */}
                  <span className="inline-flex">
                    <Button
                      variant="tertiary"
                      size="small"
                      className="h-7 text-primary-foreground hover:bg-primary-foreground/10 hover:text-primary-foreground"
                      onClick={handleBulkCancel}
                      disabled={isBulkCancelling || exceedsBulkCancelLimit}
                    >
                      {isBulkCancelling ? (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      ) : (
                        <XCircle className="h-4 w-4 mr-1" />
                      )}
                      Cancel{" "}
                      {cancellableSelectedRuns.length !==
                      selection.selectionCount
                        ? `${cancellableSelectedRuns.length} `
                        : ""}
                      {isBulkCancelling ? "cancelling..." : ""}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  {exceedsBulkCancelLimit
                    ? `Select up to ${BULK_CANCEL_MAX_RUN_IDS} runs at a time.`
                    : "Cancel the selected pending and running runs."}
                </TooltipContent>
              </Tooltip>
            )}
          </>
        }
      />
    </div>
  );
}
