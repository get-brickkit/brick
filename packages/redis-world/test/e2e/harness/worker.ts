import { type ChildProcess, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  DIST_ENTRY,
  PACKAGE_NAME,
  PKG_ROOT,
  SERVER_ENTRY,
  TARGET_WORLD_ENTRY,
} from "./paths.js";
import type { WorldTuning } from "./world.js";

export interface WorkerOptions {
  name: string;
  redisUrl: string;
  keyPrefix: string;
  /** WORKFLOW_REDIS_JOB_PREFIX, for a queue that keeps its keys elsewhere. */
  jobPrefix?: string;
  /**
   * With no tuning the worker loads the package by name
   * (WORKFLOW_TARGET_WORLD=@brickkit/<world>) and configures it
   * only through its documented WORKFLOW_REDIS_* variables. With tuning, it
   * loads target-world.mjs, which wraps the same built package.
   */
  tuning?: WorldTuning;
  /** WORKFLOW_REDIS_WORKER_CONCURRENCY. */
  concurrency?: number;
  readyTimeoutMs?: number;
}

/** One worker process: a server.mts instance with its own port and queue worker. */
export class WorkerProc {
  readonly output: string[] = [];
  readonly exited: Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  port = 0;
  pid = 0;

  private constructor(
    readonly name: string,
    private readonly proc: ChildProcess,
  ) {
    this.exited = new Promise((resolve) =>
      proc.once("exit", (code, signal) => resolve({ code, signal })),
    );
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get alive(): boolean {
    return this.proc.exitCode === null && this.proc.signalCode === null;
  }

  static async spawn(opts: WorkerOptions): Promise<WorkerProc> {
    const tuned =
      opts.tuning !== undefined && Object.keys(opts.tuning).length > 0;
    const proc = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: PKG_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        WORKFLOW_TARGET_WORLD: tuned ? TARGET_WORLD_ENTRY : PACKAGE_NAME,
        WORKFLOW_REDIS_URL: opts.redisUrl,
        REDIS_URL: opts.redisUrl,
        WORKFLOW_REDIS_KEY_PREFIX: opts.keyPrefix,
        ...(opts.jobPrefix && { WORKFLOW_REDIS_JOB_PREFIX: opts.jobPrefix }),
        E2E_WORLD_ENTRY: pathToFileURL(DIST_ENTRY).href,
        WORKFLOW_REDIS_WORKER_CONCURRENCY: String(opts.concurrency ?? 10),
        E2E_WORLD_CONFIG: JSON.stringify(opts.tuning ?? {}),
        E2E_WORKER_NAME: opts.name,
        NODE_NO_WARNINGS: "1",
      },
    });
    const worker = new WorkerProc(opts.name, proc);
    let buffered = "";
    const ready = new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        const text = String(chunk);
        worker.output.push(text);
        buffered += text;
        const match = /E2E_READY (\{.*\})/.exec(buffered);
        if (match?.[1]) {
          const info = JSON.parse(match[1]) as { port: number; pid: number };
          worker.port = info.port;
          worker.pid = info.pid;
          resolve();
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", (chunk: Buffer) =>
        worker.output.push(String(chunk)),
      );
      void worker.exited.then(({ code, signal }) =>
        reject(
          new Error(
            `worker ${opts.name} exited before it was ready (code=${code} signal=${signal}):\n${worker.log()}`,
          ),
        ),
      );
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `worker ${opts.name} not ready after ${opts.readyTimeoutMs ?? 60_000}ms:\n${worker.log()}`,
            ),
          ),
        opts.readyTimeoutMs ?? 60_000,
      );
    });
    try {
      await Promise.race([ready, timeout]);
    } catch (error) {
      proc.kill("SIGKILL");
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return worker;
  }

  /** Everything the worker wrote to stdout/stderr (the last `tail` lines). */
  log(tail = 200): string {
    return this.output.join("").split("\n").slice(-tail).join("\n");
  }

  /** Stop it and wait until it is gone. Default is the crash: SIGKILL. */
  async kill(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    if (!this.alive) return;
    this.proc.kill(signal);
    await this.exited;
  }

  async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.url}${path}`, init);
    const text = await res.text();
    if (!res.ok)
      throw new Error(
        `${init?.method ?? "GET"} ${path} on ${this.name} -> ${res.status}: ${text.slice(0, 2000)}`,
      );
    return JSON.parse(text) as T;
  }
}
