import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { generateClientContract } from "./client-contract";
import { loadBrickApp } from "./app-entry";
import { readContractRemotes } from "./polyglot";

/** Generate a client contract without loading Vite or starting a server. */
export async function writeClientContract(
  entryPath: string,
  outputPath?: string,
  /** Where `_brick/contract.json` is (default the working directory). */
  root?: string,
) {
  const entry = resolve(entryPath);
  const output = resolve(outputPath ?? "_brick/contract.ts");
  if (entry === output)
    throw new Error("Brick: contract output must not overwrite the app entry.");
  const app = await loadBrickApp(entry);
  const source = generateClientContract(
    app,
    root
      ? readContractRemotes(app, join(root, "_brick/contract.json"))
      : undefined,
  );
  await writeContractSource(output, source);
  return output;
}

/** Atomically replace changed contracts, preserving timestamps when unchanged. */
export async function writeContractSource(output: string, source: string) {
  const previous = await readFile(output, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (previous !== source) {
    await mkdir(dirname(output), { recursive: true });
    const temporary = join(
      dirname(output),
      `.brick-contract-${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, source, { flag: "wx" });
      await rename(temporary, output);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
