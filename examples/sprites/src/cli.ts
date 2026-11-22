#!/usr/bin/env bun
/**
 * Stack a bundled sample or a PNG sheet.
 *
 * In process (the default) this calls the action directly.
 * With --url it uses the typed HTTP client against a running server.
 *
 *   bun src/cli.ts car
 *   bun src/cli.ts tree --round --slices 28 --out ./sprite-out
 *   bun src/cli.ts ./sheet.png --url http://localhost:4310
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBrickClient, useService } from "@brickkit/core";
import { sprites, stack, type StackResult } from "./sprites";
import type { SampleName } from "./samples";

interface Flags {
  sample?: SampleName;
  sheetPath?: string;
  slices?: number;
  round?: boolean;
  palette?: number;
  shade?: number;
  order?: "reading" | "auto";
  sideNose?: "left" | "right";
  topNose?: "auto" | "up" | "down";
  out: string;
  url?: string;
}

function help(): never {
  console.log(`sprite stack

Usage
  bun src/cli.ts <car|tree|sheet.png> [options]

Options
  --slices <n>     Layer count. 0 keeps the sheet height.
  --round          Lathe each solid layer into an ellipse.
  --palette <n>    Shared palette size. 0 keeps every color.
  --shade <0-1>    Darken side faces toward the ground.
  --order <mode>   reading (top, side, front, back) or auto.
  --side-nose <d>  left or right.
  --top-nose <d>   auto, up, or down.
  --out <dir>      Where to write strip.png and sheet.png.
  --url <origin>   Call a running server with the typed client.
`);
  process.exit(0);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parse(argv: string[]): Flags {
  const flags: Flags = { out: "sprite-out" };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const take = () => {
      const value = argv[++i];
      if (value === undefined) fail(`Missing value for ${arg}`);
      return value;
    };
    if (arg === "--help" || arg === "-h") help();
    else if (arg === "--round") flags.round = true;
    else if (arg === "--slices") flags.slices = Number(take());
    else if (arg === "--palette") flags.palette = Number(take());
    else if (arg === "--shade") flags.shade = Number(take());
    else if (arg === "--order") flags.order = take() as Flags["order"];
    else if (arg === "--side-nose")
      flags.sideNose = take() as Flags["sideNose"];
    else if (arg === "--top-nose") flags.topNose = take() as Flags["topNose"];
    else if (arg === "--out") flags.out = take();
    else if (arg === "--url") flags.url = take();
    else if (arg.startsWith("--")) fail(`Unknown option ${arg}`);
    else rest.push(arg);
  }
  const target = rest[0];
  if (!target) fail("Pass car, tree, or a PNG path. Try --help.");
  if (target === "car" || target === "tree") flags.sample = target;
  else flags.sheetPath = target;
  return flags;
}

async function main() {
  const flags = parse(process.argv.slice(2));
  const sheet = flags.sheetPath
    ? Buffer.from(await Bun.file(flags.sheetPath).arrayBuffer()).toString(
        "base64",
      )
    : undefined;
  const input = {
    ...(flags.sample ? { sample: flags.sample } : {}),
    ...(sheet ? { sheet } : {}),
    ...(flags.slices !== undefined ? { slices: flags.slices } : {}),
    ...(flags.round ? { round: true } : {}),
    ...(flags.palette !== undefined ? { palette: flags.palette } : {}),
    ...(flags.shade !== undefined ? { shade: flags.shade } : {}),
    ...(flags.order ? { order: flags.order } : {}),
    ...(flags.sideNose ? { sideNose: flags.sideNose } : {}),
    ...(flags.topNose ? { topNose: flags.topNose } : {}),
  };
  let result: StackResult;
  if (flags.url) {
    const api = createBrickClient<{ sprites: { stack: typeof stack } }>({
      baseUrl: flags.url,
    });
    result = await api.sprites.stack(input);
  } else {
    const api = useService(sprites);
    result = await api.stack(input);
  }
  const dir = resolve(flags.out);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "strip.png"), Buffer.from(result.stripPng, "base64"));
  writeFileSync(join(dir, "sheet.png"), Buffer.from(result.sheetPng, "base64"));
  console.log(
    `${result.slices} slices of ${result.sliceWidth}x${result.sliceHeight}  ${dir}/strip.png`,
  );
  console.log(
    `${result.directions} frames of ${result.frameWidth}x${result.frameHeight}  ${dir}/sheet.png`,
  );
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
