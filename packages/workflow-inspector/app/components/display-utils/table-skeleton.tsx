import { Card, CardContent } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { DEFAULT_PAGE_SIZE } from "~/lib/utils";

/** The hooks table while its first page loads: Hook ID, Run ID, Token, Created, Invocations, Actions. */
export function TableSkeleton({ rows = DEFAULT_PAGE_SIZE }: { rows?: number }) {
  return (
    <Card className="overflow-hidden mt-4 bg-background">
      <CardContent className="p-0">
        <div className="grid grid-cols-[1.2fr_1.2fr_0.8fr_1fr_0.5fr_40px] items-center gap-4 py-3 px-4 border-b">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-12" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-20" />
          <div className="w-6" />
        </div>
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={`skeleton-row-${i}`}
            className="grid grid-cols-[1.2fr_1.2fr_0.8fr_1fr_0.5fr_40px] items-center gap-4 py-3 px-4"
          >
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-4 w-8" />
            <Skeleton className="h-6 w-6 rounded" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
