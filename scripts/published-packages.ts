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

/** The repository's web address, from the root package.json: https://github.com/<owner>/<name>. */
export function repositoryUrl(root = join(import.meta.dir, "..")): string {
  const { repository } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  return repository.url.replace(/^git\+|\.git$/g, "");
}

if (import.meta.main)
  console.log(JSON.stringify(publishedPackages().map((p) => p.dir)));
