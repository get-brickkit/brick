import type { RouteIR } from "./ir";

/** A route's handler factory for `brick build`: it binds the runtime pipeline, so no framework logic is emitted. */
export function emitHandlerFactory(_route: RouteIR): string {
  return "function bindAction(binding, runtime) { return runtime.bindRoute(binding); }";
}
