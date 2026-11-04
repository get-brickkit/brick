import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { kebabCase } from "./kebab";
import { toErrorResponse } from "./error-response";
import { createLogger } from "./logger";
import type { NamedService } from "./rpc";
import { ActionExecutionError, type BaseContext } from "./types";

/** What a remote service's `context` hook may resolve for the gateway to forward. */
export interface RemoteContext {
  user?: unknown;
  tenantId?: string;
}

export interface RemoteServiceOptions<N extends string = string> {
  /** The service name: the gateway serves it at `/api/<kebab-name>/<action>`. */
  name: N;
  /** The service's folder (Go module or Cargo crate), relative to the working directory. */
  dir: string;
  /** What `brick dev` runs in `dir`, and restarts when a file in `dir` changes: `go run .` or `cargo run -q`. */
  dev: string;
  /**
   * Production: `command` builds the release binary once (`brick build`),
   * `run` starts it (`brick start`). Both run in `dir`.
   */
  build?: { command: string; run: string };
  /** The loopback port the child listens on (default: a free port at spawn). */
  port?: number;
  /**
   * Works out the caller from the public request, as a TS service's `context`
   * hook does: the gateway forwards `user` and `tenantId` to the child.
   */
  context?: (
    ctx: Pick<BaseContext, "request" | "requestId" | "traceId">,
  ) => RemoteContext | undefined | Promise<RemoteContext | undefined>;
}

/** A Go or Rust service, run as its own process and served through the Bun gateway. */
export interface RemoteService<
  N extends string = string,
> extends NamedService<N> {
  readonly kind: "remote";
  readonly name: N;
  readonly options: RemoteServiceOptions<N>;
}

const remotes = new Map<string, RemoteService>();

/**
 * Declare a service written in Go or Rust. Pass it to `brick({ remote })` to
 * serve its actions at `/api/<name>/<action>` through this app, and to
 * `useService` to call it from TS. Its actions are validated by the service
 * itself, not by Bun.
 *
 * @param options - `name`, `dir`, `dev`, and optionally `build`, `port` and `context`.
 * @returns The remote service.
 * @example
 * export const billing = remoteService({
 *   name: "billing",
 *   dir: "services/billing",
 *   dev: "go run .",
 *   build: { command: "go build -o bin/billing .", run: "./bin/billing" },
 *   context: ({ request }) => ({ user: userFrom(request) }),
 * });
 */
export function remoteService<const N extends string>(
  options: RemoteServiceOptions<N>,
): RemoteService<N> {
  const service = Object.freeze({
    kind: "remote" as const,
    name: options.name,
    options,
  });
  remotes.set(options.name, service);
  return service;
}

/** The remote service declared under `name`, if any. */
export function getRemoteService(name: string): RemoteService | undefined {
  return remotes.get(name);
}

/** True for what `remoteService` returned. */
export function isRemoteService(value: unknown): value is RemoteService {
  return (value as RemoteService | undefined)?.kind === "remote";
}

/**
 * The per-run token that marks a request as coming from inside the app:
 * `BRICK_INTERNAL_TOKEN`, or a random one this process makes and keeps in it.
 */
export function internalToken(): string {
  return (process.env.BRICK_INTERNAL_TOKEN ||= randomBytes(24).toString("hex"));
}

