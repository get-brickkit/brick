import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { publishedPackages, repositoryUrl } from "./published-packages.ts";

const root = join(import.meta.dir, "..");
const packages = publishedPackages(root);
// Released in lockstep, so any package carries the release version.
const version = packages[0]!.data.version;
const tag = `v${version}`;
const repo = repositoryUrl(root);
const SECTIONS: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  refactor: "Refactors",
};
// type(scope)!: description. A breaking change keeps its marker in the notes.
const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?(!)?:\s*(.*)$/;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const previous = git(
  "tag",
  "--merged",
  "HEAD",
  "--list",
  "v*",
  "--sort=-version:refname",
)
  .split("\n")
  .find(
    (candidate) =>
      (version.includes("-")
        ? /^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/
        : /^v\d+\.\d+\.\d+$/
      ).test(candidate) && candidate !== tag,
  );

let hasChanges = false;
for (const { dir, data } of packages) {
  const commits = git(
    "log",
    "--format=%H\t%s",
    previous ? `${previous}..HEAD` : "HEAD",
    "--",
    `packages/${dir}`,
    // The inspector ships inside the CLI.
    ...(dir === "cli" ? ["packages/workflow-inspector"] : []),
  )
    .split("\n")
    .flatMap((line) => {
      const [sha = "", subject = ""] = line.split("\t");
      const [, type = "", breaking, description] =
        CONVENTIONAL.exec(subject) ?? [];
      return Object.hasOwn(SECTIONS, type)
        ? [{ sha, type, text: breaking ? subject : description }]
        : [];
    });
  if (!commits.length) continue;
  hasChanges = true;
  console.log(`## ${data.name}\n`);
  for (const [type, heading] of Object.entries(SECTIONS)) {
    const entries = commits.filter((commit) => commit.type === type);
    if (!entries.length) continue;
    console.log(`### ${heading}\n`);
    for (const { sha, text } of entries)
      console.log(`- ${text} ([${sha.slice(0, 7)}](${repo}/commit/${sha}))`);
    console.log();
  }
}

if (!hasChanges) console.log("No user-facing package changes.\n");

console.log(
  previous
    ? `**Full changelog:** [${previous}...${tag}](${repo}/compare/${previous}...${tag})`
    : `**Full changelog:** [${tag}](${repo}/commits/${tag})`,
);
