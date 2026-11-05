import {
  Button,
  HookResolveModalWrapper,
  ResolveHookDropdownItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useHookActions,
} from "@workflow/web-shared";
import type { Hook } from "@workflow/world";
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Card, CardContent } from "~/components/ui/card";
import { DocsLink } from "~/components/ui/docs-link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import type { HookListItem } from "~/lib/types";
import { CopyableText } from "./display-utils/copyable-text";
import { HookTokenCell } from "./display-utils/hook-token-cell";
import { RelativeTime } from "./display-utils/relative-time";
import { TableSkeleton } from "./display-utils/table-skeleton";
import { useWorkflowHooks } from "~/lib/client/hooks/use-paginated-list";
import { getErrorMessage, unwrapOrThrow } from "~/lib/client/workflow-errors";
import { rpc } from "~/lib/rpc-client";

const INVOCATION_EVENTS_LIMIT = 100;

interface HooksTableProps {
  onHookClick: (hookId: string, runId?: string) => void;
  selectedHookId?: string;
}

interface InvocationData {
  count: number | Error;
  hasMore: boolean;
  loading: boolean;
}

/**
 * HooksTable - Displays hooks with server-side pagination.
 * Uses the PaginatingTable pattern similar to RunsTable.
 * Fetches invocation counts in the background for each hook.
 *
 */
