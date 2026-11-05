import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { isCrudEvent, kebabCase } from "@brickkit/core";
import { loadBrickApp, type BrickApp } from "./app-entry";
import { ConfigError, type LoadedConfig } from "./config";
import {
  ALWAYS_ERROR,
  fileRules,
  resolveRules,
  type Severity,
} from "./lint/presets";
import { runFileRules, type LintMessage } from "./lint/run";
import { DEFINITION_FILE, TEST_FILE } from "./definitions";
import { writeServiceManifest } from "./manifest";

const posix = (path: string) => path.split(sep).join("/");
const SOURCE = new Bun.Glob("**/*.{ts,tsx,mts,cts}");

interface AppCheck {
  root: string;
  entry: string;
  services: string;
  severity: (rule: string) => Severity;
  ignored: (rel: string) => boolean;
}

/**
 * `brick lint`: the file rules through oxlint, then the app
 * rules against the loaded app. Prints `file:line:col` lines and returns the
 * exit code: 1 when anything is an error.
 */
export async function runLint(options: {
  entry?: string;
  project?: LoadedConfig;
}): Promise<number> {
  const { project } = options;
  const root = project?.root ?? process.cwd();
  const config = project?.config.lint ?? {};
  let resolved: Record<string, Severity>;
  try {
    resolved = resolveRules(config.presets, config.rules);
  } catch (error) {
    throw new ConfigError(
      `brick.config.ts: lint.rules: ${(error as Error).message}`,
    );
  }
  const fromRoot = (path: string) => posix(relative(root, path)) || ".";
  const services = project?.services ?? resolve(root, "src/services");
  const generated = project?.generated ?? resolve(root, "_brick");
  const entry = options.entry
    ? resolve(options.entry)
    : (project?.entry ?? resolve(root, "src/app.ts"));
  const ignore = [...(config.ignore ?? []), `${fromRoot(generated)}/**`];
  const messages = runFileRules({
    root,
    rules: fileRules(resolved),
    settings: {
      root,
      services: fromRoot(services),
      entry: fromRoot(entry),
      generated: fromRoot(generated),
      web: "web",
    },
    ignore,
  });
  const globs = ignore.map((pattern) => new Bun.Glob(pattern));
  if (existsSync(entry)) {
    if (project) await writeServiceManifest(project);
    messages.push(
      ...(await checkApp({
        root,
        entry,
        services,
        severity: (rule) =>
          rule === ALWAYS_ERROR
            ? "error"
            : (resolved[`brick/${rule}`] ?? "off"),
        ignored: (rel) =>
          rel.split("/").includes("node_modules") ||
          globs.some((glob) => glob.match(rel)),
      })),
    );
  } else if (options.entry || project)
    throw new Error(`Brick: entry not found: ${entry}`);
  return report(messages);
}

function report(messages: LintMessage[]): number {
  messages.sort(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
  for (const m of messages)
    console.log(
      `${m.file}:${m.line}:${m.column}  ${m.severity === "error" ? "error" : "warning"}  ${m.message}  ${m.rule}`,
    );
  const errors = messages.filter((m) => m.severity === "error").length;
  const warnings = messages.length - errors;
  console.log(
    messages.length
      ? `\n✖ ${messages.length} problem${messages.length === 1 ? "" : "s"} (${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"})`
      : "✔ No lint problems",
  );
  return errors > 0 ? 1 : 0;
}

/** Project source files, from the root, without tests, ignored and generated files. */
function sourceFiles(check: AppCheck, under = check.root): string[] {
  if (!existsSync(under)) return [];
  return [...SOURCE.scanSync({ cwd: under, onlyFiles: true })]
    .map((file) => resolve(under, file))
    .filter((file) => {
      const rel = posix(relative(check.root, file));
      return (
        !check.ignored(rel) &&
        !TEST_FILE.test(rel) &&
        !rel.startsWith("dist/")
      );
    });
}

function lineOf(source: string, index: number) {
  return source.slice(0, index).split("\n").length;
}

/** The app rules: they need the loaded app, so only brick lint runs them. */
async function checkApp(check: AppCheck): Promise<LintMessage[]> {
  const messages: LintMessage[] = [];
  const add = (rule: string, file: string, message: string, line = 1) => {
    const severity = check.severity(rule);
    if (severity === "off") return;
    messages.push({
      file: posix(relative(check.root, file)),
      line,
      column: 1,
      rule: `brick/${rule}`,
      severity,
      message,
    });
  };
  let app: BrickApp;
  try {
    app = await loadBrickApp(check.entry);
  } catch (error) {
    const { name, message } = error as Error;
    // Startup refuses duplicate names; report it as the rule, not a crash.
    // shortcut: server.ts and events/hub.ts still throw plain Errors for a
    // duplicate service, route or listener; drop the regex once they throw
    // DuplicateNameError.
    if (name === "DuplicateNameError" || /duplicate/i.test(message)) {
      add("unique-names", check.entry, message);
      return messages;
    }
    throw error;
  }
  const files = sourceFiles(check);
  singleAppEntry(check, files, add);
  await noCrossServiceTables(check, app, add);
  declaredEvents(check, app, add);
  testColocated(check, add);
  return messages;
}

type Add = (rule: string, file: string, message: string, line?: number) => void;

function singleAppEntry(check: AppCheck, files: string[], add: Add) {
  if (check.severity("single-app-entry") === "off") return;
  let calls = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // shortcut: a text search for brick( in files that import it from core.
    if (
      !/import\s*\{[^}]*\bbrick\b[^}]*\}\s*from\s*["']@brickkit\/core["']/.test(
        source,
      )
    )
      continue;
    for (const match of source.matchAll(/(?<![.\w])brick\s*\(/g)) {
      if (file === check.entry && ++calls === 1) continue;
      add(
        "single-app-entry",
        file,
        file === check.entry
          ? "The entry calls brick() more than once; keep one app."
          : `brick() is called outside the entry (${posix(relative(check.root, check.entry))}); keep one app.`,
        lineOf(source, match.index),
      );
    }
  }
}

