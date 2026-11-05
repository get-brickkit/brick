import type { Service } from "./types";
import { planRoute } from "./action-handler";
import {
  analyzeApplication,
  freezeIR,
  type BrickIR,
  type RouteIR,
} from "./compiler/ir";
import {
  compilerRuntime,
  type CompiledHandler,
  type HandlerFactory,
} from "./compiler/runtime";
import { requireBrickApp } from "./app-entry";
import { portOf } from "./service-port";

/**
 * Build artifact bootstrap: import the app and check that its definitions
 * still match the IR `brick build` compiled.
 *
 * @throws When the app's definitions differ from `ir`.
 */
export async function loadCompiledBrickApp(
  load: () => Promise<{ default: unknown }>,
  ir: BrickIR,
) {
  const app = requireBrickApp((await load()).default);
  const { ir: current } = analyzeApplication(
    [...app.definition.services],
    app.definition.prefix,
  );
  if (JSON.stringify(current) !== JSON.stringify(ir))
    throw new Error(
      "Brick compiler: application definitions differ from the compiled IR; rebuild the application",
    );
  return app;
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
  factories: readonly HandlerFactory[],
): CompiledApplication {
  if (factories.length !== ir.routes.length)
    throw new Error("Brick compiler: handler factory count does not match IR");
  const routes = ir.routes.map((route, index) => {
    const { service, action } = bindings[index]!;
    const plan = Object.freeze(planRoute(route, service, action));
    const handler = factories[index]!(plan, compilerRuntime);
    return Object.freeze({ ir: route, handler });
  });
  return Object.freeze({ ir: freezeIR(ir), routes: Object.freeze(routes) });
}

/** Startup compiler: analyzes once, then binds live callbacks. */
export function compileBrickApplication(options: {
  services: Service<any, any>[];
  prefix?: string;
  mode?: "specialized" | "generic";
}): CompiledApplication {
  const { ir, bindings } = analyzeApplication(options.services, options.prefix);
  // Both modes bind the one pipeline; only the specialized one runs preparations.
  if (options.mode !== "generic")
    for (const service of options.services)
      portOf(service).prepareContributions();
  return bindAnalyzed(
    ir,
    bindings,
    ir.routes.map(() => (plan, runtime) => runtime.bindRoute(plan)),
  );
}

/** Build artifact binder: consumes emitted functions, with no runtime handler code generation. */
export function bindCompiledApplication(
  ir: BrickIR,
  services: Service<any, any>[],
  factories: readonly HandlerFactory[],
): CompiledApplication {
  if (ir.version !== 1 || ir.target !== "bun-elysia")
    throw new Error(
      "Brick compiler: unsupported IR version or target; rebuild the application",
    );
  const analyzed = analyzeApplication(services, ir.prefix);
  if (JSON.stringify(analyzed.ir) !== JSON.stringify(ir))
    throw new Error(
      "Brick compiler: application definitions differ from the compiled IR; rebuild the application",
    );
  for (const service of services) portOf(service).prepareContributions();
  return bindAnalyzed(ir, analyzed.bindings, factories);
}
