import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadBrickApp } from "../src/app-entry";
import { buildApplication } from "../src/build";
import type { BrickApp } from "@brickkit/core";
import {
  buildAppWorkflows,
  buildWorkflows,
  registerWorkflowTransform,
} from "../src/workflows";

const fixture = join(import.meta.dir, "fixtures", "workflow-app");
const WORKFLOW_ID = "workflow//./src/hello//hello";

/**
 * A copy of the fixture, so builds and edits stay out of the repository. Outside
 * it, this package's dependencies resolve from a node_modules link beside it.
 */
function copyFixture(): string {
  const copy = join(
    realpathSync(mkdtempSync(join(tmpdir(), "brick-workflow-"))),
    "app",
  );
  cpSync(fixture, copy, {
    recursive: true,
    filter: (path) => !/[\\/](\.well-known|dist)$/.test(path),
  });
  symlinkSync(
    join(import.meta.dir, "..", "node_modules"),
    join(dirname(copy), "node_modules"),
  );
  return copy;
}

const root = copyFixture();
const dir = join(root, ".well-known", "workflow", "v1");
afterAll(() => rmSync(dirname(root), { recursive: true, force: true }));

describe("workflow build and transform", () => {
  it("does nothing, and says so, in a project without the Workflow SDK", async () => {
    const bare = mkdtempSync(join(tmpdir(), "brick-no-sdk-"));
    try {
      expect(await registerWorkflowTransform(bare)).toBe(false);
      await expect(buildWorkflows({ root: bare })).rejects.toThrow(
        "bun add -d @workflow/builders",
      );
    } finally {
      rmSync(bare, { recursive: true });
    }
  });

  it("builds the bundle and a manifest that names the workflow", async () => {
    await buildWorkflows({ root });

    expect(existsSync(join(dir, "flow.mjs"))).toBe(true);
    const manifest = JSON.parse(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    );
    expect(manifest.workflows["src/hello.ts"].hello.workflowId).toBe(
      WORKFLOW_ID,
    );
    expect(manifest.steps["src/hello.ts"].greet.stepId).toBe(
      "step//./src/hello//greet",
    );
  });

  it("gives a workflow the id the bundle knows, and registers its steps", async () => {
    // Other test files may have registered the transform for their own root.
    expect(await registerWorkflowTransform(root)).toBe(true);
    const { hello } = await import(join(root, "src", "hello.ts"));

    expect((hello as { workflowId?: string }).workflowId).toBe(WORKFLOW_ID);
    const steps = (globalThis as Record<symbol, unknown>)[
      Symbol.for("@workflow/core//registeredSteps")
    ] as Map<string, unknown>;
    expect(steps.has("step//./src/hello//greet")).toBe(true);
  });

  it("loads every other file as Bun would: require() works, and JSX in .js", async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures", "workflow-transform", "check.ts"),
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    const jsx = (tag: string) => ({ tag, props: null, children: ["hi"] });
    expect(JSON.parse(output)).toEqual({
      installed: true,
      ts: { plain: 1 },
      cts: { plain: 1 },
      jsx: jsx("p"),
      // A file with a directive goes through SWC, which leaves its JSX.
      step: jsx("b"),
      workflowId: WORKFLOW_ID,
    });
  });

  it("leaves the generated bundle alone when it is loaded", async () => {
    // The bundle holds the directives as text inside the SDK's own code. Transforming
    // it failed with "Classes using use step methods must be declared at the top level".
    const bundle = await import(pathToFileURL(join(dir, "flow.mjs")).href);
    expect(typeof bundle.POST).toBe("function");
  });
});

