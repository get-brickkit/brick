import { useMemo } from "react";
import { Empty, PageHeader } from "@/components/page-header";
import { Panel } from "@/components/panel";
import { ServiceGraphPanel } from "@/components/service-graph";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { isFailure } from "@/format";
import { cn } from "@/lib/utils";
import { Slot } from "@/extension";
import type {
  ArchitectureSnapshot,
  TraceSummary,
} from "../../src/dev-telemetry-store";

interface RouteRow {
  key: string;
  action: string;
  requests: number;
  failures: number;
}

export function OverviewView({
  architecture,
  traces,
}: {
  architecture: ArchitectureSnapshot | null;
  traces: TraceSummary[];
}) {
  const services = architecture?.schema.services ?? [];
  const sockets = services.flatMap((service) =>
    (service.sockets ?? []).map((socket) => ({
      ...socket,
      service: service.name,
    })),
  );
  const listeners = architecture?.schema.events?.listeners ?? [];
  const events = services.flatMap((service) =>
    (service.events ?? []).map((event) => ({
      ...event,
      service: service.name,
      fields: Object.keys(
        (event.schema as { properties?: object } | undefined)?.properties ?? {},
      ),
      listeners: listeners
        .filter((listener) =>
          listener.on.some((pattern) =>
            pattern.endsWith("*")
              ? event.name.startsWith(pattern.slice(0, -1))
              : pattern === event.name,
          ),
        )
        .map((listener) => listener.name),
    })),
  );
  const rows = useMemo<RouteRow[]>(() => {
    const result: RouteRow[] = [];
    for (const service of services) {
      for (const action of service.actions) {
        if (!action.method || !action.path) continue;
        const key = `${action.method} ${action.path}`;
        const matching = traces.filter(
          (trace) =>
            trace.method !== undefined &&
            trace.route !== undefined &&
            `${trace.method} ${trace.route}` === key,
        );
        result.push({
          key,
          // Labelled with the plugin that contributed it.
          action: `${service.name}.${action.name}${action.plugin ? ` · ${action.plugin}` : ""}`,
          requests: matching.length,
          failures: matching.filter(isFailure).length,
        });
      }
    }
    return result;
  }, [services, traces]);

  return (
    <>
      <PageHeader
        title="Overview"
        description="Routes and services of the running app. Counts cover the recent requests kept in memory."
      />
      <Slot name="overview.top" />
      {!architecture ? (
        <Panel>
          <Empty title="Waiting for the application to start" />
        </Panel>
      ) : (
        <>
          <ServiceGraphPanel architecture={architecture} traces={traces} />
          <Panel>
            {rows.length === 0 ? (
              <Empty title="No HTTP routes are registered" />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-4">Route</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead className="text-right">Requests</TableHead>
                    <TableHead className="px-4 text-right">Failures</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell className="px-4 font-mono text-xs">
                        {row.key}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.action}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.requests}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "px-4 text-right tabular-nums",
                          row.failures > 0
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {row.failures}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
          {sockets.length > 0 && (
            <>
              <h2 className="mt-2 -mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
                WebSockets
              </h2>
              <Panel>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-4">Socket route</TableHead>
                      <TableHead>Client sends</TableHead>
                      <TableHead>Server sends</TableHead>
                      <TableHead className="px-4">Authorization</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sockets.map((socket) => (
                      <TableRow key={`${socket.service}.${socket.name}`}>
                        <TableCell className="px-4">
                          <div className="font-mono text-xs">
                            WS {socket.path ?? socket.name}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {socket.service}.{socket.name}
                          </div>
                          {socket.description && (
                            <div className="mt-1 text-xs text-muted-foreground">
                              {socket.description}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {socket.input.join(", ") || "none"}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {socket.output.join(", ") || "none"}
                        </TableCell>
                        <TableCell className="px-4 text-muted-foreground">
                          {socket.hasAuthorize
                            ? "Checked on connect and messages"
                            : "No authorize hook"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Panel>
            </>
          )}
          {events.length > 0 && (
            <>
              <h2 className="mt-2 -mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
                Events
              </h2>
              <Panel>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="px-4">Event</TableHead>
                      <TableHead>Payload</TableHead>
                      <TableHead className="px-4">Listeners</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((event) => (
                      <TableRow key={event.name}>
                        <TableCell className="px-4 font-mono text-xs">
                          {event.name}
                          {event.plugin && (
                            <span className="text-muted-foreground">
                              {" "}
                              · {event.plugin}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {event.fields.join(", ") || "none"}
                        </TableCell>
                        <TableCell className="px-4 text-muted-foreground">
                          {event.listeners.join(", ") || "none"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Panel>
            </>
          )}
          <h2 className="mt-2 -mb-1 text-xs font-medium tracking-wider text-muted-foreground uppercase">
            Services
          </h2>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
            {services.map((service) => (
              <Panel key={service.name}>
                <div className="flex flex-col gap-1 p-4 text-sm">
                  <div className="font-semibold">{service.name}</div>
                  <div className="text-muted-foreground">
                    {service.databaseConfig
                      ? `${service.databaseConfig.engine} · tables: ${
                          service.databaseConfig.tables
                            .map((table) => {
                              const plugin =
                                service.databaseConfig?.plugins?.[table];
                              return plugin ? `${table} (${plugin})` : table;
                            })
                            .join(", ") || "none"
                        }`
                      : "No database"}
                  </div>
                  <div className="text-muted-foreground">
                    Resources:{" "}
                    {(service.resources ?? [])
                      .map((item) => item.name)
                      .join(", ") || "none"}
                  </div>
                  <div className="text-muted-foreground">
                    Actions: {service.actions.length}
                  </div>
                  {service.sockets && service.sockets.length > 0 && (
                    <div className="text-muted-foreground">
                      WebSockets: {service.sockets.length}
                    </div>
                  )}
                </div>
              </Panel>
            ))}
          </div>
        </>
      )}
    </>
  );
}
