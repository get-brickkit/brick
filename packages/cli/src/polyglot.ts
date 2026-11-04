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

/** One service in `_brick/contract.json`: what `--brick-manifest` prints, for every language. */
export interface ServiceManifest {
  name: string;
  language: "ts" | "go" | "rust";
  actions: { name: string; input?: unknown; output?: unknown }[];
  errors: Record<string, { status: number; message: string }>;
}

export interface PolyglotContract {
  version: 1;
  services: ServiceManifest[];
}

const run = promisify(execFile);

/** Run a remote service's `dev` command with `BRICK_MANIFEST=1` and read the manifest it prints. */
export async function readRemoteManifest(
  remote: RemoteService,
  cwd = process.cwd(),
): Promise<ServiceManifest> {
  const { stdout } = await run("/bin/sh", ["-c", remote.options.dev], {
    cwd: resolve(cwd, remote.options.dir),
    env: { ...process.env, BRICK_MANIFEST: "1" },
    maxBuffer: 64 * 1024 * 1024,
  }).catch((error: Error & { stderr?: string }) => {
    throw new Error(
      `Brick: could not read the manifest of "${remote.name}" (${remote.options.dev} in ${remote.options.dir}): ${error.stderr || error.message}`,
    );
  });
  const line = stdout.trim().split("\n").at(-1) ?? "";
  const manifest = JSON.parse(line) as ServiceManifest;
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
 */
export async function writePolyglotContract(
  entry: string,
  clientOutput?: string,
  cwd = process.cwd(),
): Promise<string[] | undefined> {
  const app = await loadBrickApp(entry);
  const remote = app.definition.remote ?? [];
  if (!remote.length) return undefined;
  const contract: PolyglotContract = {
    version: 1,
    services: [
      ...tsManifests(app),
      ...(await Promise.all(remote.map((r) => readRemoteManifest(r, cwd)))),
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
    resolve(cwd, clientOutput ?? "_brick/contract.ts"),
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

function isStruct(schema: any): boolean {
  return (
    schema?.type === "object" &&
    !schema.enum &&
    (schema.properties !== undefined || !schema.additionalProperties)
  );
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

/** A Go client package for every service but `self`. */
export function goClient(contract: PolyglotContract, self: string): string {
  const decls: Decl = [];
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
      const required = new Set<string>(schema.required ?? []);
      const fields = Object.entries(schema.properties ?? {}).map(
        ([key, prop]) => {
          let field = pascal(key) || "Field";
          if (/^[0-9]/.test(field)) field = `F${field}`;
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
    if (
      schema?.type === "object" &&
      typeof schema.additionalProperties === "object"
    )
      return `map[string]${goType(schema.additionalProperties, `${name}Value`)}`;
    if (schema?.type === "object") return "map[string]any";
    return "any";
  };
  const funcs: string[] = [];
  for (const service of contract.services) {
    if (service.name === self) continue;
    for (const action of service.actions) {
      const fn = pascal(service.name) + pascal(action.name);
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
  return `// ${HEADER}

// Package brickclient calls the app's other Brick services.
package brickclient

import (
\t"context"

\t"github.com/get-brickkit/brick/sdk/go/brick"
)

${[...decls, ...funcs].join("\n\n")}
`;
}

const RUST_KEYWORDS = new Set(
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self static struct super trait true type unsafe use where while".split(
    " ",
  ),
);

/** A Rust client module for every service but `self`. */
export function rustClient(contract: PolyglotContract, self: string): string {
  const decls: Decl = [];
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
      const required = new Set<string>(schema.required ?? []);
      const fields = Object.entries(schema.properties ?? {}).map(
        ([key, prop]) => {
          let field = snake(key) || "field";
          if (/^[0-9]/.test(field)) field = `f${field}`;
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
    if (
      schema?.type === "object" &&
      typeof schema.additionalProperties === "object"
    )
      return `std::collections::HashMap<String, ${rustType(schema.additionalProperties, `${name}Value`)}>`;
    return "serde_json::Value";
  };
  const funcs: string[] = [];
  for (const service of contract.services) {
    if (service.name === self) continue;
    for (const action of service.actions) {
      const base = pascal(service.name) + pascal(action.name);
      const input = action.input
        ? rustType(action.input, `${base}Input`)
        : "serde_json::Value";
      const output = action.output
        ? rustType(action.output, `${base}Output`)
        : "serde_json::Value";
      funcs.push(`/// Calls ${service.name}.${action.name} (${service.language}).
pub async fn ${snake(service.name)}_${snake(action.name)}(ctx: &brick::Ctx, input: &${input}) -> Result<${output}, brick::Error> {
    brick::call(ctx, ${JSON.stringify(service.name)}, ${JSON.stringify(action.name)}, input).await
}`);
    }
  }
  return `// ${HEADER}
//! Calls the app's other Brick services.
#![allow(dead_code, clippy::all)]

use serde::{Deserialize, Serialize};

${[...decls, ...funcs].join("\n\n")}
`;
}

/** Run each remote service's `build.command` in its folder (what `brick build` does). */
export function buildRemoteServices(app: BrickApp, cwd = process.cwd()): void {
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
  options: { appUrl: string; services: readonly string[] },
): Promise<RemoteProcesses> {
  const processes = await startRemoteServices(remote, {
    mode: "dev",
    ...options,
  });
  const watchers = remote.map((service) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return watch(
      resolve(service.options.dir),
      { recursive: true },
      (_event, filename) => {
        if (
          !filename ||
          /(^|[\\/])(target|bin|node_modules|\.git)([\\/]|$)/.test(filename)
        )
          return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          console.log(`\n📝 ${service.name} changed. Restarting it...`);
          void processes.restart(service.name);
        }, 150);
      },
    );
  });
  return {
    ...processes,
    async stop() {
      for (const watcher of watchers) watcher.close();
      await processes.stop();
    },
  };
}
