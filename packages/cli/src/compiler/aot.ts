import { aot } from "elysia/plugin/aot/bun";
import type { BunPlugin } from "bun";

/** Keep the pinned Elysia beta's incomplete stripping from breaking builds. */
export function brickAot(entry: string, keep: boolean): BunPlugin {
  // `keep`: WS routes still need cookie setup during reconstruction in beta.29,
  // and shipped workflows mount their webhook route only when a world is set at
  // run time. Retain those modules while continuing to precompile HTTP handlers.
  if (keep) return aot(entry, { target: "bun", strip: false });
  return {
    name: "brick-elysia-aot",
    async setup(build) {
      await aot(entry, { target: "bun", strip: true }).setup({
        ...build,
        onLoad(options, callback) {
          return build.onLoad(options, async (args) => {
            const result = await callback(args);
            if (
              !result ||
              !("contents" in result) ||
              typeof result.contents !== "string"
            )
              return result;
            let contents = result.contents;
            if (
              /[/\\]elysia[/\\]dist[/\\]ws[/\\]route\.m?js$/.test(args.path) &&
              contents.includes(
                "[elysia-aot] WebSocket route builder was stripped",
              )
            ) {
              for (const name of ["resolveWSOptions", "accumulateWSOptions"]) {
                if (!contents.includes(`export function ${name}`))
                  contents += `\nexport function ${name}() { throw new Error("WebSocket support was stripped"); }\n`;
              }
            }
            return contents === result.contents
              ? result
              : { ...result, contents };
          });
        },
      });
    },
  };
}
