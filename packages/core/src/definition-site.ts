import { fileURLToPath } from "node:url";
import { DuplicateNameError } from "./types";

// The package root (src/ or dist/ is beneath it), so Brick's own frames are skipped.
const brickRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The first `file:line` outside Brick on the current stack: where a name is
 * being defined. Best-effort: `undefined` when there is no stack.
 */
export function definitionSite(): string | undefined {
  // Plugins nest several Brick frames above the caller's.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  const stack = new Error().stack;
  Error.stackTraceLimit = limit;
  for (const line of stack?.split("\n").slice(1) ?? []) {
    const match =
      /(?:\(|at )(?:file:\/\/)?([^\s()?]+)(?:\?[^\s():]*)?:(\d+):\d+\)?$/.exec(
        line,
      );
    if (!match) continue;
    const [, file, row] = match;
    if (
      file!.startsWith(`${brickRoot}src/`) ||
      file!.startsWith(`${brickRoot}dist/`)
    )
      continue;
    return `${file}:${row}`;
  }
  return undefined;
}

/**
 * Records where `name` is defined. The same file defining it again (a dev
 * reload) replaces the old definition.
 *
 * @throws When a different file already defined `name`.
 */
export function claimName(
  sites: Map<string, string | undefined>,
  label: string,
  name: string,
  site: string | undefined,
): void {
  const file = (at: string | undefined) => at?.replace(/:\d+$/, "");
  if (sites.has(name) && file(sites.get(name)) !== file(site))
    throw new DuplicateNameError(
      `Brick: duplicate ${label}\n  ${sites.get(name) ?? "unknown"}\n  ${site ?? "unknown"}`,
    );
  sites.set(name, site);
}
