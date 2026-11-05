import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

it("bundles the lazy SQLite adapter without another adapter import", async () => {
  const deploy = await mkdtemp(join(tmpdir(), "brick-sqlite-deploy-"));
  try {
    const entry = join(deploy, "entry.ts");
    const sqlite = resolve(import.meta.dir, "../src/db/sqlite.ts");
    await Bun.write(
      entry,
      `import { createSQLiteDatabase } from ${JSON.stringify(sqlite)};
       const db = createSQLiteDatabase();
       console.log(JSON.stringify(db.$client.query("SELECT 42 AS answer").get()));
       db.$client.close();`,
    );
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      outdir: deploy,
      naming: "server.js",
    });
    expect(result.success).toBe(true);
    await rm(entry);
    const child = Bun.spawn([process.execPath, join(deploy, "server.js")], {
      cwd: deploy,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ answer: 42 });
  } finally {
    await rm(deploy, { recursive: true, force: true });
  }
}, 20000);
