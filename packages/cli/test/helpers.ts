import { mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { context, propagation, trace } from "@opentelemetry/api";
import { GLOBAL_SYMBOL } from "@brickkit/core";
import { captureConsole } from "../src/dev-telemetry";

export const CLI = resolve(import.meta.dir, "../src/bin.ts");

/** A port nothing listens on now. Fixed ports collide on CI runners. */
export function freePort(): number {
  const listener = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = listener.port!;
  listener.stop(true);
  return port;
}

/** Poll `check` until it holds; throws after `timeout` ms. */
export async function waitFor(
  check: () => unknown,
  timeout = 15_000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  if (await check()) return;
  throw new Error(`Timed out after ${timeout} ms waiting for ${what}`);
}

/** Wait until `read()` holds `text`; a spawned server can take seconds to start on a cold CI runner. */
export async function waitForOutput(
  read: () => string,
  text: string,
  timeout = 15_000,
): Promise<void> {
  await waitFor(() => read().includes(text), timeout).catch(() => {
    throw new Error(`No "${text}" after ${timeout} ms. Output:\n${read()}`);
  });
}

/**
 * Wait out a window in which nothing should happen. A negative check can only
 * pass by waiting, so keep these few and short.
 */
export const settle = (ms = 300) => Bun.sleep(ms);

/** A child's stdout and stderr, collected together as they arrive. */
export function capture(child: ReturnType<typeof Bun.spawn>) {
  let output = "";
  const collect = async (stream: typeof child.stdout) => {
    if (typeof stream === "number" || !stream) return;
    for await (const chunk of stream) output += new TextDecoder().decode(chunk);
  };
  const finished = Promise.all([collect(child.stdout), collect(child.stderr)]);
  return { read: () => output, finished };
}

/**
 * A new folder under this package's gitignored `.brick/`, where files written
 * into it still resolve the package's dependencies (an OS temp folder would
 * not). Remove it when done.
 */
export async function tempProject(prefix: string): Promise<string> {
  const parent = resolve(import.meta.dir, "../.brick");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, `${prefix}-`));
}

/** Run `brick` from source and wait for it to exit. */
export async function runCli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {},
) {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...options.env },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

/**
 * No tracing, no log capture, and the real console. A tracer provider another
 * test file left registered would leave `installTracing` nothing to install.
 */
export function resetTracing(): void {
  captureConsole()();
  (globalThis as Record<symbol, unknown>)[
    Symbol.for(GLOBAL_SYMBOL.logsCapture)
  ] = undefined;
  trace.disable();
  context.disable();
  propagation.disable();
}

/** Node's [major, minor] version, or undefined when `node` is not installed. */
export function nodeVersion(): [number, number] | undefined {
  if (!Bun.which("node")) return undefined;
  const [major = 0, minor = 0] = Bun.spawnSync(["node", "--version"])
    .stdout.toString()
    .trim()
    .replace(/^v/, "")
    .split(".")
    .map(Number);
  return [major, minor];
}

/** `ok`, after saying why the tests it gates are skipped when it is false. */
export function runsIf(ok: boolean, reason: string): boolean {
  if (!ok) console.warn(`Skipping: ${reason}`);
  return ok;
}
