import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { isCrudEvent } from "@brickkit/core";
import type { BrickApp, DatabaseHandle } from "@brickkit/core";
import { loadBrickApp } from "./app-entry";
import type { LoadedConfig } from "./config";
import { APP_RULES, type Severity } from "./lint/presets";
import { projectRules } from "./lint/project";
import { serviceFolders } from "./lint/ast";
import { runFileRules, type LintMessage } from "./lint/run";
import {
  DEFINITION_EXTENSIONS,
  DEFINITION_FILE,
  TEST_FILE,
} from "./definitions";
import { writeServiceManifest } from "./manifest";

const posix = (path: string) => path.split(sep).join("/");
const SOURCE = new Bun.Glob(`**/*.{${DEFINITION_EXTENSIONS.join(",")}}`);

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
  project: LoadedConfig;
}): Promise<number> {
  const entry = options.entry ? resolve(options.entry) : options.project.entry;
  const project = { ...options.project, entry };
  const { root, services } = project;
  const { resolved, rules, settings, ignore } = projectRules(project);
  const messages = runFileRules({ root, rules, settings, ignore });
  const globs = ignore.map((pattern) => new Bun.Glob(pattern));
  if (existsSync(entry)) {
    if (project.file) await writeServiceManifest(project);
    messages.push(
      ...(await checkApp({
        root,
        entry,
        services,
        severity: (rule) => resolved[`brick/${rule}`] ?? "off",
        ignored: (rel) =>
          rel.split("/").includes("node_modules") ||
          globs.some((glob) => glob.match(rel)),
      })),
    );
  } else if (options.entry || project.file)
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
        !check.ignored(rel) && !TEST_FILE.test(rel) && !rel.startsWith("dist/")
      );
    });
}

function lineOf(source: string, index: number) {
  return source.slice(0, index).split("\n").length;
}

type Add = (file: string, message: string, line?: number) => void;
type AppRule = (check: AppCheck, app: BrickApp, add: Add) => unknown;

/** Each app rule's check; a rule in APP_RULES without one fails to compile. */
const APP_CHECKS: Record<(typeof APP_RULES)[number], AppRule> = {
  "single-app-entry": singleAppEntry,
  "no-cross-service-tables": noCrossServiceTables,
  // Startup refuses duplicate names, so checkApp reports it when the app loads.
  "unique-names": () => {},
  "declared-events": declaredEvents,
  "test-colocated": testColocated,
};

async function checkApp(check: AppCheck): Promise<LintMessage[]> {
  const messages: LintMessage[] = [];
  const message = (
    rule: string,
    severity: Exclude<Severity, "off">,
    file: string,
    text: string,
    line = 1,
  ): LintMessage => ({
    file: posix(relative(check.root, file)),
    line,
    column: 1,
    rule: `brick/${rule}`,
    severity,
    message: text,
  });
  let app: BrickApp;
  try {
    app = await loadBrickApp(check.entry);
  } catch (error) {
    // An app that cannot start fails lint, even with unique-names off.
    if ((error as Error).name === "DuplicateNameError") {
      const severity = check.severity("unique-names");
      return [
        message(
          "unique-names",
          severity === "off" ? "error" : severity,
          check.entry,
          (error as Error).message,
        ),
      ];
    }
    throw error;
  }
  for (const [rule, run] of Object.entries(APP_CHECKS)) {
    const severity = check.severity(rule);
    if (severity === "off") continue;
    await run(check, app, (file, text, line) =>
      messages.push(message(rule, severity, file, text, line)),
    );
  }
  return messages;
}

function singleAppEntry(check: AppCheck, _app: BrickApp, add: Add) {
  let calls = 0;
  for (const file of sourceFiles(check)) {
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
  const users = new Map<DatabaseHandle<unknown>, string[]>();
  for (const service of app.definition.services) {
    for (const table of service.tables.values())
      owners.set(table, service.name);
    const { database } = service.options;
    if (database)
      users.set(database, [...(users.get(database) ?? []), service.name]);
  }
  for (const [database, names] of users)
    if (names.length === 1)
      for (const table of Object.values(database.tables))
        if (!owners.has(table)) owners.set(table, names[0]!);
  return owners;
}

function serviceOfFolder(app: BrickApp, folder: string) {
  return app.definition.services.find((service) =>
    serviceFolders(service.name).includes(folder),
  )?.name;
}

// shortcut: a text search for static imports and re-exports; misses `import()`.
const IMPORT =
  /(?:import|export)\s+(type\s+)?([\w$]+\s*,?\s*)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})?\s*from\s*["']([^"']+)["']/g;

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
        DEFINITION_FILE.exec(basename(target))?.[2] === "table"
      ) {
        add(
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
            file,
            `Service "${service}" imports table ${name === "default" ? basename(target) : `"${name}"`} owned by "${owner}"; call ${owner}'s actions or listen to its events instead.`,
            line,
          );
      }
    }
  }
}

function declaredEvents(check: AppCheck, app: BrickApp, add: Add) {
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
            check.entry,
            `Action "${service.name}.${action.name}" emits "${name}", which is not in ${service.name}'s event catalog.`,
          );
    const folder = serviceFolders(service.name)
      .map((name) => resolve(check.services, name))
      .find(existsSync);
    for (const file of folder ? sourceFiles(check, folder) : []) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /emitEvent\s*\([^,]+,\s*["'`]([^"'`]+)["'`]/g,
      ))
        if (!declared(match[1]!))
          add(
            file,
            `"${match[1]}" is not in ${service.name}'s event catalog.`,
            lineOf(source, match.index),
          );
    }
  }
}

function testColocated(check: AppCheck, _app: BrickApp, add: Add) {
  for (const file of sourceFiles(check, check.services)) {
    const match = DEFINITION_FILE.exec(basename(file));
    if (match?.[2] !== "action" && match?.[2] !== "command") continue;
    const tested = readdirSync(dirname(file)).some(
      (sibling) =>
        TEST_FILE.test(sibling) && sibling.replace(TEST_FILE, "") === match[1],
    );
    if (!tested)
      add(file, `${basename(file)} has no ${match[1]}.test.ts beside it.`);
  }
}
