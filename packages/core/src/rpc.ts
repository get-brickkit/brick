import type { Action, ActionContext, ProxyOptions, Service } from "./types";
import type {
  BrickClientAction,
  BrickClientSocket,
  BrickServices,
  InferActionInput,
  InferActionOutput,
} from "./client";
import { getGlobalRegistry } from "./registry";
import { getPluginActionRoute } from "./routes";
import { pickContextEnvelope } from "./context";
import { withCallSpan } from "./telemetry";

/** An in-process caller for one action: its input, then an optional call context. */
export type ServiceActionCaller<A> =
  undefined extends InferActionInput<A>
    ? (
        input?: InferActionInput<A>,
        ctx?: Partial<ActionContext>,
      ) => Promise<InferActionOutput<A>>
    : (
        input: InferActionInput<A>,
        ctx?: Partial<ActionContext>,
      ) => Promise<InferActionOutput<A>>;

/**
 * What `useService` returns: the service's actions as methods, with each
 * resource's actions under the resource's name. Sockets are left out.
 */
export type ServiceClient<T> = {
  [
    K in keyof T as T[K] extends BrickClientSocket<any, any> ? never : K
  ]: T[K] extends
    | BrickClientAction<any, any, any>
    | Action<any, any, any, any>
    | ((...args: any[]) => any)
    ? ServiceActionCaller<T[K]>
    : ServiceClient<T[K]>;
};

declare const serviceNameType: unique symbol;

/** Type only: the literal name of a service, which `useService` finds its contract by. */
export interface NamedService<N extends string> {
  readonly [serviceNameType]?: N;
}

/** What `useService` returns while the contract does not describe the service yet. */
export type UntypedServiceClient = { [name: string]: any };

/**
 * Call another service's actions in-process, typed from that service. Each
 * action is a method, and each resource's actions sit under the resource's
 * name: `billing.charge(input)`, `billing.invoice.list()`.
 *
 * The types come from the app's generated contract (`_brick/contract.ts`, which
 * `brick dev` and `brick gen client` keep current), so renaming an action or
 * changing its input is a compile error at every caller. Until the contract
 * describes the service, the client is untyped.
 *
 * A call runs through the target's own validation and authorization, with the
 * target's database, context and deps (never the caller's), and shows as an
 * `rpc` span in the trace.
 *
 * @param service - The service to call, as `defineService` returned it.
 * @param options - `from` (the calling service's name, which becomes `ctx.caller`
 * in the target and cannot be spoofed) and `context` (defaults for every call).
 * Each call also takes an optional call context after its input.
 * @returns The client.
 * @throws On a call, when the service is not registered or has no such action.
 * @example
 * import { useService } from "@brickkit/core";
 * import { billingService } from "../billing/billing.service";
 *
 * const billing = useService(billingService, { from: "orders" });
 * await billing.charge({ orderId, amountCents });
 * await billing.invoice.list({ limit: 10 });
 */
export function useService<const N extends string = string>(
  service: { readonly name: string } & NamedService<N>,
  options: ProxyOptions = {},
): N extends keyof BrickServices
  ? ServiceClient<BrickServices[N]>
  : UntypedServiceClient {
  return serviceRef(service.name, options, []);
}

function serviceRef(
  serviceName: string,
  options: ProxyOptions,
  path: readonly string[],
): any {
  return new Proxy(function () {}, {
    get(_, key) {
      // Only string keys name actions; `then` stays unset so the client is not a promise.
      if (typeof key !== "string" || key === "then") return undefined;
      return serviceRef(serviceName, options, [...path, key]);
    },
    apply(_, __, [payload, callCtx]) {
      const name = path.join(".");
      const clientPath = [serviceName, ...path].join(".");
      return callAction(
        serviceName,
        name,
        (service) =>
          service.getAction(name) ??
          // Plugin actions (CRUD) are found by the path the typed client uses.
          service
            .listActions()
            .find(
              (action) =>
                (getPluginActionRoute(action) || undefined)?.clientPath?.join(
                  ".",
                ) === clientPath,
            ),
        payload,
        callCtx,
        options,
      );
    },
  });
}

async function callAction(
  serviceName: string,
  actionName: string,
  find: (service: Service<any, any>) => Action<any, any, any, any> | undefined,
  payload: unknown,
  callCtx: Partial<ActionContext> | undefined,
  options: ProxyOptions,
) {
  const service = getGlobalRegistry().get(serviceName);
  if (!service) {
    throw new Error(
      `[Brick-TS RPC] Service '${serviceName}' is not registered in the local runtime.`,
    );
  }
  const action = find(service);
  if (!action) {
    throw new Error(
      `[Brick-TS RPC] Action '${actionName}' does not exist on service '${serviceName}'.`,
    );
  }
  const envelopeCtx = createRpcEnvelope(options.from, options.context, callCtx);
  return withCallSpan(
    `rpc ${serviceName}.${actionName}`,
    { "brick.service": serviceName, "brick.action": actionName },
    () => action.execute({ input: payload, ctx: envelopeCtx }),
  );
}

/** Build the trusted envelope for a proxy call.
 *
 * When `from` is provided, it identifies the service that created the proxy
 * and always sets `caller` — any `caller` supplied via `options.context` or
 * the per-call context is ignored so it cannot be spoofed. When `from` is
 * omitted, an explicitly supplied `caller` still passes through for backward
 * compatibility; otherwise `caller` stays unset (never the target service).
 */
export function createRpcEnvelope(
  from: string | undefined,
  defaultContext?: Partial<ActionContext>,
  callContext?: Partial<ActionContext>,
): Partial<ActionContext> {
  const envelope = {
    ...pickContextEnvelope(defaultContext),
    ...pickContextEnvelope(callContext),
  } as Partial<ActionContext> & { caller?: string };
  // `caller` identifies the service that created this proxy, never the target.
  // A configured `from` wins over any supplied value; without `from` we keep
  // an explicitly supplied caller (legacy) and otherwise leave it unset.
  if (from !== undefined) {
    envelope.caller = from;
  }
  return envelope;
}