/** True when `value` is this run's internal token. */
export function isInternalToken(value: string | null | undefined): boolean {
  if (!value) return false;
  const expected = Buffer.from(internalToken());
  const given = Buffer.from(value);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

let urlsSource: string | undefined;
let urls: Record<string, string> = {};

/** `BRICK_SERVICES`: base URL by service name. */
export function serviceUrls(): Record<string, string> {
  const source = process.env.BRICK_SERVICES;
  if (source !== urlsSource) {
    urlsSource = source;
    urls = source ? JSON.parse(source) : {};
  }
  return urls;
}

/** @throws `SERVICE_UNAVAILABLE` (503) when the child has no known address yet. */
export function remoteUrl(remote: RemoteService): string {
  const url =
    serviceUrls()[remote.name] ??
    (remote.options.port ? `http://127.0.0.1:${remote.options.port}` : "");
  if (!url)
    throw new ActionExecutionError(
      "SERVICE_UNAVAILABLE",
      `Service '${remote.name}' is not running`,
      503,
    );
  return url;
}

/** The caller envelope as headers: the `x-brick-*` set plus request and trace ids. */
export interface CallEnvelope {
  requestId?: string;
  traceId?: string;
  caller?: string;
  user?: unknown;
  tenantId?: string;
}

export function envelopeHeaders(
  envelope: CallEnvelope,
  headers = new Headers(),
): Headers {
  headers.set("x-brick-internal", internalToken());
  if (envelope.requestId) headers.set("x-request-id", envelope.requestId);
  if (envelope.traceId) headers.set("x-trace-id", envelope.traceId);
  if (envelope.caller) headers.set("x-brick-caller", envelope.caller);
  if (envelope.tenantId) headers.set("x-brick-tenant", envelope.tenantId);
  if (envelope.user !== undefined && envelope.user !== null)
    headers.set(
      "x-brick-user",
      Buffer.from(JSON.stringify(envelope.user)).toString("base64"),
    );
  return headers;
}

/** The trusted envelope of a request from inside the app, or `undefined` without the token. */
export function trustedEnvelope(headers: Headers): CallEnvelope | undefined {
  if (!isInternalToken(headers.get("x-brick-internal"))) return undefined;
  const user = headers.get("x-brick-user");
  const envelope: CallEnvelope = {};
  if (user) envelope.user = JSON.parse(Buffer.from(user, "base64").toString());
  const caller = headers.get("x-brick-caller");
  if (caller) envelope.caller = caller;
  const tenant = headers.get("x-brick-tenant");
  if (tenant) envelope.tenantId = tenant;
  return envelope;
}

/**
 * Call one action of a remote service directly over loopback. A failure
 * becomes an `ActionExecutionError` with the child's code, status and details.
 */
export async function callRemoteAction(
  remote: RemoteService,
  action: string,
  input: unknown,
  envelope: CallEnvelope,
): Promise<unknown> {
  const headers = envelopeHeaders(envelope);
  headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${remoteUrl(remote)}/${kebabCase(action)}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input ?? {}),
    });
  } catch (cause) {
    if (cause instanceof ActionExecutionError) throw cause;
    throw new ActionExecutionError(
      "SERVICE_UNAVAILABLE",
      `Service '${remote.name}' is not reachable`,
      503,
      undefined,
      { cause },
    );
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (response.ok) return body;
  throw new ActionExecutionError(
    body?.code ?? "INTERNAL_SERVER_ERROR",
    body?.message ?? response.statusText,
    body?.status ?? response.status,
    body?.details ?? body?.errors,
  );
}

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "host",
];

let gatewaySeq = 0;
const gatewayLogger = createLogger("[brick:gateway]");

/**
 * The gateway handler for one remote service: resolves the caller with the
 * service's `context` hook, strips every `x-brick-*` header the client sent,
 * adds the trusted ones with the internal token, and proxies to the child.
 */
export function remoteGateway(remote: RemoteService, base: string) {
  return async (request: Request): Promise<Response> => {
    const seq = (++gatewaySeq).toString(36);
    const requestId = request.headers.get("x-request-id") || `req_g${seq}`;
    const traceId = request.headers.get("x-trace-id") || `tr_g${seq}`;
    const ids = { "x-request-id": requestId, "x-trace-id": traceId };
    try {
      const url = new URL(request.url);
      const headers = new Headers();
      for (const [key, value] of request.headers)
        if (!key.startsWith("x-brick-") && !HOP_BY_HOP.includes(key))
          headers.set(key, value);
      const resolved = await remote.options.context?.({
        request,
        requestId,
        traceId,
      });
      envelopeHeaders({ requestId, traceId, ...resolved }, headers);
      const target = `${remoteUrl(remote)}${url.pathname.slice(base.length) || "/"}${url.search}`;
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      const body = hasBody ? await request.arrayBuffer() : undefined;
      const response = await fetch(target, {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      }).catch((cause: unknown) => {
        throw new ActionExecutionError(
          "SERVICE_UNAVAILABLE",
          `Service '${remote.name}' is not reachable`,
          503,
          undefined,
          { cause },
        );
      });
      const out = new Headers(response.headers);
      for (const key of HOP_BY_HOP) out.delete(key);
      out.delete("content-encoding");
      for (const [key, value] of Object.entries(ids)) out.set(key, value);
      return new Response(response.body, {
        status: response.status,
        headers: out,
      });
    } catch (err) {
      // A context hook's own failure (UNAUTHORIZED, say) keeps its code; anything else is a logged 500.
      const envelope = toErrorResponse(err, {
        logger: gatewayLogger,
        requestId,
      });
      return Response.json(envelope, {
        status: envelope.status,
        headers: ids,
      });
    }
  };
}

