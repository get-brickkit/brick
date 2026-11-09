import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #109: a compiled server must run the workflows of an app whose world is set
// only at run time, from a working directory that holds no source and cannot
// be written to, without building anything there.
const REDIS_URL = process.env.REDIS_URL;
const root = join(import.meta.dir, "..");
const bin = join(root, "node_modules", "@brickkit", "cli", "dist", "bin.js");
// In the project, where the packages it needs at run time are installed.
const built = join(root, "dist", "compiled-test");
const server = join(built, "server.js");
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "brick-compiled-")));
const cwd = join(scratch, "run");
mkdirSync(cwd);
chmodSync(cwd, 0o555);

setDefaultTimeout(60_000);
afterAll(() => {
  chmodSync(cwd, 0o755);
  rmSync(scratch, { recursive: true, force: true });
  rmSync(built, { recursive: true, force: true });
});

describe("a compiled server with workflows (#109)", () => {
  it("brick build ships the workflows of an app that declares them only at run time, and exits", async () => {
    const env = { ...process.env };
    delete env.COMPILED_APP_REDIS_URL;
    const build = Bun.spawn(
      [
        process.execPath,
        bin,
        "build",
        "test/fixtures/compiled-app.ts",
        "--outdir",
        built,
      ],
      { cwd: root, env, stdout: "pipe", stderr: "pipe" },
    );
    // The fixture's interval would keep a build that never exits alive.
    const timer = setTimeout(() => build.kill(), 30_000);
    const code = await build.exited;
    clearTimeout(timer);
    expect(code, await new Response(build.stderr).text()).toBe(0);
    expect(existsSync(join(built, ".well-known/workflow/v1/flow.mjs"))).toBe(
      true,
    );
    // Transformed: the listener's workflow carries its id.
    expect(readFileSync(server, "utf8")).toContain(
      "workflow//./test/fixtures/compiled-workflow//recordGreeting",
    );
  });

  // --no-install: from a folder without node_modules, Bun would otherwise
  // install the SDK's dependencies afresh instead of using the project's.
  for (const [how, command] of [
    ["bun server.js", [process.execPath, "--no-install", server]],
    [
      "brick start server.js",
      [process.execPath, "--no-install", bin, "start", server],
    ],
  ] as const)
    it.skipIf(!REDIS_URL)(
      `runs the shipped workflow under ${how}`,
      async () => {
        const out = join(scratch, `${how.split(" ")[0]}.out`);
        const probe = Bun.serve({ port: 0, fetch: () => new Response() });
        const port = probe.port;
        await probe.stop();
        const child = Bun.spawn([...command], {
          cwd,
          env: {
            ...process.env,
            PORT: String(port),
            COMPILED_APP_REDIS_URL: REDIS_URL,
            COMPILED_APP_OUT: out,
          },
          stdout: "inherit",
          stderr: "inherit",
        });
        try {
          const base = `http://localhost:${port}`;
          let deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            const ok = await fetch(`${base}/api/greetings/request`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            }).then(
              (response) => response.ok,
              () => false,
            );
            if (ok) break;
            await Bun.sleep(100);
          }
          deadline = Date.now() + 15_000;
          while (!existsSync(out) && Date.now() < deadline) await Bun.sleep(50);
          expect(existsSync(out) && readFileSync(out, "utf8")).toBe("done");
        } finally {
          child.kill();
          await child.exited;
        }
      },
    );
});
