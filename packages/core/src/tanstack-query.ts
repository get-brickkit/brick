import type { DataTag, QueryFunctionContext } from "@tanstack/query-core";
import {
  createBrickClient,
  type BrickActionCaller,
  type BrickCallOptions,
  type BrickClientAction,
  type BrickClientOptions,
  type InferActionInput,
  type InferActionOutput,
} from "./client";
import type { Action } from "./types";
import { DEFAULT_PREFIX } from "./routes";

type ActionKey = readonly [
  "brick",
  string,
  string,
  readonly string[],
  {
    method: string | null;
    path: string | null;
    serviceName: string | null;
    name: string | null;
  },
  ...unknown[],
];
type InputOptions<A> =
  undefined extends InferActionInput<A>
    ? { input?: InferActionInput<A>; request?: BrickCallOptions }
    : { input: InferActionInput<A>; request?: BrickCallOptions };
type InputArgs<A> =
  undefined extends InferActionInput<A>
    ? [options?: InputOptions<A>]
    : [options: InputOptions<A>];

export type BrickQueryAction<A> = BrickActionCaller<A> & {
  /** Omit options for an action-wide invalidation key. */
  queryKey: {
    (): ActionKey;
    (options: {
      input: InferActionInput<A>;
    }): DataTag<ActionKey, InferActionOutput<A>>;
  };
  queryOptions: (...args: InputArgs<A>) => {
    queryKey: DataTag<ActionKey, InferActionOutput<A>>;
    queryFn: (
      context: Pick<QueryFunctionContext, "signal">,
    ) => Promise<InferActionOutput<A>>;
  };
  mutationOptions: (options?: { request?: BrickCallOptions }) => {
    mutationKey: ActionKey;
    mutationFn: (input: InferActionInput<A>) => Promise<InferActionOutput<A>>;
  };
};

export type BrickQueryClient<T> = T extends
  | BrickClientAction<infer _I, infer _O, infer _E>
  | Action<infer _AI, infer _AO, infer _AC, infer _AE>
  | ((...args: never[]) => unknown)
  ? BrickQueryAction<T>
  : { [K in keyof T]: BrickQueryClient<T[K]> };

/** Query helpers share the ordinary Brick HTTP client, including custom routes. */
export function createBrickQueryClient<T extends Record<string, unknown>>(
  options: BrickClientOptions & { contract: T },
): BrickQueryClient<T> {
  const client = createBrickClient(options);
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  function stringProperty(value: unknown, property: string): string | null {
    const result: unknown = Reflect.get(Object(value), property);
    return typeof result === "string" ? result : null;
  }
  function namespace(
    node: unknown,
    path: string[],
    metadata: unknown,
  ): unknown {
    const config: unknown = Reflect.get(Object(metadata), "config");
    const identity = {
      method: stringProperty(config, "method"),
      path: stringProperty(config, "path"),
      serviceName: stringProperty(metadata, "serviceName"),
      name: stringProperty(metadata, "name"),
    };
    const key = (args?: { input: unknown }): ActionKey =>
      args === undefined
        ? ["brick", baseUrl, prefix, path, identity]
        : ["brick", baseUrl, prefix, path, identity, args.input];
    const call = (
      input: unknown,
      request?: BrickCallOptions,
    ): Promise<unknown> => {
      if (typeof node !== "function")
        throw new Error(
          "Brick: select an action before calling Query helpers.",
        );
      return node(input, request);
    };
    return new Proxy(call, {
      get(_target, prop) {
        if (prop === "then" || prop === "catch" || prop === "finally")
          return undefined;
        if (prop === "queryKey") return key;
        if (prop === "queryOptions")
          return (args?: { input?: unknown; request?: BrickCallOptions }) => ({
            queryKey: key({ input: args?.input }),
            queryFn: ({ signal }: Pick<QueryFunctionContext, "signal">) => {
              const signals = [
                signal,
                args?.request?.signal ?? options.signal,
              ].filter((value): value is AbortSignal => value !== undefined);
              return call(args?.input, {
                ...args?.request,
                signal: AbortSignal.any(signals),
              });
            },
          });
        if (prop === "mutationOptions")
          return (args?: { request?: BrickCallOptions }) => ({
            mutationKey: key(),
            mutationFn: (input: unknown) => call(input, args?.request),
          });
        if (typeof prop !== "string") return undefined;
        return namespace(
          Reflect.get(Object(node), prop),
          [...path, prop],
          Reflect.get(Object(metadata), prop),
        );
      },
    });
  }
  // The proxy maps contract leaves to callable helpers; no backend values are loaded.
  return namespace(client, [], options.contract) as BrickQueryClient<T>;
}