/** A free loopback port. */
export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

export interface RemoteProcesses {
  /** `BRICK_SERVICES` as the children see it. */
  readonly urls: Record<string, string>;
  /** Restart one child (after its files changed). */
  restart(name: string): Promise<void>;
  /** Wait until every child answers on its port. */
  ready(timeoutMs?: number): Promise<void>;
  stop(): Promise<void>;
}

export interface StartRemoteOptions {
  /** `dev` runs each service's `dev` command; `start` its `build.run`. */
  mode: "dev" | "start";
  /** The Bun app's own origin, which the children call TS services through. */
  appUrl: string;
  /** The TS services' names, so children can call them. */
  services?: readonly string[];
  /** Where `dir` is relative to (default the working directory). */
  cwd?: string;
  /** Extra environment for every child. */
  env?: Record<string, string>;
}

/**
 * Spawn the children of the remote services next to the app, each on a
 * loopback port, with `BRICK_SERVICES`, `BRICK_PORT` and `BRICK_INTERNAL_TOKEN`.
 * Also sets `BRICK_SERVICES` in this process so the gateway finds them.
 */
export async function startRemoteServices(
  services: readonly RemoteService[],
  options: StartRemoteOptions,
): Promise<RemoteProcesses> {
  const ports: Record<string, number> = {};
  for (const remote of services)
    ports[remote.name] ??= remote.options.port ?? (await freePort());
  const urls: Record<string, string> = {};
  for (const name of options.services ?? [])
    urls[name] = `${options.appUrl}/_brick/call/${kebabCase(name)}`;
  for (const remote of services)
    urls[remote.name] = `http://127.0.0.1:${ports[remote.name]}`;
  process.env.BRICK_SERVICES = JSON.stringify(urls);
  const token = internalToken();
  const children = new Map<string, ChildProcess>();

  const launch = (remote: RemoteService) => {
    const command =
      options.mode === "dev" ? remote.options.dev : remote.options.build?.run;
    if (!command)
      throw new Error(
        `Brick: remote service "${remote.name}" has no build.run command for production.`,
      );
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: resolve(options.cwd ?? process.cwd(), remote.options.dir),
      // Its own process group, so `go run`/`cargo run` and the binary stop together.
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        ...options.env,
        BRICK_SERVICES: JSON.stringify(urls),
        BRICK_PORT: String(ports[remote.name]),
        BRICK_INTERNAL_TOKEN: token,
      },
    });
    children.set(remote.name, child);
  };
  const kill = async (name: string) => {
    const child = children.get(name);
    children.delete(name);
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((done) => child.once("exit", done));
    try {
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      return;
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, 3000);
    await exited;
    clearTimeout(timer);
  };
  for (const remote of services) launch(remote);

  return {
    urls,
    async restart(name) {
      const remote = services.find((service) => service.name === name);
      if (!remote) return;
      await kill(name);
      launch(remote);
    },
    async ready(timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs;
      for (const remote of services) {
        for (;;) {
          const ok = await fetch(`${urls[remote.name]}/_health`).then(
            (response) => response.ok,
            () => false,
          );
          if (ok) break;
          if (Date.now() > deadline)
            throw new Error(
              `Brick: remote service "${remote.name}" did not start`,
            );
          await new Promise((done) => setTimeout(done, 100));
        }
      }
    },
    async stop() {
      await Promise.all([...children.keys()].map(kill));
    },
  };
}
