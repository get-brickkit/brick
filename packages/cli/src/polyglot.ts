import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  kebabCase,
  type ActionErrorDefinition,
  type BrickApp,
  startRemoteServices,
  type RemoteProcesses,
  type RemoteService,
} from "@brickkit/core";
import { generateClientContract } from "./client-contract";
import { writeContractSource } from "./client-contract-file";
import { loadBrickApp } from "./app-entry";

/**
 * One service in `_brick/contract.json`: what `--brick-manifest` prints, for every language.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export interface ServiceManifest {
  name: string;
  language: "ts" | "go" | "rust";
  actions: { name: string; input?: unknown; output?: unknown }[];
  errors: Record<string, { status: number; message: string }>;
}

/** @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release. */
export interface PolyglotContract {
  version: 1;
  services: ServiceManifest[];
}

const run = promisify(execFile);

// The process groups of the manifest reads in flight, all killed by one signal
// handler: Ctrl+C reaches only this process, not their own groups.
const manifestGroups = new Set<number>();
const killGroups = (groups: Iterable<number>) => {
  for (const group of groups)
    try {
      process.kill(-group, "SIGKILL");
    } catch {}
};
const onManifestSignal = (signal: NodeJS.Signals) => {
  killGroups(manifestGroups);
  process.exit(signal === "SIGINT" ? 130 : 143);
};
function manifestGroup(group: number, running: boolean) {
  if (running) manifestGroups.add(group);
  else manifestGroups.delete(group);
  const listening = process.listeners("SIGINT").includes(onManifestSignal);
  if (manifestGroups.size && !listening) {
    process.on("SIGINT", onManifestSignal);
    process.on("SIGTERM", onManifestSignal);
  } else if (!manifestGroups.size && listening) {
    process.off("SIGINT", onManifestSignal);
    process.off("SIGTERM", onManifestSignal);
  }
}

/**
 * Run a remote service's `dev` command with `BRICK_MANIFEST=1` and read the manifest it prints.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export async function readRemoteManifest(
  remote: RemoteService,
  cwd = process.cwd(),
): Promise<ServiceManifest> {
  const options = {
    cwd: resolve(cwd, remote.options.dir),
    env: { ...process.env, BRICK_MANIFEST: "1" },
    maxBuffer: 64 * 1024 * 1024,
    // Its own process group, so a timeout stops `go run` and the server it
    // started. execFile passes it to spawn; its types leave it out.
    detached: true,
  };
  const pending = run("/bin/sh", ["-c", remote.options.dev], options);
  const group = pending.child.pid!;
  manifestGroup(group, true);
  // A service whose SDK ignores BRICK_MANIFEST would serve forever.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroups([group]);
  }, 120_000);
  const { stdout } = await pending
    .catch((error: Error & { stderr?: string }) => {
      throw new Error(
        `Brick: could not read the manifest of "${remote.name}" (${remote.options.dev} in ${remote.options.dir}): ${timedOut ? "no manifest within 120s" : error.stderr || error.message}`,
      );
    })
    .finally(() => {
      clearTimeout(timer);
      manifestGroup(group, false);
    });
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let manifest: ServiceManifest;
  try {
    manifest = JSON.parse(line) as ServiceManifest;
  } catch {
    throw new Error(
      `Brick: the manifest of "${remote.name}" (${remote.options.dev} in ${remote.options.dir}) is not JSON: its last line was ${JSON.stringify(line)}`,
    );
  }
  if (manifest.name !== remote.name)
    throw new Error(
      `Brick: ${remote.options.dir} serves "${manifest.name}", but its remoteService is named "${remote.name}".`,
    );
  return manifest;
}

/** The TS services of the app, as manifests: their actions' TypeBox schemas are JSON Schema. */
export function tsManifests(app: BrickApp): ServiceManifest[] {
  return app.definition.services.map((service) => {
    const errors: ServiceManifest["errors"] = {};
    const actions = service.listActions().map((action) => {
      const declared: Record<string, ActionErrorDefinition> =
        action.config.errors ?? {};
      for (const [code, def] of Object.entries(declared))
        errors[code] = { status: def.status ?? 400, message: def.message };
      const { input, output } = action.config;
      return {
        name: action.name,
        ...(input ? { input: JSON.parse(JSON.stringify(input)) } : {}),
        ...(output ? { output: JSON.parse(JSON.stringify(output)) } : {}),
      };
    });
    return { name: service.name, language: "ts", actions, errors };
  });
}

