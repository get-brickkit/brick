import type { BaseContext, PreparationContribution, Service } from "./types";
import type { OutboxTable } from "./events/outbox";
import type { ScheduleTable } from "./schedules/table";
import type { ServiceEvents } from "./events/types";
import type { EventRef } from "./events/catalog";

/**
 * What core's own modules use of a service, beyond the public `Service`. Every
 * service `defineService` makes is one.
 */
export interface ServicePort<
  TDb = any,
  TServiceContext extends Record<string, any> = Record<string, any>,
> extends Service<TDb, TServiceContext> {
  /** The values of this service's `deps`. Set by `brick({ deps })`. */
  readonly deps?: Readonly<Record<string, unknown>>;
  /** Whether the service declares an event catalog. */
  readonly hasCatalog: boolean;
  setDeps(deps: Readonly<Record<string, unknown>>): void;
  /** `resolveContext`, for an action or socket a plugin install created: it sees `pluginDeps`. */
  resolveContext(
    callCtx?: Partial<BaseContext<TDb> & TServiceContext>,
    pluginDeps?: Readonly<Record<string, unknown>>,
  ): Promise<BaseContext<TDb> & TServiceContext>;
  setRecorder(recorder: ServiceEvents | undefined): void;
  getOutbox(): OutboxTable | undefined;
  getScheduleTable(): ScheduleTable | undefined;
  /** @throws When the event is not in the catalog or its payload does not match. */
  checkEvent(name: string, payload: unknown): void;
  /** Adds events to the catalog (a plugin's). */
  addEvents(refs: Readonly<Record<string, EventRef>>): void;
  registerTable(table: unknown): this;
  listPreparations(): PreparationContribution[];
  prepareContributions(): void;
  /** Records the declarations; the returned function puts them back (plugin rollback). */
  snapshot(): () => void;
  /** Marks the definitions changed, so cached architecture and OpenAPI are rebuilt. */
  touch(): void;
}

/** The port of a service: every `Service` is a `ServicePort`. */
export function portOf<TDb, TCtx extends Record<string, any>>(
  service: Service<TDb, TCtx>,
): ServicePort<TDb, TCtx> {
  return service as ServicePort<TDb, TCtx>;
}
