import { useCallback, useEffect, useState } from "react";
import type { ScheduleRunRecord, ScheduleState } from "@brickkit/core";
import { Empty, PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime } from "@/format";
import { describeSchedule, ROUTES } from "../../src/dashboard-protocol";

const REFRESH_MS = 3000;

const at = (iso: string | null) =>
  iso ? formatDateTime(Date.parse(iso)) : "—";

function RunBadge({ run }: { run: ScheduleRunRecord }) {
  const variant =
    run.outcome === "failed"
      ? "destructive"
      : run.outcome === "skipped"
        ? "outline"
        : "secondary";
  return (
    <Badge
      variant={variant}
      title={`${run.trigger} run of ${run.slot}, try ${run.attempt}: ${run.startedAt} – ${run.finishedAt}${run.error ? `\n${run.error}` : ""}`}
    >
      {run.outcome}
    </Badge>
  );
}

/**
 * The app's schedules, read from its schedule table through the dev server:
 * when each is next due, its last runs, and a button to run one now.
 */
export function SchedulesView() {
  const [schedules, setSchedules] = useState<ScheduleState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch(ROUTES.schedules.path);
      if (!response.ok) throw new Error(await response.text());
      setSchedules((await response.json()) as ScheduleState[]);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  const runNow = async (name: string) => {
    const response = await fetch(
      `${ROUTES.schedules.path}/${encodeURIComponent(name)}`,
      { method: "POST" },
    );
    if (!response.ok) setError(await response.text());
    else if (!((await response.json()) as { started: boolean }).started)
      setError(`'${name}' is running now, so it was not started again.`);
    void load();
  };
  return (
    <>
      <PageHeader
        title="Schedules"
        description="When each schedule is next due, and its last runs"
      />
      {error && <div className="text-sm text-destructive">{error}</div>}
      <Panel>
        {!schedules ? (
          <Empty title="Loading schedules" />
        ) : schedules.length === 0 ? (
          <Empty title="This app has no schedules" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-4">Schedule</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Last success</TableHead>
                <TableHead>Last runs</TableHead>
                <TableHead className="px-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((schedule) => (
                <TableRow key={schedule.name}>
                  <TableCell className="px-4 font-mono text-xs">
                    {schedule.name}
                    {schedule.kind === "workflow" && (
                      <span className="text-muted-foreground"> · workflow</span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {describeSchedule(schedule)}
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {schedule.running ? (
                      <Badge>running</Badge>
                    ) : !schedule.enabled ? (
                      <span className="text-muted-foreground">disabled</span>
                    ) : (
                      <>
                        {at(schedule.nextRunAt)}
                        {schedule.attempts > 0 && (
                          <span className="text-muted-foreground">
                            {" "}
                            · retry {schedule.attempts + 1}
                          </span>
                        )}
                      </>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {at(schedule.lastSuccessAt)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {schedule.runs.slice(0, 5).map((run) => (
                        <RunBadge
                          key={`${run.startedAt}:${run.attempt}`}
                          run={run}
                        />
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 text-right">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={schedule.running}
                      onClick={() => void runNow(schedule.name)}
                    >
                      Run now
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>
    </>
  );
}
