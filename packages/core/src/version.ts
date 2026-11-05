import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let runningVersion: string | undefined;
/** The version of this @brickkit/core, read from its package.json; `""` when unknown. */
export function brickVersion(): string {
  if (runningVersion !== undefined) return runningVersion;
  // src/ and dist/ sit one level down, a shared chunk two.
  for (const relative of ["../package.json", "../../package.json"]) {
    try {
      const json = JSON.parse(
        readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"),
      );
      if (json.name === "@brickkit/core")
        return (runningVersion = json.version);
    } catch {
      // Not there; try the next one.
    }
  }
  // shortcut: a bundle that inlined core has no package.json; the check then passes.
  return (runningVersion = "");
}

type Triple = [number, number, number];
function parseVersion(version: string): Triple {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, "")
    .split(/[-+]/)[0]!
    .split(".")
    .map(Number);
  return [major, minor, patch];
}
function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Whether `version` is in a semver `range`: `^0.11.0`, `~0.11.2`, `>=0.11 <0.13`,
 * `0.11.x`, `*`, and `||` between alternatives. Prerelease tags are ignored.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const current = parseVersion(version);
  return range.split("||").some((set) =>
    set
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .every((comparator) => {
        const match =
          /^(\^|~|>=|<=|>|<|=)?v?([\dx*]+(?:\.[\dx*]+){0,2})?/i.exec(
            comparator,
          );
        const operator = match?.[1] ?? "";
        const raw = match?.[2] ?? "*";
        const parts = raw.split(".");
        const wild = parts.findIndex((part) => /^[x*]$/i.test(part));
        const given = wild === -1 ? parts.length : wild;
        const low = parseVersion(parts.slice(0, given).join(".") || "0");
        if (given === 0) return true;
        const cmp = compare(current, low);
        if (operator === ">=") return cmp >= 0;
        if (operator === ">") return cmp > 0;
        if (operator === "<") return cmp < 0;
        if (operator === "<=") return cmp <= 0;
        let high: Triple;
        if (operator === "^")
          high =
            low[0] > 0 || given === 1
              ? [low[0] + 1, 0, 0]
              : low[1] > 0 || given === 2
                ? [0, low[1] + 1, 0]
                : [0, 0, low[2] + 1];
        else if (operator === "~" || given < 3)
          high = given === 1 ? [low[0] + 1, 0, 0] : [low[0], low[1] + 1, 0];
        else return cmp === 0;
        return cmp >= 0 && compare(current, high) < 0;
      }),
  );
}