/** The remote services' manifests from `_brick/contract.json`, for the TS contract between `brick gen` runs. */
export function readContractRemotes(
  app: BrickApp,
  file = resolve("_brick/contract.json"),
): ServiceManifest[] {
  const names = new Set((app.definition.remote ?? []).map((r) => r.name));
  if (!names.size || !existsSync(file)) return [];
  const contract = JSON.parse(readFileSync(file, "utf8")) as PolyglotContract;
  return contract.services.filter((service) => names.has(service.name));
}

/**
 * `brick gen` for an app with remote services: merge every service's manifest
 * into `_brick/contract.json`, then write the TS contract, and a Go client
 * package (`<dir>/brickclient/client.go`) or Rust client module
 * (`<dir>/src/brick_client.rs`) into each remote service.
 *
 * @returns The files written, or `undefined` when the app has no remote services.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export async function writePolyglotContract(
  entry: string,
  clientOutput?: string,
  cwd = process.cwd(),
): Promise<string[] | undefined> {
  const output = resolve(cwd, clientOutput ?? "_brick/contract.ts");
  if (resolve(entry) === output)
    throw new Error("Brick: contract output must not overwrite the app entry.");
  const app = await loadBrickApp(entry);
  const remote = app.definition.remote ?? [];
  if (!remote.length) return undefined;
  const contract: PolyglotContract = {
    version: 1,
    services: [
      ...tsManifests(app),
      ...(await Promise.all(
        remote.map((r) => readRemoteManifest(r, cwd)),
      ).catch((error) => {
        // The others' groups would outlive the CLI's exit on this error.
        killGroups(manifestGroups);
        throw error;
      })),
    ],
  };
  const written: string[] = [];
  const write = async (file: string, source: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeContractSource(file, source);
    written.push(file);
  };
  await write(
    resolve(cwd, "_brick/contract.json"),
    `${JSON.stringify(contract, null, 2)}\n`,
  );
  await write(
    output,
    generateClientContract(
      app,
      contract.services.filter((s) => s.language !== "ts"),
    ),
  );
  for (const service of remote) {
    const manifest = contract.services.find((s) => s.name === service.name)!;
    const dir = resolve(cwd, service.options.dir);
    if (manifest.language === "go") {
      const file = join(dir, "brickclient", "client.go");
      await write(file, goClient(contract, service.name));
      // Formatted as gofmt/rustfmt would; without them the files are still valid.
      spawnSync("gofmt", ["-w", file]);
    } else if (manifest.language === "rust") {
      const file = join(dir, "src", "brick_client.rs");
      await write(file, rustClient(contract, service.name));
      spawnSync("rustfmt", ["--edition", "2024", file]);
    }
  }
  return written;
}

const HEADER = "Code generated by brick gen. DO NOT EDIT.";

function pascal(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function snake(name: string): string {
  return kebabCase(name).replace(/[^a-z0-9]+/g, "_");
}

type Decl = string[];

/**
 * Claim a generated name: two sources for one name would not compile, so
 * `brick gen` fails naming both.
 */
function claim(
  seen: Map<string, string>,
  name: string,
  source: string,
  language: string,
): void {
  const other = seen.get(name);
  if (other !== undefined)
    throw new Error(
      `Brick: ${other} and ${source} both become ${name} in the ${language} client; rename one.`,
    );
  seen.set(name, source);
}

function isStruct(schema: any): boolean {
  return (
    schema?.type === "object" &&
    !schema.enum &&
    (schema.properties !== undefined ||
      (!schema.additionalProperties && !schema.patternProperties))
  );
}

/** The value schema of a map: `additionalProperties`, or TypeBox `Type.Record`'s single `patternProperties` entry. */
function mapValue(schema: any): any {
  if (schema?.type !== "object") return undefined;
  if (typeof schema.additionalProperties === "object")
    return schema.additionalProperties;
  const patterns = Object.values(schema.patternProperties ?? {});
  return patterns.length === 1 ? patterns[0] : undefined;
}

function scalarType(
  schema: any,
): "string" | "integer" | "number" | "boolean" | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  if (schema.enum?.every((v: unknown) => typeof v === "string"))
    return "string";
  if (typeof schema.const === "string") return "string";
  // TypeBox writes a string enum as a union of literals.
  if (schema.anyOf?.every((v: any) => typeof v?.const === "string"))
    return "string";
  if (["string", "integer", "number", "boolean"].includes(schema.type))
    return schema.type;
  return undefined;
}

function nullableOf(schema: any): any {
  if (!Array.isArray(schema?.type)) return undefined;
  const rest = schema.type.filter((t: string) => t !== "null");
  return rest.length === 1 && schema.type.includes("null")
    ? { ...schema, type: rest[0] }
    : undefined;
}

