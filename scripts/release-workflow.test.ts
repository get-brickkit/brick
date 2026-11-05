import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
};
type Job = {
  "runs-on": string;
  needs?: string | string[];
  if?: string;
  strategy?: { "fail-fast": boolean; matrix: { pkg: string } };
  steps: Step[];
};
const ROOT = join(import.meta.dir, "..");
const readWorkflow = async (
  name: string,
): Promise<{ jobs: Record<string, Job> }> =>
  Bun.YAML.parse(
    await Bun.file(join(ROOT, ".github/workflows", name)).text(),
  ) as { jobs: Record<string, Job> };
const workflow = await readWorkflow("publish-npm.yml");
const { prepare, validate, commit, publish, release } = workflow.jobs;
const MATRIX = "${{ fromJSON(needs.prepare.outputs.packages) }}";

// Read independently of scripts/published-packages.ts: every non-private package.
const PACKAGES: string[] = [];
for (const dir of (await readdir(join(ROOT, "packages"))).sort()) {
  const manifest = Bun.file(join(ROOT, "packages", dir, "package.json"));
  if ((await manifest.exists()) && (await manifest.json()).private !== true)
    PACKAGES.push(dir);
}

test("the release matrix is every non-private package, in lockstep", async () => {
  const resolve = prepare!.steps.find(
    (step) => step.name === "Resolve candidate",
  );
  const dir = await mkdtemp(join(tmpdir(), "brick-release-workflow-"));
  try {
    const output = join(dir, "outputs");
    execFileSync("bash", ["-e", "-c", resolve!.run!], {
      cwd: ROOT,
      env: { ...process.env, GITHUB_OUTPUT: output, GITHUB_REF_TYPE: "branch" },
      stdio: "pipe",
    });
    const outputs = Object.fromEntries(
      (await Bun.file(output).text())
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
    expect(JSON.parse(outputs.packages)).toEqual(PACKAGES);
    expect(PACKAGES).not.toContain("workflow-inspector");
    const { version } = await Bun.file(
      join(ROOT, "packages", PACKAGES[0]!, "package.json"),
    ).json();
    expect(outputs.tag).toBe(`v${version}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("every package must build, typecheck, test, and pack before publishing, with the release commit last", () => {
  expect(validate!.strategy?.matrix.pkg).toBe(MATRIX);
  expect(validate!.strategy?.["fail-fast"]).toBe(false);
  const commands = validate!.steps.map((step) => step.run ?? "").join("\n");
  for (const command of [/\bbuild\b/, /\btypecheck\b/, /\btest\b/, /npm pack/])
    expect(commands).toMatch(command);
  expect(commit!.needs).toContain("validate");
  expect(publish!.needs).toContain("validate");
  expect(publish!.needs).not.toContain("commit");
  expect(commit!.needs).toContain("publish");
  expect(commit!.if).not.toContain("always()");
  expect(publish!.if).not.toContain("always()");
  expect(release!.needs).toContain("publish");
});

test("every package is staged and committed with the others", () => {
  const manifests =
    prepare!.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    )?.with?.path ?? "";
  const patterns = manifests.split("\n").filter(Boolean);
  for (const pkg of PACKAGES)
    expect(
      patterns.some((pattern) =>
        new Bun.Glob(pattern).match(`packages/${pkg}/package.json`),
      ),
    ).toBe(true);
});

test("every published package has its own test script", async () => {
  for (const pkg of PACKAGES)
    expect([
      pkg,
      typeof (
        await Bun.file(join(ROOT, "packages", pkg, "package.json")).json()
      ).scripts?.test,
    ]).toEqual([pkg, "string"]);
});

test("candidate preparation cannot commit or publish, and dry runs stop after validation", () => {
  const commands = prepare!.steps.map((step) => step.run ?? "").join("\n");
  expect(commands).toMatch(/bun run release .*--prepare/);
  expect(commands).not.toMatch(/git (commit|tag|push)|npm publish/);
  expect(commit!.if).toContain("inputs.dry_run != true");
  expect(publish!.if).toContain("inputs.dry_run != true");
  expect(commit!.if).toContain("github.event_name != 'pull_request'");
  expect(publish!.if).toContain("github.event_name != 'pull_request'");
  expect(
    prepare!.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
      ?.with?.ref,
  ).toBe("${{ github.sha }}");
});

test("publishing uses the exact checked tarballs without rerunning tests or builds", () => {
  const upload = validate!.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  const download = publish!.steps.find(
    (step) =>
      step.uses?.startsWith("actions/download-artifact@") &&
      step.with?.name === "package-${{ matrix.pkg }}",
  );
  expect(upload?.with?.name).toBe("package-${{ matrix.pkg }}");
  expect(download?.with?.name).toBe(upload?.with?.name);
  const commands = publish!.steps.map((step) => step.run ?? "").join("\n");
  expect(commands).toMatch(/npm publish \S*\.tgz/);
  expect(commands).not.toMatch(/bun (test|run build|install)/);
  expect(publish!.strategy?.matrix.pkg).toBe(MATRIX);
});

test("release jobs pin actions to commits, share CI's pins and Bun, and use an explicit Ubuntu runner", async () => {
  const ci = await readWorkflow("ci.yml");
  const ciUses = Object.values(ci.jobs).flatMap((job) =>
    job.steps.flatMap((step) => (step.uses ? [step.uses] : [])),
  );
  for (const job of Object.values(workflow.jobs)) {
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    for (const step of job.steps) {
      const action = step.uses?.split("@")[0];
      const ciPin = ciUses.find((uses) => uses.split("@")[0] === action);
      if (ciPin) expect(step.uses).toBe(ciPin);
      if (action === "oven-sh/setup-bun")
        expect(step.with?.["bun-version-file"]).toBe(".bun-version");
      // Pinned to a commit: these jobs hold the npm token and id-token: write.
      if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  }
});

test("a package publishes only after the @brickkit versions it depends on", () => {
  const runs = publish!.steps.map((step) => step.run ?? "");
  const wait = runs.findIndex((run) => /npm view "\$dep@/.test(run));
  expect(wait).toBeGreaterThan(-1);
  expect(wait).toBeLessThan(runs.findIndex((run) => /npm publish/.test(run)));
});
