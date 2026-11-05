import { expect, test } from "bun:test";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
};
type Job = {
  permissions?: Record<string, string>;
  "runs-on": string;
  needs?: string | string[];
  if?: string;
  strategy?: { "fail-fast": boolean; matrix: { pkg: string[] } };
  steps: Step[];
};
const workflow: { jobs: Record<string, Job> } = Bun.YAML.parse(
  await Bun.file(
    new URL("../.github/workflows/publish-npm.yml", import.meta.url),
  ).text(),
);
const { prepare, validate, commit, publish, release } = workflow.jobs;
const sdks = workflow.jobs["publish-sdks"];
const PACKAGES = ["core", "crud", "cli", "bullmq-world", "redis-world"];

test("every package must build, typecheck, test, and pack before publishing, with the release commit last", () => {
  expect(validate!.strategy?.matrix.pkg).toEqual(PACKAGES);
  expect(validate!.strategy?.["fail-fast"]).toBe(false);
  const commands = validate!.steps.map((step) => step.run ?? "").join("\n");
  expect(commands).toMatch(/^bun run build$/m);
  expect(commands).toContain("bun run build:worlds");
  expect(commands).toContain(
    "for pkg in core crud cli bullmq-world redis-world;",
  );
  expect(commands).toContain(
    "bun run --filter @brickkit/${{ matrix.pkg }} typecheck",
  );
  expect(commands).toContain("bun test packages/${{ matrix.pkg }}");
  expect(commands).toContain("npm pack --ignore-scripts");
  expect(commit!.needs).toContain("validate");
  expect(publish!.needs).toContain("validate");
  expect(publish!.needs).not.toContain("commit");
  expect(commit!.needs).toContain("publish");
  expect(commit!.if).not.toContain("always()");
  expect(publish!.if).not.toContain("always()");
  expect(release!.needs).toContain("publish");
});

test("worlds are staged, built, tested with vitest, and committed with the other packages", () => {
  const manifests =
    prepare!.steps.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    )?.with?.path ?? "";
  const committed = commit!.steps.map((step) => step.run ?? "").join("\n");
  for (const pkg of PACKAGES) {
    expect(manifests).toContain(`packages/${pkg}/package.json`);
    expect(committed).toContain(`packages/${pkg}/package.json`);
  }
  const test = validate!.steps.find(
    (step) => step.name === "Test world package",
  );
  expect(test?.if).toContain("endsWith(matrix.pkg, '-world')");
  expect(test?.run).toBe("bun run --filter @brickkit/${{ matrix.pkg }} test");
});

test("candidate preparation cannot commit or publish, and dry runs stop after validation", () => {
  const commands = prepare!.steps.map((step) => step.run ?? "").join("\n");
  expect(commands).toContain('bun run release "$RELEASE_BUMP" --prepare');
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
  expect(commands).toContain('npm publish "$RUNNER_TEMP/package/"*.tgz');
  expect(commands).not.toMatch(/bun (test|run build|install)/);
  expect(publish!.strategy?.matrix.pkg).toEqual(PACKAGES);
});

test("release jobs use Node 24 actions and an explicit Ubuntu runner", () => {
  for (const job of Object.values(workflow.jobs)) {
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    for (const step of job.steps) {
      if (step.uses?.startsWith("actions/checkout@"))
        expect([
          "actions/checkout@v7",
          // publish-sdks pins it: it holds a write token and the crates.io token.
          "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        ]).toContain(step.uses);
      if (step.uses?.startsWith("actions/setup-node@"))
        expect(step.uses).toBe("actions/setup-node@v7");
      if (step.uses?.startsWith("actions/upload-artifact@"))
        expect(step.uses).toBe("actions/upload-artifact@v7");
      if (step.uses?.startsWith("actions/download-artifact@"))
        expect(step.uses).toBe("actions/download-artifact@v8");
    }
  }
});

test("a package publishes only after the @brickkit versions it depends on", () => {
  const names = publish!.steps.map((step) => step.name);
  const wait = names.indexOf("Wait for the @brickkit packages it depends on");
  expect(wait).toBeGreaterThan(-1);
  expect(wait).toBeLessThan(names.indexOf("Publish the validated tarball"));
  expect(publish!.steps[wait]!.run).toContain(
    'npm view "$dep@$PACKAGE_VERSION"',
  );
});

test("the Rust crate and the Go module ship after npm, from the release commit", () => {
  expect(sdks!.needs).toEqual(["prepare", "publish", "commit"]);
  expect(sdks!.if).toContain("inputs.dry_run != true");
  expect(sdks!.if).toContain("github.event_name != 'pull_request'");
  const names = sdks!.steps.map((step) => step.name ?? step.uses ?? "");
  // A missing token fails first, with a message, and before anything ships.
  expect(names[0]).toBe("Require the crates.io token");
  expect(sdks!.steps[0]!.run).toContain("::error::The CARGO_REGISTRY_TOKEN");
  expect(
    prepare!.steps.find(
      (step) => step.name === "Require the crates.io token for the Rust SDK",
    )?.run,
  ).toContain("::error::The CARGO_REGISTRY_TOKEN");
  const commands = sdks!.steps.map((step) => step.run ?? "").join("\n");
  expect(commands).toContain("cargo publish -p brickkit --locked");
  expect(commands).toContain('go_tag="sdk/go/$RELEASE_TAG"');
  expect(names.indexOf("Publish the brickkit crate")).toBeLessThan(
    names.indexOf("Tag the Go module"),
  );
  expect(
    sdks!.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with
      ?.ref,
  ).toBe("${{ needs.commit.outputs.sha }}");
  const committed = commit!.steps.map((step) => step.run ?? "").join("\n");
  expect(committed).toContain("sdk/rust/brick/Cargo.toml sdk/rust/Cargo.lock");
});