describe("apps with workflows", () => {
  const entry = join(root, "src", "app.ts");

  it("releases the world when an app is only inspected", async () => {
    const { world } = await import(entry);
    const before = world.closed;
    await loadBrickApp(entry);
    expect(world.closed).toBeGreaterThan(before);
  });

  it("brick build transforms the workflows, builds the bundle, and starts events in the server", async () => {
    rmSync(join(root, ".well-known"), { recursive: true, force: true });
    const outdir = join(root, "dist", "brick");
    // The build replaces only its bundle under .well-known.
    mkdirSync(join(outdir, ".well-known"), { recursive: true });
    writeFileSync(join(outdir, ".well-known", "security.txt"), "x");
    const result = await buildApplication({ entry, outdir });
    expect(result.workflows).toBe(join(outdir, ".well-known/workflow/v1"));
    expect(existsSync(join(result.workflows!, "flow.mjs"))).toBe(true);
    expect(existsSync(join(outdir, ".well-known", "security.txt"))).toBe(true);
    const server = readFileSync(join(outdir, "server.js"), "utf8");
    expect(server).toContain(WORKFLOW_ID);
    expect(server).toContain("events?.start()");
    // A second Ctrl-C exits even while a delivery hangs.
    expect(server).toContain('process.exit(signal === "SIGINT" ? 130 : 143)');
    // The workflow plugin must not keep the AOT plugin from the entry: without
    // the precompiled handlers every route answers 500.
    expect(server).toContain("Compiled.register(");
    expect(existsSync(join(dir, "flow.mjs"))).toBe(true);
  });

  it("brick build neither builds nor ships workflows for a project without any", async () => {
    const plain = copyFixture();
    try {
      rmSync(join(plain, "src", "hello.ts"));
      writeFileSync(
        join(plain, "src", "app.ts"),
        'import { brick } from "@brickkit/core";\nexport default brick({ requestLogging: false, docs: false });\n',
      );
      const cwd = process.cwd();
      process.chdir(plain);
      try {
        const result = await buildApplication({
          entry: join(plain, "src", "app.ts"),
          outdir: join(plain, "dist", "brick"),
        });
        expect(result.workflows).toBeUndefined();
      } finally {
        process.chdir(cwd);
      }
      expect(existsSync(join(plain, ".well-known"))).toBe(false);
    } finally {
      rmSync(dirname(plain), { recursive: true, force: true });
    }
  });

  it("refuses an app whose workflows root is not the one its files were transformed from", async () => {
    await registerWorkflowTransform(root);
    const app = { events: { workflows: { root: tmpdir() } } } as BrickApp;
    await expect(buildAppWorkflows(app)).rejects.toThrow(
      "is not the folder its workflow files were transformed from",
    );
  });
});

