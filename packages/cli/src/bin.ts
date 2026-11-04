#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { startDevServer, startProdServer, startWorker } from "./runner";
import { DEFAULT_DASHBOARD_PORT } from "./dev-dashboard";
import { DEFAULT_HISTORY_DAYS } from "./dev-history";
import { buildApplication } from "./build";
import { writeClientContract } from "./client-contract-file";
import { buildRemoteServices, writePolyglotContract } from "./polyglot";
import { parseDeployTargets, writeDeploy } from "./deploy";
import { generateOpenApiSpec, getGlobalRegistry } from "@brickkit/core";
import { parsePort, resolveDevPort } from "./port-utils";
import { loadBrickApp } from "./app-entry";
import { ConfigError, loadConfig, type LoadedConfig } from "./config";
import { writeServiceManifest } from "./manifest";
import { runLint } from "./lint";
import { runDbCommand } from "./db";
import cliPkg from "../package.json";

// Single source of truth for the CLI version (inlined at build time).
const CLI_VERSION: string = cliPkg.version;

const PORT_HELP =
  "Port to listen on (CLI --port overrides PORT env, default 4000)";

const EXTENSION_HELP =
  "Dashboard extension module (default export defineDashboard(...)), or the dashboard folder brick build wrote";

const PORT_RESOLUTION_HELP = `
Port Resolution (dev/start commands):
  - CLI --port flag takes precedence
  - Falls back to PORT environment variable
  - Then dev.port in brick.config.ts (brick dev only)
  - Defaults to 4000 if none is set
  - Valid range: 1-65535

Examples:
  brick dev app.ts                        # port 4000 (default)
  brick dev app.ts --port 5000            # port 5000 (explicit)
  PORT=3000 brick dev app.ts              # port 3000 (from env)
  brick dev app.ts --port 6000            # port 6000 (CLI overrides PORT=3000)
`;

const CONFIG_HELP =
  "Path to brick.config.ts (default: the nearest one in this folder or its parents)";

type ConfigOpts = { config?: string };

