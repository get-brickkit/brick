import { afterEach, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveEffect } from "../src/build";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

// An app folder whose node_modules holds a real copy of effect.
async function app(manifest: object) {
  const dir = await mkdtemp(join(tmpdir(), "brick-effect-"));
  dirs.push(dir);
  await Bun.write(join(dir, "package.json"), JSON.stringify(manifest));
  await mkdir(join(dir, "node_modules"), { recursive: true });
  await symlink(
    resolve(import.meta.dir, "../node_modules/effect"),
    join(dir, "node_modules", "effect"),
  );
  await Bun.write(join(dir, "src/app.ts"), "export default {};");
  return join(dir, "src/app.ts");
}

it("bundles effect for an app that declares it", async () => {
  const entry = await app({ dependencies: { effect: "4.1.5" } });
  expect(resolveEffect(entry)).toContain("effect");
});

it("leaves effect out when the app does not declare it, even if it resolves", async () => {
  const entry = await app({ dependencies: {} });
  expect(Bun.resolveSync("effect", dirname(entry))).toBeTruthy();
  expect(resolveEffect(entry)).toBeUndefined();
});
