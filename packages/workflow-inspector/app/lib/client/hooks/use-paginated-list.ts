import { useCallback, useEffect, useRef, useState } from "react";
import {
  unwrapOrThrow,
  WorkflowWebAPIError,
} from "~/lib/client/workflow-errors";
import type { HookListItem, PaginatedResult } from "~/lib/types";
import { getPaginationDisplay } from "~/lib/utils";
import { rpc } from "~/lib/rpc-client";

export interface PageResult<T> {
  data: T[] | null;
  isLoading: boolean;
  error: Error | null;
}

export interface PaginatedList<T> {
  data: PageResult<T>;
  allData: PageResult<T>[];
  error: Error | null;
  isLoading: boolean;
  currentPage: number;
  totalPages: number;
  nextPage: () => void;
  previousPage: () => void;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  reload: () => void;
  refresh: () => void;
  pageInfo: string;
}

/**
 * Generic hook for cursor-based paginated lists with caching and navigation.
 * Callers should memoize `fetchFn` with useCallback to control when data is refetched.
 */
export function usePaginatedList<T>(
  fetchFn: (cursor?: string) => Promise<PaginatedResult<T>>,
): PaginatedList<T> {
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [pageHistory, setPageHistory] = useState<(string | undefined)[]>([
    undefined,
  ]);
  const [maxPagesVisited, setMaxPagesVisited] = useState(1);

  // Initial isLoading is false so SSR and client hydration agree; after mount,
  // the useEffect that triggers the first fetch will set it to true on the client.
  const [allPageResults, setAllPageResults] = useState<
    Map<number, PageResult<T>>
  >(new Map([[0, { data: null, isLoading: false, error: null }]]));

  const pageCache = useRef<
    Map<
      string,
      {
        data: T[];
        cursor?: string;
        hasMore: boolean;
      }
    >
  >(new Map());

  const fetchPage = useCallback(
    async (pageIndex: number, pageCursor?: string, force: boolean = false) => {
      const cacheKey = pageCursor ?? "initial";

      setAllPageResults((prev) => {
        const newMap = new Map(prev);
        newMap.set(pageIndex, {
          data: prev.get(pageIndex)?.data ?? null,
          isLoading: true,
          error: null,
        });
        return newMap;
      });

      if (!force && pageCache.current.has(cacheKey)) {
        const cached = pageCache.current.get(cacheKey);
        if (cached) {
          setAllPageResults((prev) => {
            const newMap = new Map(prev);
            newMap.set(pageIndex, {
              data: cached.data,
              isLoading: false,
              error: null,
            });
            return newMap;
          });
          setCursor(cached.cursor);
          setHasMore(cached.hasMore);
          return;
        }
      }

      try {
        const result = await fetchFn(pageCursor);

        pageCache.current.set(cacheKey, {
          data: result.data,
          cursor: result.cursor,
          hasMore: result.hasMore,
        });

        setAllPageResults((prev) => {
          const newMap = new Map(prev);
          newMap.set(pageIndex, {
            data: result.data,
            isLoading: false,
            error: null,
          });
          return newMap;
        });
        setCursor(result.cursor);
        setHasMore(result.hasMore);
      } catch (err) {
        const error =
          err instanceof Error
            ? err
            : new WorkflowWebAPIError(String(err), { layer: "client" });
        setAllPageResults((prev) => {
          const newMap = new Map(prev);
          newMap.set(pageIndex, {
            data: prev.get(pageIndex)?.data ?? null,
            isLoading: false,
            error,
          });
          return newMap;
        });
      }
    },
    [fetchFn],
  );

  useEffect(() => {
    fetchPage(0, undefined, true);
  }, [fetchPage]);

  const nextPage = useCallback(() => {
    if (hasMore && cursor) {
      const newPage = currentPage + 1;

      setPageHistory((prev) => [...prev, cursor]);
      setCurrentPage(newPage);
      setMaxPagesVisited((prev) => Math.max(prev, newPage + 1));

      if (!allPageResults.has(newPage)) {
        setAllPageResults((prev) => {
          const newMap = new Map(prev);
          newMap.set(newPage, { data: null, isLoading: true, error: null });
          return newMap;
        });
      }

      fetchPage(newPage, cursor);
    }
  }, [hasMore, cursor, fetchPage, currentPage, allPageResults]);

  const previousPage = useCallback(() => {
    if (currentPage > 0) {
      const newPage = currentPage - 1;
      const prevCursor = pageHistory[newPage];

      setCurrentPage(newPage);
      fetchPage(newPage, prevCursor);
    }
  }, [currentPage, pageHistory, fetchPage]);

  const reload = useCallback(() => {
    pageCache.current.clear();
    setAllPageResults(
      new Map([[0, { data: null, isLoading: true, error: null }]]),
    );
    setCurrentPage(0);
    setPageHistory([undefined]);
    setMaxPagesVisited(1);
    fetchPage(0, undefined, true);
  }, [fetchPage]);

  const refresh = useCallback(() => {
    // Refetch current page without resetting state
    // This preserves the existing data while loading, preventing flicker
    const currentCursor = pageHistory[currentPage];
    const cacheKey = currentCursor ?? "initial";
    pageCache.current.delete(cacheKey);
    fetchPage(currentPage, currentCursor, true);
  }, [fetchPage, currentPage, pageHistory]);

  const currentPageResult = allPageResults.get(currentPage) ?? {
    data: null,
    isLoading: true,
    error: null,
  };

  const globalError =
    Array.from(allPageResults.values()).find((p) => p.error)?.error ?? null;

  const globalLoading = Array.from(allPageResults.values()).some(
    (p) => p.isLoading,
  );

  const totalPages = hasMore ? currentPage + 2 : currentPage + 1;
  const currentPageNumber = currentPage + 1;

  // Only show "+" if we're on the last visited page AND there are more pages
  const isOnLastVisitedPage = currentPageNumber === maxPagesVisited;
  const showPlus = isOnLastVisitedPage && hasMore;
  const pageInfo = getPaginationDisplay(
    currentPageNumber,
    maxPagesVisited,
    showPlus,
  );

  return {
    data: currentPageResult,
    allData: Array.from(allPageResults.values()),
    error: globalError,
    isLoading: globalLoading,
    currentPage,
    totalPages,
    nextPage,
    previousPage,
    hasNextPage: hasMore,
    hasPreviousPage: currentPage > 0,
    reload,
    refresh,
    pageInfo,
  };
}

/**
 * Returns a list of hooks with pagination control
 */
export function useWorkflowHooks(params: {
  runId?: string;
  limit?: number;
  sortOrder?: "asc" | "desc";
}): PaginatedList<HookListItem> {
  const { runId, limit = 10, sortOrder = "desc" } = params;

  const fetchFn = useCallback(
    (cursor?: string) =>
      unwrapOrThrow(rpc("fetchHooks", { runId, cursor, sortOrder, limit })),
    [runId, limit, sortOrder],
  );

  return usePaginatedList(fetchFn);
}
