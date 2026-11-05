import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { generateClientContract } from "./client-contract";
import { requireBrickApp } from "@brickkit/core";
import { loadBrickApp } from "./app-entry";

/** Generate a client contract without loading Vite or starting a server. */
export async function writeClientContract(entry: string, output: string) {
  checkContractOutput(entry, output);
  await writeAppContract(await loadBrickApp(entry), entry, output);
  return resolve(output);
}

function checkContractOutput(entry: string, output: string) {
  if (resolve(output) === resolve(entry))
    throw new Error("Brick: contract output must not overwrite the app entry.");
}

/** Write the browser contract of the entry's `app` to `output`. */
export async function writeAppContract(
  app: unknown,
  entry: string,
  output: string,
) {
  checkContractOutput(entry, output);
  await writeContractSource(
    resolve(output),
    generateClientContract(requireBrickApp(app)),
  );
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
