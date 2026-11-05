import { parseWorkflowName } from "@workflow/utils/parse-name";
import type { FetchSpanDetail } from "@workflow/web-shared";
import {
  DecryptButton,
  ErrorBoundary,
  EventListView,
  hydrateResourceIOAsync,
  type SidebarDataContextValue,
  StreamViewer,
  StreamViewerSkeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TraceViewer,
} from "@workflow/web-shared";
import type { Event, WorkflowRun } from "@workflow/world";
import { AlertCircle, HelpCircle, List, Lock } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "~/components/ui/breadcrumb";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useCancellationReason } from "~/lib/client/hooks/use-cancellation-reason";
import { useEventsListData } from "~/lib/client/hooks/use-events-list-data";
import { useStreamReader } from "~/lib/hooks/use-stream-reader";

import { CopyableText } from "./display-utils/copyable-text";
import { LiveStatus } from "./display-utils/live-status";
import { RelativeTime } from "./display-utils/relative-time";
import { StatusBadge } from "./display-utils/status-badge";
import { RunActionsButtons } from "./run-actions";
import { Skeleton } from "./ui/skeleton";
import { fetchSpanDetailResource } from "~/lib/client/hooks/use-resource-data";
import { useWorkflowTraceViewerData } from "~/lib/client/hooks/use-trace-viewer";
import { useWorkflowStreams } from "~/lib/client/hooks/use-workflow-streams";
import {
  getErrorMessage,
  unwrapOrThrow,
  unwrapServerActionResult,
} from "~/lib/client/workflow-errors";
import { rpc } from "~/lib/rpc-client";

interface RunDetailViewProps {
  runId: string;
  selectedId?: string;
}

const TABS = ["trace", "events", "streams"] as const;
type Tab = (typeof TABS)[number];

