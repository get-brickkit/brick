import { Empty, PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { formatClock } from "@/format";
import type { ReloadSummary } from "../../src/dashboard-protocol";

export function ReloadsView({ reloads }: { reloads: ReloadSummary[] }) {
  return (
    <>
      <PageHeader
        title="Reloads"
        description="Each time the app started, restarted, or exited"
      />
      <Panel>
        {reloads.length === 0 ? (
          <Empty title="No reloads yet" />
        ) : (
          reloads.map((reload) => (
            <div
              key={reload.id}
              className="grid min-h-10 grid-cols-[72px_96px_minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-2 text-sm last:border-b-0"
            >
              <span className="text-muted-foreground tabular-nums">
                {formatClock(reload.at)}
              </span>
              <span className="font-medium">{reload.kind}</span>
              <span className="truncate text-muted-foreground">
                {reload.detail}
              </span>
              <Badge variant="outline">Generation {reload.generation}</Badge>
            </div>
          ))
        )}
      </Panel>
    </>
  );
}
