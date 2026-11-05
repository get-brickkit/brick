import { afterEach } from "bun:test";
import type { BrickApp } from "../src";

/**
 * The URL of a service a suite needs, or undefined to skip it. A skip is
 * announced, and under CI (which provides the services) a missing one fails.
 */
export function requireService(
  env: "TEST_DATABASE_URL" | "REDIS_URL",
  suite: string,
): string | undefined {
  const url = process.env[env];
  if (url) return url;
  const reason = `${suite}: skipped, ${env} is not set`;
  if (process.env.CI) throw new Error(`${reason} (CI must provide it)`);
  console.warn(`[skip] ${reason}`);
  return undefined;
}

/** Whether a Redis server answers at `url` within half a second. */
export async function redisReachable(url: string): Promise<boolean> {
  const probe = new Bun.RedisClient(url, {
    autoReconnect: false,
    connectionTimeout: 500,
  });
  const ok = await probe.connect().then(
    () => true,
    () => false,
  );
  probe.close();
  return ok;
}

/** POST `body` as JSON to `path` on the app, without a port. */
export function postJson(
  app: { handle(request: Request): Promise<Response> | Response },
  path: string,
  body: unknown = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
    ),
  );
}

/** Polls `check` until it holds, and throws if it does not within `ms`. */
export async function waitFor(
  check: () => boolean | Promise<boolean>,
  ms = 2000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await Bun.sleep(5);
  }
}

/** Opens a WebSocket (Bun takes headers), closed after each test. */
export function openSocket(
  url: string,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  // Bun's WebSocket takes headers; the DOM type doesn't know them.
  const ws = new WebSocket(
    url.replace(/^http/, "ws"),
    (headers ? { headers } : undefined) as any,
  );
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
  });
}

const sockets: WebSocket[] = [];
const apps: BrickApp[] = [];

/** Shuts `app` down (server and events hub) after the current test. */
export function track<T extends BrickApp>(app: T): T {
  apps.push(app);
  return app;
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const app of apps.splice(0)) await app.shutdown(true);
});
