// The packages that ship to npm: every packages/*/package.json not marked private.
// Run directly, it prints the release's GitHub step outputs: `packages`, their
// directory names as a JSON array (the matrix), and `tag`, v<their one version>.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every package.json under packages/, private or not, by directory name. */
export function workspacePackages(root = join(import.meta.dir, "..")) {
  return readdirSync(join(root, "packages"))
    .sort()
    .flatMap((dir) => {
      const file = join(root, "packages", dir, "package.json");
      if (!existsSync(file)) return [];
      return [{ dir, file, data: JSON.parse(readFileSync(file, "utf8")) }];
    });
}

export function publishedPackages(root = join(import.meta.dir, "..")) {
  return workspacePackages(root).filter((p) => p.data.private !== true);
}

/** The repository's web address, from the root package.json: https://github.com/<owner>/<name>. */
export function repositoryUrl(root = join(import.meta.dir, "..")): string {
  const { repository } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  return repository.url.replace(/^git\+|\.git$/g, "");
}

/** The version every published package carries: they release in lockstep. */
export function releaseVersion(packages = publishedPackages()): string {
  const versions = new Set(packages.map((p) => p.data.version as string));
  if (versions.size !== 1)
    throw new Error(
      `published package versions must match: ${packages.map((p) => `${p.dir}@${p.data.version}`).join(", ")}`,
    );
  return [...versions][0]!;
}

if (import.meta.main) {
  const packages = publishedPackages();
  const tag = `v${releaseVersion(packages)}`;
  const { GITHUB_REF_TYPE, GITHUB_REF_NAME } = process.env;
  if (GITHUB_REF_TYPE === "tag" && GITHUB_REF_NAME !== tag)
    throw new Error(
      `tag ${GITHUB_REF_NAME} does not match the packages' ${tag}`,
    );
  console.log(`packages=${JSON.stringify(packages.map((p) => p.dir))}`);
  console.log(`tag=${tag}`);
}
