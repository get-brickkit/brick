import type {
  ApiDocument,
  ArchitectureSchema,
  DocumentationOptions,
} from "@brickkit/core";
import type {
  SerializedError,
  TelemetryRecord,
  WorkerErrorPhase,
} from "./dashboard-protocol";

const SEND_TIMEOUT_MS = 1000;

/*
 * What `brick dev`'s supervisor and its worker process agree on: the options
 * the worker starts with, and the messages it sends back over IPC.
 */

/** The worker's one argument, as JSON. */
export interface WorkerOptions {
  /** Absolute path of the app entry. */
  entry: string;
  port: number;
  prefix?: string;
  /** Absolute path of the browser contract to write before serving. */
  clientOutput?: string;
  /** The supervisor serves the dashboard, so the worker reports its spans. */
  telemetry: boolean;
}

/** Messages the dev worker sends to the supervisor over the IPC channel. */
export type WorkerMessage =
  | { type: "brick:telemetry"; records: TelemetryRecord[] }
  | { type: "brick:error"; phase: WorkerErrorPhase; error: SerializedError }
  | { type: "brick:architecture"; architecture: ArchitectureSchema }
  | { type: "brick:api-documents"; documents: ApiDocument[] }
  | {
      type: "brick:inspector";
      /** The loopback port the workflow inspector listens on. */
      port: number;
      /** What the dashboard sends with each request to prove who it is. */
      token: string;
    }
  | {
      type: "brick:documentation";
      /** The app's `documentation` option; absent when it has none. */
      documentation?: DocumentationOptions;
    }
  /** The local files the entry imports, for the supervisor to watch. */
  | { type: "brick:dependencies"; files: string[] }
  /** The browser contract is written; the frontend may start. */
  | { type: "brick:contract-ready" };

/** Resolves once the message is written, or after a short timeout if the channel is gone. */
export function sendToSupervisor(message: WorkerMessage): Promise<void> {
  if (!process.send) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, SEND_TIMEOUT_MS);
    try {
      process.send!(message, () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}