describe("reusing the bundle", () => {
  // Its own copy: the edits below would change what the tests above see. The
  // tests are steps of one scenario: each starts from the state the last left.
  const copy = copyFixture();
  const flow = join(copy, ".well-known", "workflow", "v1", "flow.mjs");
  const steps = join(
    copy,
    ".well-known",
    "workflow",
    "v1",
    "__step_registrations.mjs",
  );
  const manifest = () =>
    JSON.parse(
      readFileSync(
        join(copy, ".well-known", "workflow", "v1", "manifest.json"),
        "utf8",
      ),
    );
  const write = (file: string, text: string) => {
    writeFileSync(join(copy, "src", file), text);
    // A file written in the millisecond a build starts counts as changed while
    // it ran, and the build keeps no state to reuse.
    Bun.sleepSync(2);
  };
  const reuse = () => buildWorkflows({ root: copy, reuse: true });

  beforeAll(() => {
    mkdirSync(join(copy, "node_modules", "@tsconfig", "test"), {
      recursive: true,
    });
    write("shared.ts", 'export const suffix = "!";\n');
    write("data.json", '{ "greeting": "hi" }\n');
    write(
      "hello.ts",
      `import { suffix } from "./shared";
import data from "./data.json";
export async function hello(name: string) {
  "use workflow";
  return (await greet(name)) + suffix;
}

async function greet(name: string) {
  "use step";
  return \`\${data.greeting} \${name}\`;
}
`,
    );
  });
  afterAll(() => rmSync(dirname(copy), { recursive: true, force: true }));

  it("builds when there is nothing to reuse, and keeps the bundle after that", async () => {
    expect(await reuse()).toBe(true);
    const before = statSync(flow).mtimeMs;
    expect(await reuse()).toBe(false);
    expect(statSync(flow).mtimeMs).toBe(before);
  });

  it("keeps the bundle when a file it does not hold changes", async () => {
    write("app.ts", "export const unrelated = 1;\n");
    expect(await reuse()).toBe(false);
  });

  it("rebuilds when a file the workflow imports changes", async () => {
    write("shared.ts", 'export const suffix = "!!!";\n');
    expect(await reuse()).toBe(true);
    expect(readFileSync(flow, "utf8")).toContain("!!!");
    expect(await reuse()).toBe(false);
  });

  it("rebuilds when a JSON file a step imports changes", async () => {
    write("data.json", '{ "greeting": "hey" }\n');
    expect(await reuse()).toBe(true);
    expect(readFileSync(steps, "utf8")).toContain('"hey"');
    expect(await reuse()).toBe(false);
  });

  it("rebuilds when a file that was left out comes to hold a step", async () => {
    write(
      "app.ts",
      'export async function ping() {\n  "use step";\n  return 1;\n}\n',
    );
    expect(await reuse()).toBe(true);
    expect(manifest().steps["src/app.ts"].ping).toBeDefined();
  });

  it("rebuilds when a file is added", async () => {
    write("extra.ts", "export const extra = 1;\n");
    expect(await reuse()).toBe(true);
  });

  it("rebuilds when the bundle is gone, and when reuse is not asked for", async () => {
    rmSync(flow);
    expect(await reuse()).toBe(true);
    expect(existsSync(flow)).toBe(true);
    expect(await buildWorkflows({ root: copy })).toBe(true);
  });

  const config = (file: string, text: string) => {
    writeFileSync(join(copy, file), text);
    Bun.sleepSync(2);
  };

  it("tracks a two-level JSONC tsconfig extends chain", async () => {
    config("tsconfig.json", '{ "extends": "./base.json" }');
    config("base.json", '{ // intermediate\n "extends": "./parent", }');
    config("parent.json", '{ "compilerOptions": { "strict": true, }, }');
    try {
      await buildWorkflows({ root: copy });
      expect(await reuse()).toBe(false);
      config("parent.json", '{ "compilerOptions": { "strict": false } }');
      expect(await reuse()).toBe(true);
      expect(await reuse()).toBe(false);
      config("base.json", '{ "extends": "./parent", "compilerOptions": {} }');
      expect(await reuse()).toBe(true);
    } finally {
      for (const file of ["tsconfig.json", "base.json", "parent.json"])
        rmSync(join(copy, file), { force: true });
    }
  });

  it("tracks package configs and every entry in an extends array", async () => {
    config(
      "node_modules/@tsconfig/test/package.json",
      '{ "name": "@tsconfig/test" }',
    );
    config(
      "node_modules/@tsconfig/test/tsconfig.json",
      '{ "compilerOptions": { "strict": true } }',
    );
    config("base.json", "{}");
    config("tsconfig.json", '{ "extends": ["@tsconfig/test", "./base.json"] }');
    try {
      await buildWorkflows({ root: copy });
      expect(await reuse()).toBe(false);
      config(
        "node_modules/@tsconfig/test/tsconfig.json",
        '{ "compilerOptions": { "strict": false } }',
      );
      expect(await reuse()).toBe(true);
      expect(await reuse()).toBe(false);
      config("base.json", '{ "compilerOptions": { "strict": true } }');
      expect(await reuse()).toBe(true);
    } finally {
      for (const file of ["tsconfig.json", "base.json", "node_modules"])
        rmSync(join(copy, file), { recursive: true, force: true });
    }
  });

  const configPackage = (name: string, manifest: object, tsconfig?: string) => {
    mkdirSync(join(copy, "node_modules", name), { recursive: true });
    config(`node_modules/${name}/package.json`, JSON.stringify(manifest));
    config(`node_modules/${name}/index.js`, "module.exports = {};\n");
    if (tsconfig) config(`node_modules/${name}/tsconfig.json`, tsconfig);
  };

  for (const [kind, manifest] of [
    ["main", { main: "index.js" }],
    ["exports", { exports: { "./package.json": "./package.json" } }],
  ] as const)
    it(`tracks a package's tsconfig.json, despite its ${kind}`, async () => {
      configPackage(`brick-${kind}`, manifest, '{ "compilerOptions": {} }');
      config("tsconfig.json", `{ "extends": "brick-${kind}" }`);
      try {
        await buildWorkflows({ root: copy });
        expect(await reuse()).toBe(false);
        config(
          `node_modules/brick-${kind}/tsconfig.json`,
          '{ "compilerOptions": { "strict": true } }',
        );
        expect(await reuse()).toBe(true);
      } finally {
        for (const file of ["tsconfig.json", "node_modules"])
          rmSync(join(copy, file), { recursive: true, force: true });
      }
    });

  it("ignores a package parent that has no tsconfig.json", async () => {
    configPackage("brick-js", { main: "index.js" });
    config("tsconfig.json", '{ "extends": "brick-js" }');
    try {
      await buildWorkflows({ root: copy });
      expect(await reuse()).toBe(false);
      config("node_modules/brick-js/index.js", "module.exports = 1;\n");
      expect(await reuse()).toBe(false);
    } finally {
      for (const file of ["tsconfig.json", "node_modules"])
        rmSync(join(copy, file), { recursive: true, force: true });
    }
  });

  it("tolerates a missing tsconfig parent and notices when it appears", async () => {
    config("tsconfig.json", '{ "extends": "./missing.json" }');
    try {
      await buildWorkflows({ root: copy });
      expect(await reuse()).toBe(false);
      config("missing.json", "{}");
      expect(await reuse()).toBe(true);
      expect(await reuse()).toBe(false);
    } finally {
      for (const file of ["tsconfig.json", "missing.json"])
        rmSync(join(copy, file), { force: true });
    }
  });
});
