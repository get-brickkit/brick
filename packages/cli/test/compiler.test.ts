import { beforeEach, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  defineService,
  resetGlobalRegistry,
  t,
  compileBrickApplication,
  brick,
  loadCompiledBrickApp,
  bindCompiledApplication,
  type HandlerFactory,
} from "@brickkit/core";
import { emitCompiledApplication } from "../src/compiler";

beforeEach(resetGlobalRegistry);

it("emits the IR that a built server checks its app against", async () => {
  const service = defineService("emitted");
  const action = service.action({
    name: "getItem",
    method: "GET",
    input: t.Object({ id: t.String() }),
    execute: ({ input }) => input,
  });
  const compilation = compileBrickApplication({
    services: [service],
    prefix: "/v1",
  });
  const dir = await mkdtemp(join(tmpdir(), "brick-compiler-"));
  try {
    const path = join(dir, "routes.mjs");
    await Bun.write(path, emitCompiledApplication(compilation.ir));
    const emitted = await import(path);
    const app = brick({
      services: [service],
      prefix: "/v1",
      requestLogging: false,
    });
    const load = async () => ({ default: app });
    expect(await loadCompiledBrickApp(load, emitted.ir)).toBe(app);
    expect(
      await (
        await app.handle(
          new Request("http://localhost/v1/emitted/get-item?id=abc"),
        )
      ).json(),
    ).toEqual({ id: "abc" });
    // Deprecated, still working: binding emitted factories by hand.
    const bound = bindCompiledApplication(
      emitted.ir,
      [service],
      emitted.ir.routes.map(
        (): HandlerFactory => (plan, runtime) => runtime.bindRoute(plan),
      ),
    );
    expect(bound.routes).toHaveLength(1);
    action.config.input = t.Object({ id: t.Number() }) as any;
    await expect(loadCompiledBrickApp(load, emitted.ir)).rejects.toThrow(
      "differ from the compiled IR",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