/**
 * A Go client package for every service but `self`.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function goClient(contract: PolyglotContract, self: string): string {
  const decls: Decl = [];
  // Types and functions share the package scope.
  const names = new Map<string, string>();
  const goType = (schema: any, name: string): string => {
    const nullable = nullableOf(schema);
    if (nullable) {
      const inner = goType(nullable, name);
      return inner === "any" ||
        inner.startsWith("[]") ||
        inner.startsWith("map")
        ? inner
        : `*${inner}`;
    }
    const scalar = scalarType(schema);
    if (scalar)
      return {
        string: "string",
        integer: "int64",
        number: "float64",
        boolean: "bool",
      }[scalar];
    if (schema?.type === "array")
      return `[]${goType(schema.items, `${name}Item`)}`;
    if (isStruct(schema)) {
      claim(names, name, `the type ${name}`, "Go");
      const required = new Set<string>(schema.required ?? []);
      const fieldNames = new Map<string, string>();
      const fields = Object.entries(schema.properties ?? {}).map(
        ([key, prop]) => {
          let field = pascal(key) || "Field";
          if (/^[0-9]/.test(field)) field = `F${field}`;
          claim(fieldNames, `${name}.${field}`, `property "${key}"`, "Go");
          let type = goType(prop, name + pascal(key));
          const optional = !required.has(key);
          if (optional && !/^(\*|\[\]|map|any)/.test(type)) type = `*${type}`;
          return `\t${field} ${type} \`json:"${key}${optional ? ",omitempty" : ""}"\``;
        },
      );
      decls.push(
        `type ${name} struct {\n${fields.join("\n")}${fields.length ? "\n" : ""}}`,
      );
      return name;
    }
    const value = mapValue(schema);
    if (value) return `map[string]${goType(value, `${name}Value`)}`;
    if (schema?.type === "object") return "map[string]any";
    return "any";
  };
  const funcs: string[] = [];
  for (const service of contract.services) {
    if (service.name === self) continue;
    for (const action of service.actions) {
      const fn = pascal(service.name) + pascal(action.name);
      claim(names, fn, `${service.name}.${action.name}`, "Go");
      const input = action.input ? goType(action.input, `${fn}Input`) : "any";
      const output = action.output
        ? goType(action.output, `${fn}Output`)
        : "any";
      funcs.push(`// ${fn} calls ${service.name}.${action.name} (${service.language}).
func ${fn}(ctx context.Context, in ${input}) (${output}, error) {
\tvar out ${output}
\terr := brick.Call(ctx, ${JSON.stringify(service.name)}, ${JSON.stringify(action.name)}, in, &out)
\treturn out, err
}`);
    }
  }
  // Go rejects unused imports, and with no other service's actions nothing uses them.
  const imports = funcs.length
    ? `import (
\t"context"

\t"github.com/get-brickkit/brick/sdk/go/brick"
)

`
    : "";
  return `// ${HEADER}

// Package brickclient calls the app's other Brick services.
package brickclient

${imports}${[...decls, ...funcs].join("\n\n")}
`;
}

const RUST_KEYWORDS = new Set(
  // Strict and reserved keywords (2024 edition).
  "abstract as async await become box break const continue crate do dyn else enum extern false final fn for gen if impl in let loop macro match mod move mut override priv pub ref return self static struct super trait true try type typeof unsafe unsized use virtual where while yield".split(
    " ",
  ),
);

/**
 * A Rust client module for every service but `self`.
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function rustClient(contract: PolyglotContract, self: string): string {
  const decls: Decl = [];
  // Types and functions are separate namespaces in Rust.
  const types = new Map<string, string>();
  const fns = new Map<string, string>();
  const rustType = (schema: any, name: string): string => {
    const nullable = nullableOf(schema);
    if (nullable) return `Option<${rustType(nullable, name)}>`;
    const scalar = scalarType(schema);
    if (scalar)
      return {
        string: "String",
        integer: "i64",
        number: "f64",
        boolean: "bool",
      }[scalar];
    if (schema?.type === "array")
      return `Vec<${rustType(schema.items, `${name}Item`)}>`;
    if (isStruct(schema)) {
      claim(types, name, `the type ${name}`, "Rust");
      const required = new Set<string>(schema.required ?? []);
      const fieldNames = new Map<string, string>();
      const fields = Object.entries(schema.properties ?? {}).map(
        ([key, prop]) => {
          let field = snake(key) || "field";
          if (/^[0-9]/.test(field)) field = `f${field}`;
          // self, super and crate can't be raw identifiers.
          if (["self", "super", "crate"].includes(field)) field = `${field}_`;
          // Claimed after the rename, which can collide too (self and self_).
          claim(fieldNames, `${name}.${field}`, `property "${key}"`, "Rust");
          if (RUST_KEYWORDS.has(field)) field = `r#${field}`;
          let type = rustType(prop, name + pascal(key));
          const optional = !required.has(key);
          const attrs = [`rename = ${JSON.stringify(key)}`];
          if (optional) {
            if (!type.startsWith("Option<")) type = `Option<${type}>`;
            attrs.push(`default, skip_serializing_if = "Option::is_none"`);
          }
          return `    #[serde(${attrs.join(", ")})]\n    pub ${field}: ${type},`;
        },
      );
      decls.push(
        `#[derive(Debug, Clone, Default, Serialize, Deserialize)]\npub struct ${name} {\n${fields.join("\n")}${fields.length ? "\n" : ""}}`,
      );
      return name;
    }
    const value = mapValue(schema);
    if (value)
      return `std::collections::HashMap<String, ${rustType(value, `${name}Value`)}>`;
    return "serde_json::Value";
  };
  const funcs: string[] = [];
  for (const service of contract.services) {
    if (service.name === self) continue;
    for (const action of service.actions) {
      const base = pascal(service.name) + pascal(action.name);
      claim(
        fns,
        `${snake(service.name)}_${snake(action.name)}`,
        `${service.name}.${action.name}`,
        "Rust",
      );
      const input = action.input
        ? rustType(action.input, `${base}Input`)
        : "serde_json::Value";
      const output = action.output
        ? rustType(action.output, `${base}Output`)
        : "serde_json::Value";
      funcs.push(`/// Calls ${service.name}.${action.name} (${service.language}).
pub async fn ${snake(service.name)}_${snake(action.name)}(ctx: &brickkit::Ctx, input: &${input}) -> Result<${output}, brickkit::Error> {
    brickkit::call(ctx, ${JSON.stringify(service.name)}, ${JSON.stringify(action.name)}, input).await
}`);
    }
  }
  return `// ${HEADER}
//! Calls the app's other Brick services.
#![allow(dead_code, unused_imports, clippy::all)]

use serde::{Deserialize, Serialize};

${[...decls, ...funcs].join("\n\n")}
`;
}

/** The one line `brick dev`, `brick build` and `brick start` print, only for an app with Go or Rust services. */
export function noticeExperimental(remote: readonly RemoteService[]): void {
  if (remote.length)
    console.warn(
      `[Brick] Polyglot services (${remote.map((r) => r.name).join(", ")}) are experimental and may change in any release.`,
    );
}