export function RunDetailView({
  runId,
  selectedId: _selectedId,
}: RunDetailViewProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [cancelling, setCancelling] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showRerunDialog, setShowRerunDialog] = useState(false);

  // An unknown `?tab=` shows the trace, not an empty body.
  const activeTab: Tab =
    TABS.find((tab) => tab === searchParams.get("tab")) ?? "trace";
  const selectedStreamId = searchParams.get("streamId");

  const updateSearchParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      navigate(`?${params.toString()}`, { preventScrollReset: true });
    },
    [navigate, searchParams],
  );

  const setActiveTab = useCallback(
    (tab: Tab) => {
      // When switching away from streams tab, clear streamId so
      // useStreamReader stops fetching/polling in the background.
      if (tab !== "streams") {
        updateSearchParams({ tab, streamId: null });
      } else {
        updateSearchParams({ tab });
      }
    },
    [updateSearchParams],
  );

  const setSelectedStreamId = useCallback(
    (streamId: string | null) => {
      updateSearchParams({ streamId });
    },
    [updateSearchParams],
  );

  const handleStreamClick = useCallback(
    (streamId: string) => {
      updateSearchParams({ tab: "streams", streamId });
    },
    [updateSearchParams],
  );

  const handleRunRefClick = useCallback(
    (targetRunId: string) => {
      // Navigate to the target run with a clean URL (no search params)
      // so the sidebar panel resets
      navigate(`/run/${encodeURIComponent(targetRunId)}`);
    },
    [navigate],
  );

  const handleWakeUpSleep = useCallback(
    async (runId: string, correlationId: string) => {
      return unwrapOrThrow(
        rpc("wakeUpRun", { runId, correlationIds: [correlationId] }),
      );
    },
    [],
  );

  // Ref for encryption key so event loading callbacks can access it
  // without being recreated when the key changes
  const encryptionKeyRef = useRef<Uint8Array | null>(null);

  const handleResolveHook = useCallback(
    async (hookToken: string, payload: unknown) => {
      await unwrapOrThrow(rpc("resumeHook", { token: hookToken, payload }));
    },
    [],
  );

  const handleLoadEventData = useCallback(async (event: Event) => {
    const { error, result } = await unwrapServerActionResult(
      rpc("fetchEvent", {
        runId: event.runId,
        eventId: event.eventId,
        resolveData: "all",
      }),
    );
    if (error) {
      throw error;
    }
    const fullEvent = await hydrateResourceIOAsync(
      result,
      encryptionKeyRef.current ?? undefined,
    );
    if ("eventData" in fullEvent) {
      return fullEvent.eventData;
    }
    return null;
  }, []);

  const {
    run: runData,
    events: allEvents,
    loading,
    error,
    update,
    hasEncryptedData,
    loadMoreTraceData,
    hasMoreTraceData,
    isLoadingMoreTraceData,
  } = useWorkflowTraceViewerData(runId, { live: true });

  const run = runData ?? ({} as WorkflowRun);
  const cancelReason = useCancellationReason(runId, run.status, allEvents);

  // Encryption key persisted for the lifetime of this run page.
  // Once fetched (via Decrypt button), it's used automatically for all
  // subsequent resource + event hydration, even across span selection changes.
  const [encryptionKey, setEncryptionKey] = useState<Uint8Array | null>(null);
  encryptionKeyRef.current = encryptionKey;

  const [eventsSortOrder, setEventsSortOrder] = useState<"asc" | "desc">("asc");
  const {
    events: eventsListData,
    loading: eventsListLoading,
    hasMore: hasMoreEventsTab,
    loadingMore: loadingMoreEventsTab,
    loadMore: loadMoreEventsTab,
    searchByExactId,
  } = useEventsListData(runId, {
    sortOrder: eventsSortOrder,
    encryptionKey: encryptionKey ?? undefined,
    enabled: activeTab === "events",
  });

  const fetchSpanDetail = useCallback<FetchSpanDetail>(
    (selection) =>
      fetchSpanDetailResource(selection, {
        encryptionKey: encryptionKey ?? undefined,
      }),
    [encryptionKey],
  );

  const [isDecrypting, setIsDecrypting] = useState(false);

  const handleDecrypt = useCallback(async () => {
    if (encryptionKey) {
      return;
    }
    setIsDecrypting(true);
    try {
      const { error: keyError, result: keyResult } =
        await unwrapServerActionResult(
          rpc("getEncryptionKeyForRun", { runId }),
        );
      if (keyError) {
        toast.error(`Failed to fetch encryption key: ${keyError.message}`);
        return;
      }
      if (!keyResult) {
        toast.error("Encryption is not configured for this deployment.");
        return;
      }
      setEncryptionKey(keyResult);
    } finally {
      setIsDecrypting(false);
    }
  }, [encryptionKey, runId]);

  const sidebarData = useMemo<SidebarDataContextValue>(
    () => ({
      run,
      events: allEvents ?? [],
      fetchSpanDetail,
      onStreamClick: handleStreamClick,
      onRunClick: handleRunRefClick,
      onWakeUpSleep: handleWakeUpSleep,
      onLoadEventData: handleLoadEventData,
      onResolveHook: handleResolveHook,
      encryptionKey: encryptionKey ?? undefined,
      onDecrypt: handleDecrypt,
      isDecrypting,
      hasEncryptedData,
    }),
    [
      run,
      allEvents,
      fetchSpanDetail,
      handleStreamClick,
      handleRunRefClick,
      handleWakeUpSleep,
      handleLoadEventData,
      handleResolveHook,
      encryptionKey,
      handleDecrypt,
      isDecrypting,
      hasEncryptedData,
    ],
  );

  const {
    streams,
    loading: streamsLoading,
    error: streamsError,
  } = useWorkflowStreams(runId);

  const {
    chunks: streamChunks,
    isLive: streamIsLive,
    isInitialLoading: streamIsInitialLoading,
    error: streamError,
  } = useStreamReader(selectedStreamId, runId, encryptionKey, run.status);

  const handleCancelClick = () => {
    setShowCancelDialog(true);
  };

  const handleConfirmCancel = async () => {
    if (cancelling) return;

    try {
      setCancelling(true);
      setShowCancelDialog(false);
      await unwrapOrThrow(rpc("cancelRun", { runId }));
      await update();
      toast.success("Run cancelled");
    } catch (err) {
      console.error("Failed to cancel run:", err);
      toast.error("Failed to cancel run", {
        description:
          err instanceof Error ? err.message : "An unknown error occurred",
      });
    } finally {
      setCancelling(false);
    }
  };

  const isDynamicRun = Boolean(run.executionContext?.dynamicWorkflow);

  const handleRerunClick = () => {
    if (isDynamicRun) return;
    setShowRerunDialog(true);
  };

  const handleConfirmRerun = async () => {
    if (rerunning || isDynamicRun) return;

    try {
      setRerunning(true);
      setShowRerunDialog(false);
      const newRunId = await unwrapOrThrow(
        rpc("recreateRun", { runId: run.runId }),
      );
      toast.success("New run started", {
        description: `Run ID: ${newRunId}`,
      });
      navigate(`/run/${newRunId}`);
    } catch (err) {
      console.error("Failed to re-run workflow:", err);
      toast.error("Failed to start new run", {
        description:
          err instanceof Error ? err.message : "An unknown error occurred",
      });
    } finally {
      setRerunning(false);
      setShowRerunDialog(false);
    }
  };

  if (error && !runData) {
    return (
      <Alert variant="destructive" className="m-4">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Error loading workflow run</AlertTitle>
        <AlertDescription>{getErrorMessage(error)}</AlertDescription>
      </Alert>
    );
  }

  const workflowName = parseWorkflowName(run.workflowName)?.shortName;

  return (
    <>
      <AlertDialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel Workflow Run?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop the workflow execution immediately, and no further
              steps will be executed. Partial workflow execution may occur. Are
              you sure you want to cancel the run?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Running</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmCancel}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Cancel Run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showRerunDialog} onOpenChange={setShowRerunDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replay Run?</AlertDialogTitle>
            <AlertDialogDescription>
              This can potentially re-run code that is meant to only execute
              once. Are you sure you want to replay the workflow run?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRerun}>
              Replay Run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex flex-col h-[calc(100vh-97px)]">
        <div className="flex-none space-y-4">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link to="/">Runs</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="font-mono text-xs">
                  {runId}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          <div className="space-y-4 p-6 border rounded-lg">
            <div className="flex items-start justify-between">
              <div className="mb-4">
                <h1 className="text-xl font-semibold">
                  {workflowName ? (
                    workflowName
                  ) : (
                    <Skeleton className="w-[260px] h-[28px]" />
                  )}
                </h1>
              </div>

              <div className="flex items-center justify-between gap-2">
                <LiveStatus
                  hasError={error !== null}
                  errorMessage={error ? getErrorMessage(error) : ""}
                />
                <RunActionsButtons
                  runId={runId}
                  runStatus={run.status}
                  events={allEvents}
                  eventsLoading={loading}
                  loading={loading}
                  replayDisabledReason={
                    isDynamicRun
                      ? "Dynamic runs cannot be replayed as a new run."
                      : undefined
                  }
                  onRerunClick={handleRerunClick}
                  onCancelClick={handleCancelClick}
                  callbacks={{ onSuccess: update }}
                />
              </div>
            </div>

            <div className="flex items-start gap-8">
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Status</div>
                {run.status ? (
                  <StatusBadge
                    status={run.status}
                    context={{ error: run.error, cancelReason }}
                  />
                ) : (
                  <Skeleton className="w-[55px] h-[24px]" />
                )}
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Duration</div>
                <div className="text-xs">
                  {run.runId ? (
                    run.startedAt ? (
                      (() => {
                        const ms =
                          (run.completedAt
                            ? new Date(run.completedAt).getTime()
                            : Date.now()) - new Date(run.startedAt).getTime();
                        const seconds = Math.floor(ms / 1000);
                        if (seconds < 60) return `${seconds}s`;
                        const minutes = Math.floor(seconds / 60);
                        const remainingSeconds = seconds % 60;
                        if (minutes < 60) {
                          return remainingSeconds > 0
                            ? `${minutes}m ${remainingSeconds}s`
                            : `${minutes}m`;
                        }
                        const hours = Math.floor(minutes / 60);
                        const remainingMinutes = minutes % 60;
                        return remainingMinutes > 0
                          ? `${hours}h ${remainingMinutes}m`
                          : `${hours}h`;
                      })()
                    ) : (
                      "-"
                    )
                  ) : (
                    <Skeleton className="w-[60px] h-[20px]" />
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Run ID</div>
                {run.runId ? (
                  <CopyableText text={run.runId}>
                    <div className="text-xs mt-0.5 font-mono">{run.runId}</div>
                  </CopyableText>
                ) : (
                  <Skeleton className="w-[280px] h-[20px]" />
                )}
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Queued</div>
                {run.createdAt ? (
                  <div className="text-xs">
                    <RelativeTime date={run.createdAt} />
                  </div>
                ) : (
                  <Skeleton className="w-[110px] h-[20px]" />
                )}
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Started</div>
                <div className="text-xs">
                  {run.runId ? (
                    run.startedAt ? (
                      <RelativeTime date={run.startedAt} />
                    ) : (
                      "-"
                    )
                  ) : (
                    <Skeleton className="w-[110px] h-[20px]" />
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <div className="text-xs text-muted-foreground">Completed</div>
                <div className="text-xs">
                  {run.runId ? (
                    run.completedAt ? (
                      <RelativeTime date={run.completedAt} />
                    ) : (
                      "-"
                    )
                  ) : (
                    <Skeleton className="w-[110px] h-[20px]" />
                  )}
                </div>
              </div>
              {run.expiredAt != null && (
                <div className="flex flex-col gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="text-xs text-muted-foreground cursor-help flex items-center gap-1">
                        Expired
                        <HelpCircle className="w-3 h-3" />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        The storage data for this run has expired and is no
                        longer available.
                      </p>
                    </TooltipContent>
                  </Tooltip>
                  <div className="text-xs">
                    <RelativeTime date={run.expiredAt} />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-4 flex-1 flex flex-col min-h-0">
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as Tab)}
            className="flex-1 flex flex-col min-h-0"
          >
            <TabsList className="mb-4 flex-none">
              <TabsTrigger value="trace" className="gap-2">
                <List className="h-4 w-4" />
                Trace
              </TabsTrigger>
              <TabsTrigger value="events" className="gap-2">
                <List className="h-4 w-4" />
                Events
              </TabsTrigger>
              <TabsTrigger value="streams" className="gap-2">
                <List className="h-4 w-4" />
                Streams
              </TabsTrigger>
            </TabsList>

            <TabsContent value="trace" className="mt-0 flex-1 min-h-0">
              <ErrorBoundary title="Failed to load trace viewer">
                <div className="relative h-full -mx-6 bg-background-100 border-t border-gray-alpha-400 overflow-hidden">
                  <TraceViewer
                    run={run}
                    events={allEvents ?? []}
                    loading={loading}
                    sidebarData={sidebarData}
                    onLoadMore={loadMoreTraceData}
                    hasMore={hasMoreTraceData}
                    isLoadingMore={isLoadingMoreTraceData}
                  />
                </div>
              </ErrorBoundary>
            </TabsContent>

            <TabsContent value="events" className="mt-0 flex-1 min-h-0">
              <ErrorBoundary title="Failed to load events list">
                <div className="h-full">
                  <EventListView
                    events={eventsListData}
                    run={run}
                    onLoadEventData={handleLoadEventData}
                    hasMoreEvents={hasMoreEventsTab}
                    isLoadingMoreEvents={loadingMoreEventsTab}
                    onLoadMoreEvents={loadMoreEventsTab}
                    encryptionKey={encryptionKey ?? undefined}
                    isLoading={eventsListLoading}
                    sortOrder={eventsSortOrder}
                    onSortOrderChange={setEventsSortOrder}
                    onDecrypt={handleDecrypt}
                    isDecrypting={isDecrypting}
                    hasEncryptedData={hasEncryptedData}
                    onExactIdSearch={searchByExactId}
                  />
                </div>
              </ErrorBoundary>
            </TabsContent>

            <TabsContent value="streams" className="mt-0 flex-1 min-h-0">
              <ErrorBoundary title="Failed to load stream data">
                <div className="relative -mx-6 flex h-full min-h-0 overflow-hidden border-t border-gray-alpha-400 bg-background-100">
                  <div className="flex w-[340px] shrink-0 flex-col border-r border-gray-alpha-400 bg-background-100">
                    <div
                      aria-hidden="true"
                      className="h-10 min-h-10 border-b border-gray-alpha-400"
                    />
                    <div className="min-h-0 flex-1 divide-y divide-gray-400 overflow-y-auto">
                      {streamsLoading ? (
                        <div className="flex flex-col divide-y divide-gray-400">
                          <div className="flex h-10 items-center pl-4 pr-2">
                            <Skeleton className="h-3.5 w-24" />
                          </div>
                          <div className="flex h-10 items-center pl-4 pr-2">
                            <Skeleton className="h-3.5 w-32" />
                          </div>
                          <div className="flex h-10 items-center pl-4 pr-2">
                            <Skeleton className="h-3.5 w-20" />
                          </div>
                        </div>
                      ) : streamsError ? (
                        <div className="px-4 py-2 text-label-12 text-red-900">
                          {streamsError.message}
                        </div>
                      ) : streams.length === 0 ? (
                        <div className="flex h-10 items-center px-4 text-label-12 text-gray-900">
                          No streams found for this run
                        </div>
                      ) : (
                        streams.map((streamId) => (
                          <button
                            key={streamId}
                            type="button"
                            onClick={() => setSelectedStreamId(streamId)}
                            className={`flex h-10 w-full min-w-0 items-center truncate pl-4 pr-2 text-left text-label-14 transition-colors ${
                              selectedStreamId === streamId
                                ? "bg-gray-100 text-gray-1000 hover:bg-gray-200 active:bg-gray-200"
                                : "bg-transparent text-gray-900 hover:bg-gray-100 hover:text-gray-1000 focus-visible:bg-gray-100 focus-visible:text-gray-1000"
                            }`}
                            title={streamId}
                          >
                            {streamId}
                          </button>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background-100">
                    {streamsLoading ? (
                      <div className="min-h-0 flex-1">
                        <StreamViewerSkeleton />
                      </div>
                    ) : selectedStreamId ? (
                      streamError?.includes("encrypted") && !encryptionKey ? (
                        <div className="flex h-full items-center justify-center p-4">
                          <div className="flex flex-col items-center gap-3 text-center">
                            <Lock className="h-8 w-8 text-gray-700" />
                            <div className="space-y-1">
                              <div className="text-label-14 font-medium text-gray-1000">
                                Encrypted Stream
                              </div>
                              <div className="text-label-12 text-gray-900">
                                Decrypt this stream to view its chunks.
                              </div>
                            </div>
                            <DecryptButton
                              onClick={handleDecrypt}
                              loading={isDecrypting}
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="min-h-0 flex-1">
                          <StreamViewer
                            streamId={selectedStreamId}
                            chunks={streamChunks}
                            isLive={streamIsLive}
                            isLoading={streamIsInitialLoading}
                            error={
                              streamError?.includes("encrypted")
                                ? null
                                : streamError
                            }
                          />
                        </div>
                      )
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <div className="text-label-14 text-gray-600">
                          {streams.length > 0
                            ? "Select a stream to view its data"
                            : "No streams available"}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </ErrorBoundary>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  );
}
