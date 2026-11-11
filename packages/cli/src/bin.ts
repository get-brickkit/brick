#!/usr/bin/env bun
import { resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { startDevServer, startProdServer, startWorker } from "./runner";
import { buildApplication } from "./build";
import { writeClientContract } from "./client-contract-file";
import { getGlobalRegistry } from "@brickkit/core";
import { loadBrickApp } from "./app-entry";
import {
  ConfigError,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_PORT,
  resolvePort,
  resolveDevDashboard,
  resolveProject,
  type LoadedConfig,
} from "./config";
import { writeServiceManifest } from "./manifest";
import { runLint } from "./lint";
import { runDbCommand } from "./db";
import { runSchedulesCommand } from "./schedules";
import cliPkg from "../package.json";

// Single source of truth for the CLI version (inlined at build time).
const CLI_VERSION: string = cliPkg.version;

const PORT_HELP = `Port to listen on (CLI --port overrides PORT env, default ${DEFAULT_PORT})`;

const EXTENSION_HELP =
  "Dashboard extension module (default export defineDashboard(...)), or the dashboard folder brick build wrote";

const PORT_RESOLUTION_HELP = `
Port Resolution (dev/start commands):
  - CLI --port flag takes precedence
  - Falls back to PORT environment variable
  - Then dev.port in brick.config.ts (brick dev only)
  - Defaults to ${DEFAULT_PORT} if none is set
  - Valid range: 1-65535

Examples:
  brick dev app.ts                        # port 4000 (default)
  brick dev app.ts --port 5000            # port 5000 (explicit)
  PORT=3000 brick dev app.ts              # port 3000 (from env)
  brick dev app.ts --port 6000            # port 6000 (CLI overrides PORT=3000)
`;

const CONFIG_HELP =
  "Path to brick.config.ts (default: the nearest one in this folder or its parents)";

function parsePortOption(value: string): number {
  try {
    return resolvePort(value);
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

function parseHistoryDays(value: string): number {
  const days = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(days)) {
    throw new InvalidArgumentError(
      `--history-days must be a whole number of days, or 0 for none (got '${value}')`,
    );
  }
  return days;
}

function parseFileOption(value: string, usage: string): string {
  if (value.startsWith("-")) {
    throw new InvalidArgumentError(`${usage} (got flag-like value '${value}')`);
  }
  return value;
}

/** The project of the program-level `--config`, else the nearest config file. */
function projectOf(command: Command): Promise<LoadedConfig> {
  return resolveProject(command.optsWithGlobals<{ config?: string }>().config);
}

function entryOf(entry: string | undefined, project: LoadedConfig) {
  return entry ?? (project.file ? project.entry : undefined);
}

/** Without an entry argument or config entry, commander's usual error. */
function requireEntry(
  command: Command,
  entry: string | undefined,
  project: LoadedConfig,
): string {
  const resolved = entryOf(entry, project);
  if (!resolved)
    command.error("error: missing required argument 'entry'", {
      exitCode: 1,
      code: "commander.missingArgument",
    });
  return resolved!;
}

/** Load the app after refreshing the services manifest it imports. */
async function loadProjectApp(entry: string, project: LoadedConfig) {
  if (project.file) await writeServiceManifest(project);
  return loadBrickApp(entry);
}

function fromRoot(
  project: LoadedConfig,
  path: string | undefined,
): string | undefined {
  return path && resolve(project.root, path);
}

/** The config's dashboard settings; a `--dashboard-extension` flag replaces its extension. */
function configDashboard(project: LoadedConfig, extensionFlag?: string) {
  const dashboard = project.config.dashboard;
  if (!dashboard && !extensionFlag) return undefined;
  return {
    extension: extensionFlag ?? fromRoot(project, dashboard?.extension),
    theme: dashboard?.theme,
  };
}

async function writeOpenApi(
  entry: string,
  output: string | undefined,
  project: LoadedConfig,
) {
  const app = await loadProjectApp(entry, project);
  const json = JSON.stringify(app.openApiDocument(), null, 2);
  if (output) await Bun.write(output, json);
  return json;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("brick")
    .description("🧱 Brick-TS CLI")
    .version(CLI_VERSION)
    .showHelpAfterError()
    .configureHelp({ showGlobalOptions: true })
    .option("--config <path>", CONFIG_HELP)
    .addHelpText(
      "after",
      `
With a brick.config.ts, the entry and most flags come from the config file.
${PORT_RESOLUTION_HELP}`,
    );

  program
    .command("dev")
    .description("Start development server with live reload")
    .option(
      "--client <file>",
      "Generate and watch a browser contract before startup",
    )
    .option(
      "--frontend <command>",
      "Start frontend after contract generation; requires --client",
    )
    .option(
      "--dashboard-port <number>",
      `Port for the local dashboard (default ${DEFAULT_DASHBOARD_PORT})`,
      parsePortOption,
    )
    .option(
      "--history-days <number>",
      `Days of requests the dashboard keeps on disk, 0 for none (default ${DEFAULT_HISTORY_DAYS})`,
      parseHistoryDays,
    )
    .option("--no-dashboard", "Do not start the local dashboard")
    .option("--dashboard-extension <file>", EXTENSION_HELP)
    .argument("[entry]", "Application entry file")
    .option("--port <number>", PORT_HELP, parsePortOption)
    .addHelpText("after", PORT_RESOLUTION_HELP)
    .action(
      async (
        entryArg: string | undefined,
        opts: {
          port?: number;
          client?: string;
          frontend?: string;
          dashboardPort?: number;
          historyDays?: number;
          dashboard?: boolean;
          dashboardExtension?: string;
        },
        command: Command,
      ) => {
        const project = await projectOf(command);
        const { config } = project;
        const entry = entryOf(entryArg, project);
        const port = resolvePort(opts.port, config.dev?.port);
        const dashboard = resolveDevDashboard(config.dev?.dashboard, opts);
        await startDevServer({
          entry,
          port,
          clientOutput: opts.client ?? fromRoot(project, config.client?.output),
          frontend: opts.frontend ?? config.dev?.frontend,
          // The dashboard reads the app's requests, so it needs an entry.
          dashboard:
            entry && dashboard
              ? {
                  ...dashboard,
                  ...configDashboard(project, opts.dashboardExtension),
                }
              : false,
          manifest: project.file ? project : undefined,
        });
      },
    );

  program
    .command("start")
    .description("Start production server")
    .argument("[entry]", "Application entry file")
    .option("--port <number>", PORT_HELP, parsePortOption)
    .option("--dashboard-extension <file>", EXTENSION_HELP)
    .addHelpText("after", PORT_RESOLUTION_HELP)
    .action(
      async (
        entry: string | undefined,
        opts: { port?: number; dashboardExtension?: string },
        command: Command,
      ) => {
        const project = await projectOf(command);
        await startProdServer({
          entry: entryOf(entry, project),
          port: resolvePort(opts.port),
          dashboard: configDashboard(project, opts.dashboardExtension),
        });
      },
    );

  program
    .command("worker")
    .description(
      "Deliver the app's events and run its schedules without serving HTTP",
    )
    .argument(
      "[entry]",
      "Application entry file (must default-export a BrickApp)",
    )
    .action(
      async (entry: string | undefined, _opts: object, command: Command) => {
        const project = await projectOf(command);
        await startWorker({ entry: requireEntry(command, entry, project) });
      },
    );

  program
    .command("schedules")
    .description(
      "List the app's schedules with their next run, or run one now with --run",
    )
    .argument(
      "[entry]",
      "Application entry file (must default-export a BrickApp)",
    )
    .option("--run <name>", "Make this schedule due now")
    .action(
      async (
        entry: string | undefined,
        opts: { run?: string },
        command: Command,
      ) => {
        const project = await projectOf(command);
        console.log(
          await runSchedulesCommand(
            requireEntry(command, entry, project),
            opts,
          ),
        );
        // The app's database connections would keep the process open.
        process.exit(0);
      },
    );

  program
    .command("build")
    .description("Compile a default-exported BrickApp into a Bun server")
    .argument(
      "[entry]",
      "Application entry file (must default-export a BrickApp)",
    )
    .option("--outdir <dir>", "Output directory", (v: string) =>
      parseFileOption(v, "Usage: brick build <app.ts> [--outdir <directory>]"),
    )
    .option("--port <number>", "Default listening port", parsePortOption)
    .option("--no-aot", "Disable ahead-of-time compilation")
    .option(
      "--dashboard-extension <file>",
      "Dashboard extension module to build into <outdir>/dashboard",
    )
    .option(
      "--prefix <path>",
      "DEPRECATED: configure prefix in brick() app instead",
    )
    .option(
      "--no-request-logging",
      "DEPRECATED: configure requestLogging in brick() app instead",
    )
    .action(
      async (
        entryArg: string | undefined,
        opts: {
          outdir?: string;
          port?: number;
          aot?: boolean;
          prefix?: string;
          requestLogging?: boolean;
          dashboardExtension?: string;
        },
        command: Command,
      ) => {
        if (opts.prefix !== undefined || opts.requestLogging === false) {
          throw new ConfigError(
            "Brick: configure prefix and requestLogging in your default-exported brick() app instead of build flags.",
          );
        }
        const project = await projectOf(command);
        const build = project.config.build;
        // shortcut: brick() sets up request logging when the app is created, so
        // a build cannot switch it off; only the default (true) is accepted.
        if (build?.requestLogging === false)
          throw new ConfigError(
            "Brick: configure requestLogging in your default-exported brick() app instead of build.requestLogging.",
          );
        const entry = requireEntry(command, entryArg, project);
        if (project.file) await writeServiceManifest(project);
        const result = await buildApplication({
          entry,
          outdir: opts.outdir ?? project.outdir,
          port: opts.port,
          // --no-aot can only switch it off, so otherwise the config decides.
          aot: opts.aot === false ? false : build?.aot,
          dashboard: configDashboard(project, opts.dashboardExtension),
        });
        for (const warning of result.ir.diagnostics)
          console.warn(`[Brick compiler] ${warning}`);
        console.log(
          `Compiled ${result.ir.services.length} services / ${result.ir.routes.length} routes`,
        );
        console.log(`IR: ${result.outdir}/brick-ir.json`);
        if (result.dashboard)
          console.log(`Dashboard extension: ${result.dashboard}`);
        if (result.workflows) console.log(`Workflows: ${result.workflows}`);
        console.log(`Run: bun ${result.entry}`);
        // The imported entry may hold timers or sockets open (#109).
        process.exit(0);
      },
    );

  const gen = program
    .command("gen")
    .description("Generate artifacts from a BrickApp entry")
    .argument("[subcommand]", "Generator to run (openapi, client, manifest)")
    .action(
      async (
        subcommand: string | undefined,
        _opts: object,
        command: Command,
      ) => {
        const project = await projectOf(command);
        if (subcommand !== undefined || !project.file) {
          console.error(
            `Unknown generator: ${subcommand ?? "(none)"}. Available: openapi, client, manifest`,
          );
          process.exit(1);
        }
        // With a config, bare `brick gen` writes everything the config names.
        const manifest = await writeServiceManifest(project);
        console.log(`Services manifest written to ${manifest}`);
        if (project.config.client?.output) {
          await writeClientContract(project.entry, project.contract);
          console.log(`Client contract written to ${project.contract}`);
        }
        const openapi = fromRoot(project, project.config.openapi?.output);
        if (openapi) {
          await writeOpenApi(project.entry, openapi, project);
          console.log(`✅ OpenAPI 3.1 specification written to ${openapi}`);
        }
      },
    );

  gen
    .command("openapi")
    .description("Generate OpenAPI 3.1 JSON specification")
    .argument("[entry]", "Application entry file")
    .option(
      "--output <file>",
      "Write specification to file instead of stdout",
      (v: string) =>
        parseFileOption(
          v,
          "Usage: brick gen openapi <entry> [--output <file>]",
        ),
    )
    .action(
      async (
        entry: string | undefined,
        opts: { output?: string },
        command: Command,
      ) => {
        const project = await projectOf(command);
        const output =
          opts.output ?? fromRoot(project, project.config.openapi?.output);
        const json = await writeOpenApi(
          requireEntry(command, entry, project),
          output,
          project,
        );
        if (output)
          console.log(`✅ OpenAPI 3.1 specification written to ${output}`);
        else console.log(json);
      },
    );

  gen
    .command("client")
    .description("Generate a typed browser client contract")
    .argument("[entry]", "Application entry file")
    .option(
      "--output <file>",
      "Write contract to file (default _brick/contract.ts)",
      (v: string) =>
        parseFileOption(v, "Usage: brick gen client <entry> [--output <file>]"),
    )
    .action(
      async (
        entry: string | undefined,
        opts: { output?: string },
        command: Command,
      ) => {
        const project = await projectOf(command);
        const target = requireEntry(command, entry, project);
        if (project.file) await writeServiceManifest(project);
        const output = await writeClientContract(
          target,
          opts.output ?? project.contract,
        );
        console.log(`Client contract written to ${output}`);
      },
    );

  gen
    .command("manifest")
    .description(
      "Write <generated>/services.gen.ts, which imports every definition file",
    )
    .action(async (_opts: object, command: Command) => {
      const output = await writeServiceManifest(await projectOf(command));
      console.log(`Services manifest written to ${output}`);
    });

  const db = program
    .command("db")
    .description(
      "Manage the app's database schema with drizzle-kit: generate, migrate, push",
    );
  const dbCommand = (
    name: "generate" | "migrate" | "push",
    description: string,
  ) =>
    db
      .command(name)
      .description(description)
      .argument("[entry]", "Application entry file");
  // push writes no files, so only generate and migrate take --out.
  const OUT_HELP =
    "Migrations folder (default drizzle, beside brick.config.ts); each database gets a subfolder named after it";
  const dbAction =
    (name: "generate" | "migrate" | "push") =>
    async (
      entry: string | undefined,
      opts: { out?: string; name?: string; force?: boolean },
      command: Command,
    ) => {
      const project = await projectOf(command);
      const app = await loadProjectApp(
        requireEntry(command, entry, project),
        project,
      );
      await runDbCommand(name, app, {
        out: opts.out ?? fromRoot(project, "drizzle")!,
        name: opts.name,
        force: opts.force,
      });
    };
  dbCommand(
    "generate",
    "Write a SQL migration for the schema changes since the last one",
  )
    .option("--out <dir>", OUT_HELP)
    .option("--name <name>", "Migration name (default migration)")
    .action(dbAction("generate"));
  dbCommand("migrate", "Apply the migrations that have not run yet")
    .option("--out <dir>", OUT_HELP)
    .action(dbAction("migrate"));
  dbCommand(
    "push",
    "Change the database to match the schema directly, without migration files (development)",
  )
    .option("--force", "Apply changes that drop data")
    .action(dbAction("push"));

  program
    .command("lint")
    .description("Check the project against the Brick lint rules")
    .argument("[entry]", "Application entry file")
    .action(
      async (entry: string | undefined, _opts: object, command: Command) => {
        const project = await projectOf(command);
        const code = await runLint({ entry, project });
        if (code !== 0) process.exit(code);
      },
    );

  program
    .command("info")
    .alias("services")
    .description("Export architecture JSON schema")
    .argument("[entry]", "Application entry file")
    .action(
      async (entry: string | undefined, _opts: object, command: Command) => {
        const project = await projectOf(command);
        const app = await loadProjectApp(
          requireEntry(command, entry, project),
          project,
        );
        const architecture = getGlobalRegistry().exportArchitecture(
          app.definition,
        );
        console.log(JSON.stringify(architecture, null, 2));
      },
    );

  return program;
}

async function main() {
  const program = createProgram();
  await program.parseAsync(
    process.argv.length > 2 ? process.argv : [...process.argv, "dev"],
  );
}

main().catch((err) => {
  // Commander already prints validation errors (missing arg, unknown option,
  // invalid port) and exits. Only print Fatal error for action failures.
  if (err?.exitCode !== undefined) {
    process.exit(err.exitCode);
  }
  if (err?.code?.startsWith?.("commander.")) {
    process.exit(1);
  }
  // A config error already names the file and key; a stack adds nothing.
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  console.error("Fatal error:", err);
  process.exit(1);
});
