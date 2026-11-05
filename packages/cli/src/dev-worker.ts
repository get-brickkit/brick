import { getGlobalRegistry, remoteEnv, stopAllEvents } from "@brickkit/core";
import { startInspector } from "./dev-inspector";
import { startDevApplication } from "./runner";
import { parsePort } from "./port-utils";
import {
  installWorkerTelemetry,
  reportWorkerError,
  sendToSupervisor,
} from "./dev-telemetry";
import type { WorkerErrorPhase } from "./dev-telemetry";

let stopping = false;
// A reload stops this process. Deliveries cut off would stay claimed, and wait
// a minute (claimTimeoutMs) before the next process takes them. Stop every
// started hub: an event emitted while the entry still loads starts one.
const stop = () => {
  if (stopping) return;
  stopping = true;
  void Promise.race([stopAllEvents(), Bun.sleep(3000)])
    .catch((error: unknown) =>
      console.error(
        `[Brick-TS] Could not stop the events: ${error instanceof Error ? error.message : String(error)}`,
      ),
    )
    .finally(() => process.exit(0));
};
process.on("SIGTERM", stop);
if (process.connected && typeof process.send === "function") {
  // The terminal also signals the supervisor, which sends SIGTERM and waits for us.
  process.on("SIGINT", () => {});
  process.on("disconnect", stop);
} else {
  process.on("SIGINT", stop);
}

// argv[6] is "1" when the supervisor serves the dashboard and needs spans.
const telemetry = process.argv[6] === "1";
let startupComplete = false;
let reported = false;

async function reportOnce(phase: WorkerErrorPhase, error: unknown) {
  if (!telemetry || reported) return;
  reported = true;
  await reportWorkerError(phase, error);
}

async function exitAfterFailure(phase: WorkerErrorPhase, error: unknown) {
  await reportOnce(phase, error);
  console.error(error);
  process.exit(1);
}

if (telemetry) {
  installWorkerTelemetry();
  // Failures before the app is listening are startup failures, not crashes.
  const phaseOf = (): WorkerErrorPhase =>
    startupComplete ? "uncaught" : "startup";
  process.on("uncaughtException", (error) => {
    void exitAfterFailure(phaseOf(), error);
  });
  process.on("unhandledRejection", (reason) => {
    void exitAfterFailure(
      startupComplete ? "unhandled-rejection" : "startup",
      reason,
    );
  });
}

// Scan local imports so dependencies outside the app directory are watched too.
if (process.argv[2]) {
  const files = new Set<string>();
  try {
    await Bun.build({
      entrypoints: [process.argv[2]],
      target: "bun",
      packages: "external",
      plugins: [
        {
          name: "brick:dependencies",
          setup(build) {
            build.onLoad({ filter: /./ }, (args) => {
              files.add(args.path);
              return undefined;
            });
          },
        },
      ],
    });
  } finally {
    process.send?.({ type: "brick:dependencies", files: [...files] });
  }
}

try {
  const app = await startDevApplication({
    entry: process.argv[2],
    port: parsePort(process.argv[3] || undefined, process.env.PORT),
    prefix: process.argv[4] || undefined,
    clientOutput: process.argv[5] || undefined,
    root: process.argv[7] || undefined,
  });
  startupComplete = true;
  // The supervisor runs the Go and Rust services and answers with their addresses.
  if (app.definition.remote?.length) {
    process.on("message", (message: { type?: string; urls?: unknown }) => {
      if (message?.type === "brick:services")
        process.env.BRICK_SERVICES = JSON.stringify(message.urls);
    });
    process.send?.({
      type: "brick:remote",
      remote: app.definition.remote.map(({ options }) => ({
        name: options.name,
        dir: options.dir,
        dev: options.dev,
        port: options.port,
      })),
      services: app.definition.services.map((service) => service.name),
      env: remoteEnv(app.definition),
    });
  }
  if (telemetry) {
    void sendToSupervisor({
      type: "brick:architecture",
      architecture: getGlobalRegistry().exportArchitecture(app.definition),
    });
    void sendToSupervisor({
      type: "brick:documentation",
      documentation: app.definition.documentation,
    });
    void app.referenceDocuments().then(
      (documents) =>
        sendToSupervisor({ type: "brick:api-documents", documents }),
      (error: unknown) =>
        console.warn(
          `[Brick-TS] Could not load the API documents: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }
  if (telemetry) {
    void startInspector(app).then(
      (inspector) =>
        inspector &&
        sendToSupervisor({
          type: "brick:inspector",
          port: inspector.port,
          token: inspector.token,
        }),
      (error: unknown) =>
        console.warn(
          `[Brick-TS] Could not start the workflow inspector: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }
  if (telemetry && !app.definition.telemetry) {
    console.warn(
      "[Brick-TS] The dashboard shows no requests: pass { telemetry: true } to brick() in your app entry.",
    );
  }
} catch (error) {
  await reportOnce("startup", error);
  throw error;
}