/**
 * Run each remote service's `build.command` in its folder (what `brick build` does).
 *
 * @experimental Polyglot (Go and Rust) services are experimental in Brick 0.13 and may change in any release.
 */
export function buildRemoteServices(app: BrickApp, cwd = process.cwd()): void {
  noticeExperimental(app.definition.remote ?? []);
  for (const remote of app.definition.remote ?? []) {
    const command = remote.options.build?.command;
    if (!command) continue;
    console.log(`Building ${remote.name}: ${command}`);
    const result = spawnSync("/bin/sh", ["-c", command], {
      cwd: resolve(cwd, remote.options.dir),
      stdio: "inherit",
    });
    if (result.status !== 0)
      throw new Error(`Brick: building "${remote.name}" failed (${command}).`);
  }
}

/**
 * Start the remote services' `dev` commands and restart one when a file in
 * its folder changes (build output and `.git` aside). `brick dev` and the
 * Vite plugin run this.
 */
export async function startDevRemotes(
  remote: readonly RemoteService[],
  options: {
    appUrl: string;
    services: readonly string[];
    env?: Record<string, string>;
    /** Where the services' `dir`s are relative to (default the working directory). */
    cwd?: string;
  },
): Promise<RemoteProcesses> {
  noticeExperimental(remote);
  const processes = await startRemoteServices(remote, {
    mode: "dev",
    ...options,
  });
  const watchers: ReturnType<typeof watch>[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const stop = async () => {
    for (const watcher of watchers) watcher.close();
    for (const timer of timers) clearTimeout(timer);
    await processes.stop();
  };
  try {
    for (const service of remote) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      watchers.push(
        watch(
          resolve(options.cwd ?? process.cwd(), service.options.dir),
          { recursive: true },
          (_event, filename) => {
            if (
              !filename ||
              /(^|[\\/])(target|bin|node_modules|\.git)([\\/]|$)/.test(filename)
            )
              return;
            clearTimeout(timer);
            timers.delete(timer!);
            timer = setTimeout(() => {
              timers.delete(timer!);
              console.log(`\n📝 ${service.name} changed. Restarting it...`);
              void processes.restart(service.name);
            }, 150);
            timers.add(timer);
          },
        ),
      );
    }
  } catch (error) {
    // Nobody gets the children to stop otherwise.
    await stop();
    throw error;
  }
  return { ...processes, stop };
}