export function HooksTable({ onHookClick, selectedHookId }: HooksTableProps) {
  const [lastRefreshTime, setLastRefreshTime] = useState<Date | null>(
    () => new Date(),
  );

  const {
    data,
    error,
    nextPage,
    previousPage,
    hasNextPage,
    hasPreviousPage,
    refresh,
    pageInfo,
  } = useWorkflowHooks({ sortOrder: "desc" });

  // Hook actions for resolve functionality
  const hookActions = useHookActions({
    onResolve: async (hook, payload) => {
      // List rows are metadata-only; fetch the secret token on demand just
      // before resuming, keyed by the hook's run/hook id.
      const { token } = await unwrapOrThrow(
        rpc("fetchHookToken", { runId: hook.runId, hookId: hook.hookId }),
      );
      await unwrapOrThrow(rpc("resumeHook", { token, payload }));
    },
    callbacks: {
      onSuccess: refresh,
    },
  });

  const loading = data.isLoading;
  const hooks = data.data ?? [];

  // Refresh current page without resetting state (prevents layout shift)
  const onRefresh = () => {
    setLastRefreshTime(() => new Date());
    refresh();
  };

  // Track invocation counts per hook (fetched in background)
  const [invocationData, setInvocationData] = useState<
    Map<string, InvocationData>
  >(new Map());

  // Count each hook's invocations from its own run's events, at most
  // INVOCATION_EVENTS_LIMIT of them.
  useEffect(() => {
    if (!hooks.length) return;
    let ignore = false;
    setInvocationData(
      new Map(
        hooks.map((hook) => [
          hook.hookId,
          { count: 0, hasMore: false, loading: true },
        ]),
      ),
    );
    const settle = (hookId: string, data: InvocationData) => {
      if (ignore) return;
      setInvocationData((prev) => new Map(prev).set(hookId, data));
    };
    for (const hook of hooks) {
      unwrapOrThrow(
        rpc("fetchEventsByCorrelationId", {
          correlationId: hook.hookId,
          runId: hook.runId,
          limit: INVOCATION_EVENTS_LIMIT,
        }),
      ).then(
        ({ data: events, hasMore }) =>
          settle(hook.hookId, {
            count: events.filter((event) => event.eventType === "hook_received")
              .length,
            hasMore,
            loading: false,
          }),
        (error: Error) =>
          settle(hook.hookId, { count: error, hasMore: false, loading: false }),
      );
    }
    return () => {
      ignore = true;
    };
  }, [hooks]);

  // Render invocation count for a hook
  const renderInvocationCount = (hook: HookListItem) => {
    const data = invocationData.get(hook.hookId);

    if (!data || data.loading) {
      return <span className="text-muted-foreground text-xs">...</span>;
    }

    if (data.count instanceof Error) {
      return <span className="text-muted-foreground">Error</span>;
    }

    if (data.count === 0) {
      return <span className="text-muted-foreground">0</span>;
    }

    const displayText = data.hasMore ? `${data.count}+` : `${data.count}`;

    if (data.hasMore) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-semibold cursor-help">{displayText}</span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="text-xs">
              Counted from the first {INVOCATION_EVENTS_LIMIT} events. There may
              be more.
            </div>
          </TooltipContent>
        </Tooltip>
      );
    }

    return <span className="font-semibold">{displayText}</span>;
  };

  return (
    <div>
      {/* Modal for resolving hooks - rendered at top level */}
      <HookResolveModalWrapper hookActions={hookActions} />

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
      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error loading hooks</AlertTitle>
          <AlertDescription>{getErrorMessage(error)}</AlertDescription>
        </Alert>
      ) : !loading && (!hooks || hooks.length === 0) ? (
        <div className="text-center py-8 text-muted-foreground">
          No active hooks found. <br />
          <DocsLink href="https://workflow-sdk.dev/docs/api-reference/workflow/create-hook">
            Learn how to create a hook
          </DocsLink>
        </div>
      ) : loading && !data?.data ? (
        <TableSkeleton />
      ) : (
        <>
          <Card className="overflow-hidden mt-4 bg-background">
            <CardContent className="p-0 max-h-[calc(100vh-280px)] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Hook ID
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Run ID
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Token
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Created
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10">
                      Invocations
                    </TableHead>
                    <TableHead className="sticky top-0 bg-background z-10 border-b shadow-sm h-10 w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {hooks.map((hook) => (
                    <TableRow
                      key={hook.hookId}
                      className="cursor-pointer group relative"
                      onClick={() => onHookClick(hook.hookId, hook.runId)}
                      data-selected={hook.hookId === selectedHookId}
                    >
                      <TableCell className="font-mono text-xs py-2">
                        <CopyableText text={hook.hookId} overlay>
                          {hook.hookId}
                        </CopyableText>
                      </TableCell>
                      <TableCell className="font-mono text-xs py-2">
                        <CopyableText text={hook.runId} overlay>
                          {hook.runId}
                        </CopyableText>
                      </TableCell>
                      <TableCell className="font-mono text-xs py-2">
                        <HookTokenCell
                          runId={hook.runId}
                          hookId={hook.hookId}
                        />
                      </TableCell>
                      <TableCell className="py-2 text-muted-foreground text-xs">
                        {hook.createdAt ? (
                          <RelativeTime date={hook.createdAt} />
                        ) : (
                          "-"
                        )}
                      </TableCell>
                      <TableCell className="py-2">
                        {renderInvocationCount(hook)}
                      </TableCell>
                      <TableCell className="py-2">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="tertiary"
                              size="small"
                              shape="square"
                              aria-label="Hook actions"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <ResolveHookDropdownItem
                              // List rows omit the secret token; the resolve
                              // flow fetches it on demand. The shared component
                              // only forwards the hook back to onResolve, which
                              // reads its run/hook id, so this cast is safe.
                              hook={hook as Hook}
                              stopPropagation
                              onResolveClick={hookActions.openResolveModal}
                              DropdownMenuItem={DropdownMenuItem}
                            />
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <div className="flex items-center justify-between mt-4">
            <div className="text-sm text-muted-foreground">{pageInfo}</div>
            <div className="flex gap-2 items-center">
              <Button
                variant="secondary"
                size="small"
                onClick={previousPage}
                disabled={!hasPreviousPage}
              >
                <ChevronLeft />
                Previous
              </Button>
              <Button
                variant="secondary"
                size="small"
                onClick={nextPage}
                disabled={!hasNextPage}
              >
                Next
                <ChevronRight />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