function parsePortOption(value: string): number {
  try {
    return parsePort(value, undefined);
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

/** `--config` on a `gen` subcommand: commander hands it to `gen`, which takes it too. */
function configOf(command: Command): string | undefined {
  return command.optsWithGlobals<ConfigOpts>().config;
}

/** The entry argument, else the config's entry; without either, commander's usual error. */
function requireEntry(
  command: Command,
  entry: string | undefined,
  project: LoadedConfig | undefined,
): string {
  const resolved = entry ?? project?.entry;
  if (!resolved)
    command.error("error: missing required argument 'entry'", {
      exitCode: 1,
      code: "commander.missingArgument",
    });
  return resolved!;
}

/** Load the app after refreshing the services manifest it imports. */
async function loadProjectApp(
  entry: string,
  project: LoadedConfig | undefined,
) {
  if (project) await writeServiceManifest(project);
  return loadBrickApp(entry);
}

/** A config path, made absolute from the config file's folder. */
function fromRoot(
  project: LoadedConfig | undefined,
  path: string | undefined,
): string | undefined {
  return path && project ? resolve(project.root, path) : path;
}

/** The config's dashboard settings; a `--dashboard-extension` flag replaces its extension. */
function configDashboard(
  project: LoadedConfig | undefined,
  extensionFlag?: string,
) {
  const dashboard = project?.config.dashboard;
  if (!dashboard && !extensionFlag) return undefined;
  return {
    extension: extensionFlag ?? fromRoot(project, dashboard?.extension),
    theme: dashboard?.theme,
  };
}

async function writeOpenApi(
  entry: string,
  output: string | undefined,
  project: LoadedConfig | undefined,
) {
  const app = await loadProjectApp(entry, project);
  const spec = generateOpenApiSpec({
    services: [...app.definition.services],
    prefix: app.definition.prefix,
  });
  const json = JSON.stringify(spec, null, 2);
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
    .addHelpText(
      "after",
      `
Usage:
  brick dev [entry] [--port <number>] [--dashboard-port <number>] [--history-days <number>] [--no-dashboard]  Start development server with live reload and dashboard
  brick start [entry] [--port <number>]                  Start production server
  brick worker <entry>                                   Deliver events without serving HTTP
  brick build <app.ts> [--outdir <dir>] [--port <number>] [--no-aot] [--deploy <targets>] [--domain <host>]  Compile a default-exported BrickApp into a Bun server (--deploy is experimental)
  brick gen openapi <entry> [--output <file>]            Generate OpenAPI 3.1 JSON specification
  brick gen client <entry> [--output <file>]             Generate a typed browser client contract
  brick gen contract <entry> [--output <file>]           Merge every service (TS, Go, Rust) into _brick/contract.json and write the TS, Go and Rust clients (experimental)
  brick gen manifest                                     Write <generated>/services.gen.ts
  brick db generate [entry] [--out <dir>] [--name <name>]  Write a SQL migration for the schema changes
  brick db migrate [entry] [--out <dir>]                 Apply the migrations that have not run yet
  brick db push [entry] [--force]                        Change the database to match the schema (development)
  brick lint [entry]                                     Check the project against the Brick lint rules
  brick info <entry>                                     Export architecture JSON schema

With a brick.config.ts, the entry and most flags come from the config file,
and every command takes --config <path>.
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
    .option("--config <path>", CONFIG_HELP)
    .addHelpText("after", PORT_RESOLUTION_HELP)
    .action(
      async (
        entryArg: string | undefined,
        opts: ConfigOpts & {
          port?: number;
          client?: string;
          frontend?: string;
          dashboardPort?: number;
          historyDays?: number;
          dashboard?: boolean;
          dashboardExtension?: string;
        },
      ) => {
        const project = await loadConfig(opts.config);
        const config = project?.config;
        const entry = entryArg ?? project?.entry;
        const port = resolveDevPort(opts.port, config?.dev?.port);
        if (opts.dashboard === false && opts.dashboardPort !== undefined) {
          throw new Error(
            "Brick: --dashboard-port cannot be combined with --no-dashboard.",
          );
        }
        if (opts.dashboard === false && opts.historyDays !== undefined) {
          throw new Error(
            "Brick: --history-days cannot be combined with --no-dashboard.",
          );
        }
        const configured = config?.dev?.dashboard;
        // The config can turn the dashboard off; a dashboard flag turns it back on.
        const dashboardOff =
          opts.dashboard === false ||
          (configured === false &&
            opts.dashboardPort === undefined &&
            opts.historyDays === undefined);
        const dashboardConfig = configured || undefined;
        if (dashboardOff && opts.dashboardExtension) {
          throw new Error(
            "Brick: --dashboard-extension cannot be combined with --no-dashboard.",
          );
        }
        await startDevServer({
          entry,
          port,
          clientOutput:
            opts.client ?? fromRoot(project, config?.client?.output),
          frontend: opts.frontend ?? config?.dev?.frontend,
          // The dashboard reads the app's requests, so it needs an entry.
          dashboard:
            entry && !dashboardOff
              ? {
                  port:
                    opts.dashboardPort ??
                    dashboardConfig?.port ??
                    DEFAULT_DASHBOARD_PORT,
                  historyDays: opts.historyDays ?? dashboardConfig?.historyDays,
                  ...configDashboard(project, opts.dashboardExtension),
                }
              : false,
          manifest: project,
        });
      },
    );

  program
    .command("start")
    .description("Start production server")
    .argument("[entry]", "Application entry file")
    .option("--port <number>", PORT_HELP, parsePortOption)
    .option("--dashboard-extension <file>", EXTENSION_HELP)
    .option("--config <path>", CONFIG_HELP)
    .addHelpText("after", PORT_RESOLUTION_HELP)
    .action(
      async (
        entry: string | undefined,
        opts: ConfigOpts & { port?: number; dashboardExtension?: string },
      ) => {
        const project = await loadConfig(opts.config);
        const port = resolveDevPort(opts.port);
        await startProdServer({
          entry: entry ?? project?.entry,
          port,
          dashboard: configDashboard(project, opts.dashboardExtension),
        });
      },
    );

  program
    .command("worker")
    .description("Deliver the app's events without serving HTTP")
    .argument(
      "[entry]",
      "Application entry file (must default-export a BrickApp)",
    )
    .option("--config <path>", CONFIG_HELP)
    .action(
      async (entry: string | undefined, opts: ConfigOpts, command: Command) => {
        const project = await loadConfig(opts.config);
        await startWorker({ entry: requireEntry(command, entry, project) });
      },
    );

  program
    .command("build")
    .description("Compile a default-exported BrickApp into a Bun server")
    .argument(
      "[entry]",
      "Application entry file (must default-export a BrickApp)",
    )
    .option("--config <path>", CONFIG_HELP)
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
      "--deploy <targets>",
      "Experimental: also write production routing into deploy/<target>/: caddy, nginx, traefik, kubernetes, compose, routes (comma-separated)",
      (v: string) => {
        try {
          return parseDeployTargets(v);
        } catch (err) {
          throw new InvalidArgumentError((err as Error).message);
        }
      },
    )
    .option(
      "--domain <host>",
      "Public host name for --deploy (HTTPS in Caddy and Traefik, TLS in Kubernetes)",
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
        opts: ConfigOpts & {
          outdir?: string;
          port?: number;
          aot?: boolean;
          prefix?: string;
          requestLogging?: boolean;
          dashboardExtension?: string;
          deploy?: ReturnType<typeof parseDeployTargets>;
          domain?: string;
        },
        command: Command,
      ) => {
        if (opts.prefix !== undefined || opts.requestLogging === false) {
          throw new Error(
            "Brick: configure prefix and requestLogging in your default-exported brick() app instead of build flags.",
          );
        }
        const project = await loadConfig(opts.config);
        const build = project?.config.build;
        // shortcut: brick() sets up request logging when the app is created, so
        // a build cannot switch it off; only the default (true) is accepted.
        if (build?.requestLogging === false)
          throw new Error(
            "Brick: configure requestLogging in your default-exported brick() app instead of build.requestLogging.",
          );
        const entry = requireEntry(command, entryArg, project);
        if (project) await writeServiceManifest(project);
        const result = await buildApplication({
          entry,
          outdir: opts.outdir ?? fromRoot(project, build?.outdir),
          port: opts.port,
          // --no-aot can only switch it off, so otherwise the config decides.
          aot: opts.aot === false ? false : build?.aot,
          dashboard: configDashboard(project, opts.dashboardExtension),
        });
        const app = await loadBrickApp(entry);
        buildRemoteServices(app);
        const deploy = project?.config.deploy;
        const targets = opts.deploy ?? deploy?.targets;
        if (targets?.length) {
          const written = await writeDeploy(app, {
            ...deploy,
            targets,
            domain: opts.domain ?? deploy?.domain,
            root: project?.root,
          });
          for (const file of written) console.log(`Deploy: ${file}`);
        }
        for (const warning of result.ir.diagnostics)
          console.warn(`[Brick compiler] ${warning}`);
        console.log(
          `Compiled ${result.ir.services.length} services / ${result.ir.routes.length} routes`,
        );
        console.log(`IR: ${result.outdir}/brick-ir.json`);
        if (result.dashboard)
          console.log(`Dashboard extension: ${result.dashboard}`);
        console.log(`Run: bun ${result.entry}`);
      },
    );

  const gen = program
    .command("gen")
    .description("Generate artifacts from a BrickApp entry")
    .argument("[subcommand]", "Generator to run (openapi, client, manifest)")
    .option("--config <path>", CONFIG_HELP)
    .action(async (subcommand: string | undefined, opts: ConfigOpts) => {
      const project =
        subcommand === undefined ? await loadConfig(opts.config) : undefined;
      if (!project) {
        console.error(
          `Unknown generator: ${subcommand ?? "(none)"}. Available: openapi, client, manifest`,
        );
        process.exit(1);
      }
      // With a config, bare `brick gen` writes everything the config names.
      const manifest = await writeServiceManifest(project);
      console.log(`Services manifest written to ${manifest}`);
      const client = fromRoot(project, project.config.client?.output);
      // An app with Go or Rust services gets the merged contract and their clients.
      const polyglot = await writePolyglotContract(project.entry, client);
      if (polyglot) {
        for (const file of polyglot) console.log(`Written ${file}`);
      } else if (client) {
        await writeClientContract(project.entry, client);
        console.log(`Client contract written to ${client}`);
      }
      const openapi = fromRoot(project, project.config.openapi?.output);
      if (openapi) {
        await writeOpenApi(project.entry, openapi, project);
        console.log(`✅ OpenAPI 3.1 specification written to ${openapi}`);
      }
    });

  gen
    .command("openapi")
    .description("Generate OpenAPI 3.1 JSON specification")
    .argument("[entry]", "Application entry file")
    .option("--config <path>", CONFIG_HELP)
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
        opts: ConfigOpts & { output?: string },
        command: Command,
      ) => {
        const project = await loadConfig(configOf(command));
        const output =
          opts.output ?? fromRoot(project, project?.config.openapi?.output);
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
    .option("--config <path>", CONFIG_HELP)
    .option(
      "--output <file>",
      "Write contract to file (default _brick/contract.ts)",
      (v: string) =>
        parseFileOption(v, "Usage: brick gen client <entry> [--output <file>]"),
    )
    .action(
      async (
        entry: string | undefined,
        opts: ConfigOpts & { output?: string },
        command: Command,
      ) => {
        const project = await loadConfig(configOf(command));
        const target = requireEntry(command, entry, project);
        if (project) await writeServiceManifest(project);
        const output = await writeClientContract(
          target,
          opts.output ??
            fromRoot(project, project?.config.client?.output) ??
            (project && join(project.generated, "contract.ts")),
        );
        console.log(`Client contract written to ${output}`);
      },
    );

  gen
    .command("contract")
    .description(
      "Experimental: merge every service (TS, Go, Rust) into _brick/contract.json and write the TS, Go and Rust clients",
    )
    .argument("[entry]", "Application entry file")
    .option("--config <path>", CONFIG_HELP)
    .option(
      "--output <file>",
      "Write the TS contract to file (default _brick/contract.ts)",
      (v: string) =>
        parseFileOption(
          v,
          "Usage: brick gen contract <entry> [--output <file>]",
        ),
    )
    .action(
      async (
        entry: string | undefined,
        opts: ConfigOpts & { output?: string },
        command: Command,
      ) => {
        const project = await loadConfig(configOf(command));
        const target = requireEntry(command, entry, project);
        const output =
          opts.output ?? fromRoot(project, project?.config.client?.output);
        const written = await writePolyglotContract(target, output);
        if (!written) {
          await writeClientContract(target, output);
          console.log("No remote services: wrote the TS contract only.");
          return;
        }
        for (const file of written) console.log(`Written ${file}`);
      },
    );

  gen
    .command("manifest")
    .description(
      "Write <generated>/services.gen.ts, which imports every definition file",
    )
    .option("--config <path>", CONFIG_HELP)
    .action(async (_opts: ConfigOpts, command: Command) => {
      const project = await loadConfig(configOf(command));
      const output = await writeServiceManifest(
        project ?? {
          services: resolve("src/services"),
          generated: resolve("_brick"),
        },
      );
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
      .argument("[entry]", "Application entry file")
      .option("--config <path>", CONFIG_HELP);
  // push writes no files, so only generate and migrate take --out.
  const OUT_HELP =
    "Migrations folder (default drizzle, beside brick.config.ts); each database gets a subfolder named after it";
  const dbAction =
    (name: "generate" | "migrate" | "push") =>
    async (
      entry: string | undefined,
      opts: ConfigOpts & { out?: string; name?: string; force?: boolean },
      command: Command,
    ) => {
      const project = await loadConfig(opts.config);
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
    .option("--config <path>", CONFIG_HELP)
    .action(async (entry: string | undefined, opts: ConfigOpts) => {
      const project = await loadConfig(opts.config);
      const code = await runLint({ entry, project });
      if (code !== 0) process.exit(code);
    });

  program
    .command("info")
    .alias("services")
    .description("Export architecture JSON schema")
    .argument("[entry]", "Application entry file")
    .option("--config <path>", CONFIG_HELP)
    .action(
      async (entry: string | undefined, opts: ConfigOpts, command: Command) => {
        const project = await loadConfig(opts.config);
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
  const userArgs = process.argv.slice(2);
  // With a config file, bare `brick` is `brick dev`.
  if (userArgs.length === 0 && (await loadConfig())) {
    await program.parseAsync([...process.argv, "dev"]);
    return;
  }
  // Preserve legacy behavior: bare `brick` starts the dev server.
  if (userArgs.length === 0) {
    const port = parsePort(undefined, process.env.PORT);
    await startDevServer({ port });
    return;
  }
  await program.parseAsync(process.argv);
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
