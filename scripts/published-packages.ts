// The packages that ship to npm: every packages/*/package.json not marked private.
// Run directly, it prints their directory names as a JSON array (the release matrix).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function publishedPackages(root = join(import.meta.dir, "..")) {
  return readdirSync(join(root, "packages"))
    .sort()
    .flatMap((dir) => {
      const file = join(root, "packages", dir, "package.json");
      if (!existsSync(file)) return [];
      const data = JSON.parse(readFileSync(file, "utf8"));
      return data.private === true ? [] : [{ dir, file, data }];
    });
}

if (import.meta.main)
  console.log(JSON.stringify(publishedPackages().map((p) => p.dir)));
