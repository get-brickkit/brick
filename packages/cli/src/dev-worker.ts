import { getGlobalRegistry, stopAllEvents } from "@brickkit/core";
import { startInspector } from "./dev-inspector";
import { startDevApplication } from "./dev-application";
import type { WorkerErrorPhase } from "./dashboard-protocol";
import { sendToSupervisor, type WorkerOptions } from "./dev-protocol";
import { installWorkerTelemetry, reportWorkerError } from "./dev-telemetry";

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

const options: WorkerOptions = JSON.parse(process.argv[2]!);
const { telemetry } = options;
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
{
  const files = new Set<string>();
  try {
    await Bun.build({
      entrypoints: [options.entry],
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
    // Awaited: a build error ends this process, and the list must arrive first.
    await sendToSupervisor({ type: "brick:dependencies", files: [...files] });
  }
}

try {
  const app = await startDevApplication(options);
  startupComplete = true;
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
    if (!app.definition.telemetry)
      console.warn(
        "[Brick-TS] The dashboard shows no requests: pass { telemetry: true } to brick() in your app entry.",
      );
  }
} catch (error) {
  await reportOnce("startup", error);
  throw error;
}
