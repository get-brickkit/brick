import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishedPackages } from "./published-packages.ts";

const workflow: {
  jobs: { commit: { steps: { name?: string; run?: string }[] } };
} = Bun.YAML.parse(
  await Bun.file(
    new URL("../.github/workflows/publish-npm.yml", import.meta.url),
  ).text(),
);

const PACKAGES = publishedPackages().map((p) => p.dir);

test("post-publication commit preserves branch updates and tags the validated source", async () => {
  const root = await mkdtemp(join(tmpdir(), "brick-release-finalize-"));
  const checkout = join(root, "candidate");
  const origin = join(root, "origin.git");
  const concurrent = join(root, "concurrent");
  await mkdir(checkout);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git(checkout, "init", "-b", "main");
    git(checkout, "config", "user.name", "Release test");
    git(checkout, "config", "user.email", "release@example.com");
    for (const pkg of PACKAGES) {
      await mkdir(join(checkout, "packages", pkg), { recursive: true });
      await writeFile(
        join(checkout, "packages", pkg, "package.json"),
        '{"version":"0.7.3"}\n',
      );
    }
    await writeFile(join(checkout, "bun.lock"), "original lockfile\n");
    await writeFile(join(checkout, "source.txt"), "validated source\n");
    git(checkout, "add", ".");
    git(checkout, "commit", "-m", "validated source");
    const source = git(checkout, "rev-parse", "HEAD");
    git(checkout, "init", "--bare", origin);
    git(
      checkout,
      "--git-dir",
      origin,
      "fetch",
      checkout,
      "HEAD:refs/heads/main",
    );
    git(checkout, "remote", "add", "origin", origin);
    git(root, "clone", "--branch", "main", origin, concurrent);
    git(concurrent, "config", "user.name", "Concurrent author");
    git(concurrent, "config", "user.email", "concurrent@example.com");
    await writeFile(
      join(concurrent, "source.txt"),
      "intervening source update\n",
    );
    git(concurrent, "add", ".");
    git(concurrent, "commit", "-m", "intervening update");
    const intervening = git(concurrent, "rev-parse", "HEAD");
    git(
      checkout,
      "--git-dir",
      origin,
      "fetch",
      concurrent,
      "HEAD:refs/heads/main",
    );
    for (const pkg of PACKAGES) {
      await writeFile(
        join(checkout, "packages", pkg, "package.json"),
        '{"version":"0.7.4"}\n',
      );
    }
    await writeFile(
      join(checkout, "bun.lock"),
      "validated candidate lockfile\n",
    );
    const output = join(root, "outputs");
    const options = {
      cwd: checkout,
      env: {
        ...process.env,
        RELEASE_BRANCH: "main",
        RELEASE_TAG: "v0.7.4",
        GITHUB_OUTPUT: output,
      },
      stdio: "pipe" as const,
    };
    const commit = workflow.jobs.commit.steps.find((step) =>
      step.run?.includes('git tag "$RELEASE_TAG"'),
    )?.run;
    if (!commit) throw new Error("Missing release commit step");
    execFileSync("bash", ["-e", "-c", commit], options);
    expect(git(checkout, "--git-dir", origin, "show", "main:source.txt")).toBe(
      "intervening source update",
    );
    expect(
      git(checkout, "--git-dir", origin, "show", "v0.7.4:source.txt"),
    ).toBe("validated source");
    for (const pkg of PACKAGES)
      expect(
        git(
          checkout,
          "--git-dir",
          origin,
          "show",
          `main:packages/${pkg}/package.json`,
        ),
      ).toBe('{"version":"0.7.4"}');
    expect(git(checkout, "--git-dir", origin, "rev-parse", "v0.7.4^")).toBe(
      source,
    );
    expect(
      git(
        checkout,
        "--git-dir",
        origin,
        "merge-base",
        "--is-ancestor",
        intervening,
        "main",
      ),
    ).toBe("");
    const resolve = workflow.jobs.commit.steps.find(
      (step) => step.name === "Resolve validated release commit",
    )?.run;
    if (!resolve) throw new Error("Missing release target step");
    execFileSync("bash", ["-e", "-c", resolve], options);
    expect(await Bun.file(output).text()).toBe(
      `sha=${git(checkout, "rev-parse", "v0.7.4")}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
