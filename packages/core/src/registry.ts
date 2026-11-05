import type { InstalledPlugin } from "./plugin-types";
import type { Service, ArchitectureSchema } from "./types";
import type { RouteIR } from "./compiler/ir";
import { getActionRoute } from "./routes";
import type { EventsDefinition } from "./events/hub";
import type { BrickSocketSchema } from "./socket-types";
import { claimName, definitionSite } from "./definition-site";

export interface ArchitectureApplication {
  services: readonly Service[];
  routes: readonly RouteIR[];
  events?: EventsDefinition;
  sockets?: readonly (BrickSocketSchema & { service: string; path: string })[];
  plugins?: readonly InstalledPlugin[];
}

export class ServiceRegistry {
  private _revision = 0;
  /** Definition revision for invalidating serialized architecture snapshots. */
  get revision(): number {
    return this._revision;
  }
  touch(): void {
    this._revision++;
  }

  private services = new Map<string, Service>();
  private sites = new Map<string, string | undefined>();

  /** @throws When a different file already registered a service with this name. */
  register(service: Service, site = definitionSite()): void {
    claimName(this.sites, `service "${service.name}"`, service.name, site);
    this.services.set(service.name, service);
    this.touch();
  }

  get(name: string): Service | undefined {
    return this.services.get(name);
  }

  has(name: string): boolean {
    return this.services.has(name);
  }

  list(): Service[] {
    return Array.from(this.services.values());
  }

  clear(): void {
    this.services.clear();
    this.sites.clear();
    this.touch();
  }

  /**
   * The architecture of an app (`app.definition`): its mounted routes. Without
   * one, every registered service with its default routes under `/api`.
   */
  exportArchitecture(
    application?: ArchitectureApplication,
  ): ArchitectureSchema {
    return {
      version: "1.0.0",
      ...(application?.events ? { events: application.events } : {}),
      ...(application?.plugins?.length
        ? { plugins: [...application.plugins] }
        : {}),
      services: (application?.services ?? this.list()).map((service) => {
        const byAction = new Map(
          application
            ? application.routes
                .filter((route) => route.service === service.name)
                .map((route) => [route.action, route])
            : service.listActions().flatMap((action) => {
                const route = getActionRoute(action);
                return route ? [[action.name, route] as const] : [];
              }),
        );
        const schema = service.introspect();
        return {
          ...schema,
          ...(application?.sockets
            ? {
                sockets: application.sockets.filter(
                  (socket) => socket.service === service.name,
                ),
              }
            : {}),
          actions: schema.actions.map((action) => {
            const route = byAction.get(action.name);
            return route
              ? { ...action, method: route.method, path: route.path }
              : action;
          }),
        };
      }),
    };
  }
}

// Global registry instance
let globalRegistry = new ServiceRegistry();

/**
 * The registry every `defineService` adds to: it is how `brick()`, the OpenAPI
 * generator, `useService`, and the dashboard find services by name.
 *
 * @returns The current global registry.
 */
export function getGlobalRegistry(): ServiceRegistry {
  return globalRegistry;
}

/**
 * Start over with an empty global registry. For tests, which define the same
 * services again in each case; an application never needs it.
 */
export function resetGlobalRegistry(): void {
  globalRegistry = new ServiceRegistry();
}