/** Which service owns each table: its resources' and registered tables, or a database it alone uses. */
function tableOwners(app: BrickApp) {
  const owners = new Map<unknown, string>();
  const users = new Map<unknown, string[]>();
  for (const service of app.definition.services) {
    for (const table of (
      service as { tables?: Map<string, unknown> }
    ).tables?.values() ?? [])
      owners.set(table, service.name);
    const database = (service.options as { database?: { tables?: object } })
      .database;
    if (database)
      users.set(database, [...(users.get(database) ?? []), service.name]);
  }
  for (const [database, names] of users)
    if (names.length === 1)
      for (const table of Object.values(
        (database as { tables?: object }).tables ?? {},
      ))
        if (!owners.has(table)) owners.set(table, names[0]!);
  return owners;
}

function serviceOfFolder(app: BrickApp, folder: string) {
  return app.definition.services.find(
    (service) => service.name === folder || kebabCase(service.name) === folder,
  )?.name;
}

const IMPORT =
  /import\s+(type\s+)?([\w$]+\s*,?\s*)?(\*\s+as\s+[\w$]+|\{[^}]*\})?\s*from\s*["']([^"']+)["']/g;

async function noCrossServiceTables(check: AppCheck, app: BrickApp, add: Add) {
  const owners = tableOwners(app);
  for (const file of sourceFiles(check, check.services)) {
    const folder = posix(relative(check.services, file)).split("/")[0]!;
    const service = serviceOfFolder(app, folder);
    if (!service) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const [, typeOnly, defaultName, rest, specifier] = match;
      if (typeOnly || !specifier!.startsWith(".")) continue;
      let target: string;
      try {
        target = Bun.resolveSync(specifier!, dirname(file));
      } catch {
        continue;
      }
      const line = lineOf(source, match.index);
      const where = posix(relative(check.services, target)).split("/");
      const otherFolder =
        !where[0]!.startsWith("..") && where.length > 1 ? where[0] : undefined;
      if (
        otherFolder &&
        otherFolder !== folder &&
        /\.table\.[cm]?tsx?$/.test(target)
      ) {
        add(
          "no-cross-service-tables",
          file,
          `Service "${service}" imports ${basename(target)} from ${otherFolder}/; call that service's actions or listen to its events instead.`,
          line,
        );
        continue;
      }
      const module: Record<string, unknown> = await import(target).catch(
        () => ({}),
      );
      const names: string[] = [];
      if (defaultName?.trim()) names.push("default");
      if (rest?.startsWith("*")) names.push(...Object.keys(module));
      else if (rest)
        for (const part of rest.slice(1, -1).split(",")) {
          const name = part.trim().split(/\s+as\s+/)[0]!;
          if (name && !name.startsWith("type ")) names.push(name);
        }
      for (const name of names) {
        const owner = owners.get(module[name]);
        if (owner && owner !== service)
          add(
            "no-cross-service-tables",
            file,
            `Service "${service}" imports table ${name === "default" ? basename(target) : `"${name}"`} owned by "${owner}"; call ${owner}'s actions or listen to its events instead.`,
            line,
          );
      }
    }
  }
}

function declaredEvents(check: AppCheck, app: BrickApp, add: Add) {
  if (check.severity("declared-events") === "off") return;
  for (const service of app.definition.services) {
    if (!service.options.events) continue; // no catalog: any name goes
    const names = new Set(Object.values(service.events).map((e) => e.name));
    const resources = service.listResources().map((r) => r.name);
    const declared = (name: string) =>
      names.has(name) || isCrudEvent(name, resources);
    for (const action of service.listActions())
      for (const name of action.config.emits ?? [])
        if (!declared(name))
          add(
            "declared-events",
            check.entry,
            `Action "${service.name}.${action.name}" emits "${name}", which is not in ${service.name}'s event catalog.`,
          );
    const folder = [kebabCase(service.name), service.name]
      .map((name) => resolve(check.services, name))
      .find(existsSync);
    for (const file of folder ? sourceFiles(check, folder) : []) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /emitEvent\s*\([^,]+,\s*["'`]([^"'`]+)["'`]/g,
      ))
        if (!declared(match[1]!))
          add(
            "declared-events",
            file,
            `"${match[1]}" is not in ${service.name}'s event catalog.`,
            lineOf(source, match.index),
          );
    }
  }
}

function testColocated(check: AppCheck, add: Add) {
  if (check.severity("test-colocated") === "off") return;
  for (const file of sourceFiles(check, check.services)) {
    const match = DEFINITION_FILE.exec(basename(file));
    if (match?.[2] !== "action" && match?.[2] !== "command") continue;
    const test = resolve(dirname(file), `${match[1]}.test.ts`);
    if (!existsSync(test) && !existsSync(`${test}x`))
      add(
        "test-colocated",
        file,
        `${basename(file)} has no ${match[1]}.test.ts beside it.`,
      );
  }
}
