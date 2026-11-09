import type { Service } from "./types";
import { planRoute } from "./action-handler";
import {
  analyzeApplication,
  freezeIR,
  type BrickIR,
  type RouteIR,
} from "./compiler/ir";
import {
  bindRoute,
  compilerRuntime,
  type CompiledHandler,
  type CompiledRoutePlan,
  type HandlerFactory,
} from "./compiler/runtime";
import { requireBrickApp } from "./app-entry";
import { portOf } from "./service-port";

/** @throws When the services no longer analyze to `ir`, so the build is stale. */
function analyzeMatching(services: Service<any, any>[], ir: BrickIR) {
  const analyzed = analyzeApplication(services, ir.prefix);
  if (JSON.stringify(analyzed.ir) !== JSON.stringify(ir))
    throw new Error(
      "Brick compiler: application definitions differ from the compiled IR; rebuild the application",
    );
  return analyzed;
}

/**
 * Build artifact bootstrap: import the bundled app. It is not re-analyzed
 * against the IR: the bundle and its IR come from one build (#107).
 *
 * @param _ir Ignored; kept so existing callers still type-check.
 */
export async function loadCompiledBrickApp(
  load: () => Promise<{ default: unknown }>,
  _ir?: BrickIR,
) {
  return requireBrickApp((await load()).default);
}

export type { BrickIR, RouteIR, RouteMethod } from "./compiler/ir";
export type {
  CompiledHandler,
  CompiledRoutePlan,
  HandlerFactory,
} from "./compiler/runtime";
export interface CompiledRoute {
  readonly ir: RouteIR;
  readonly handler: CompiledHandler;
}
export interface CompiledApplication {
  readonly ir: BrickIR;
  readonly routes: readonly CompiledRoute[];
}

function bindAnalyzed(
  ir: BrickIR,
  bindings: ReturnType<typeof analyzeApplication>["bindings"],
  bind: (plan: CompiledRoutePlan, index: number) => CompiledHandler = bindRoute,
): CompiledApplication {
  const routes = ir.routes.map((route, index) => {
    const { service, action } = bindings[index]!;
    const plan = Object.freeze(planRoute(route, service, action));
    return Object.freeze({ ir: route, handler: bind(plan, index) });
  });
  return Object.freeze({ ir: freezeIR(ir), routes: Object.freeze(routes) });
}

/** Startup compiler: analyzes once, then binds live callbacks. */
export function compileBrickApplication(options: {
  services: Service<any, any>[];
  prefix?: string;
  /** `"generic"` skips the plugins' preparations (no prewarm). */
  mode?: "specialized" | "generic";
}): CompiledApplication {
  const { ir, bindings } = analyzeApplication(options.services, options.prefix);
  if (options.mode !== "generic")
    for (const service of options.services)
      portOf(service).prepareContributions();
  return bindAnalyzed(ir, bindings);
}

/**
 * Build artifact binder: consumes emitted functions, with no runtime handler code generation.
 *
 * @deprecated `brick build` no longer emits handler factories; built servers
 * use `loadCompiledBrickApp`. Pass `compileBrickApplication(...)` as
 * `brick({ compilation })` instead.
 */
export function bindCompiledApplication(
  ir: BrickIR,
  services: Service<any, any>[],
  factories: readonly HandlerFactory[],
): CompiledApplication {
  if (ir.version !== 1 || ir.target !== "bun-elysia")
    throw new Error(
      "Brick compiler: unsupported IR version or target; rebuild the application",
    );
  const analyzed = analyzeMatching(services, ir);
  if (factories.length !== ir.routes.length)
    throw new Error("Brick compiler: handler factory count does not match IR");
  for (const service of services) portOf(service).prepareContributions();
  return bindAnalyzed(ir, analyzed.bindings, (plan, index) =>
    factories[index]!(plan, compilerRuntime),
  );
}
