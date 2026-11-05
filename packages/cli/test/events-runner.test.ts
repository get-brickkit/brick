import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { resetGlobalRegistry } from "@brickkit/core";
import { startDevApplication } from "../src/dev-application";
import { startProdServer, startWorker } from "../src/runner";

const fixture = (name: string) =>
  new URL(`./fixtures/${name}.ts`, import.meta.url).pathname;

async function waitFor(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return check();
}

// A spawned dev server can take several seconds to start on a cold CI runner.
async function waitForOutput(read: () => string, text: string, ms = 8000) {
  if (!(await waitFor(() => read().includes(text), ms)))
    throw new Error(`No "${text}" after ${ms} ms. Output:\n${read()}`);
}

function createNote(port: number, service: string) {
  return fetch(`http://localhost:${port}/api/${service}/note`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "hello" }),
  });
}

// Fixed ports fall in Linux's ephemeral range, where CI sockets may hold them.
function freePort() {
  const listener = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = listener.port!;
  listener.stop(true);
  return port;
}

const handlers = (signal: "SIGINT" | "SIGTERM") => process.listeners(signal);
let servers: { stop(): unknown }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
});

describe("event delivery in the runner", () => {
  it("brick start delivers an event after an HTTP write, and exits after finishing deliveries", async () => {
    resetGlobalRegistry();
    const before = { int: handlers("SIGINT"), term: handlers("SIGTERM") };
    const port = freePort();
    const app: any = await startProdServer({
      entry: fixture("events-prod"),
      port,
    });
    servers.push({ stop: () => app.stop() }, { stop: () => app.events.stop() });
    const { received } = await import(fixture("events-prod"));

    try {
      const response = await createNote(port, "events_prod_service");
      expect(response.status).toBe(200);
      expect(
        await waitFor(() => received.some((payload: any) => payload.row)),
      ).toBe(true);
      expect(received.find((payload: any) => payload.row)).toMatchObject({
        id: 1,
        row: { id: 1, body: "hello" },
      });

      expect(handlers("SIGTERM")).toHaveLength(before.term.length + 1);
      expect(handlers("SIGINT")).toHaveLength(before.int.length + 1);
      // Not `once`: signal-exit, bundled with the workflow runtime, re-raises a
      // signal when it finds no listener left, and `once` removes ours first.
      const exit = spyOn(process, "exit").mockImplementation(
        (() => {}) as never,
      );
      try {
        process.emit("SIGTERM");
        expect(await waitFor(() => exit.mock.calls.length > 0)).toBe(true);
        expect(exit).toHaveBeenCalledWith(0);
        expect(handlers("SIGTERM")).toHaveLength(before.term.length + 1);
      } finally {
        exit.mockRestore();
      }
    } finally {
      for (const listener of handlers("SIGTERM"))
        if (!before.term.includes(listener)) process.off("SIGTERM", listener);
      for (const listener of handlers("SIGINT"))
        if (!before.int.includes(listener)) process.off("SIGINT", listener);
    }
  });

  it("brick start delivers events that were already pending when it booted", async () => {
    resetGlobalRegistry();
    const { seedPending, received } = await import(fixture("events-prod"));
    seedPending();
    const before = { int: handlers("SIGINT"), term: handlers("SIGTERM") };
    const port = freePort();
    const app: any = await startProdServer({
      entry: fixture("events-prod"),
      port,
    });
    servers.push({ stop: () => app.stop() }, { stop: () => app.events.stop() });
    try {
      expect(
        await waitFor(() => received.some((payload: any) => payload.seeded)),
      ).toBe(true);
    } finally {
      for (const listener of handlers("SIGTERM"))
        if (!before.term.includes(listener)) process.off("SIGTERM", listener);
      for (const listener of handlers("SIGINT"))
        if (!before.int.includes(listener)) process.off("SIGINT", listener);
    }
  });

  it("brick worker delivers pending events without listening on a port", async () => {
    resetGlobalRegistry();
    const { seedPending, received } = await import(fixture("events-worker"));
    seedPending();
    const before = { int: handlers("SIGINT"), term: handlers("SIGTERM") };
    const app: any = await startWorker({ entry: fixture("events-worker") });
    servers.push({ stop: () => app.events.stop() });
    try {
      expect(
        await waitFor(() => received.some((payload: any) => payload.seeded)),
      ).toBe(true);
      expect(app.server).toBeFalsy();
      expect(handlers("SIGTERM")).toHaveLength(before.term.length + 1);
    } finally {
      for (const listener of handlers("SIGTERM"))
        if (!before.term.includes(listener)) process.off("SIGTERM", listener);
      for (const listener of handlers("SIGINT"))
        if (!before.int.includes(listener)) process.off("SIGINT", listener);
    }
  });

  it("brick worker refuses an app that only records events, or has none", async () => {
    resetGlobalRegistry();
    await expect(
      startWorker({ entry: fixture("events-record-only") }),
    ).rejects.toThrow("only records events");
  });

  it("brick dev delivers events that were already pending when it booted", async () => {
    resetGlobalRegistry();
    const { seedPending, received } = await import(fixture("events-dev"));
    seedPending();
    const port = freePort();
    const app: any = await startDevApplication({
      entry: fixture("events-dev"),
      port,
    });
    servers.push({ stop: () => app.stop() }, { stop: () => app.events.stop() });
    expect(
      await waitFor(() => received.some((payload: any) => payload.seeded)),
    ).toBe(true);
  });

  it("brick dev delivers an event after an HTTP write", async () => {
    resetGlobalRegistry();
    const port = freePort();
    const app: any = await startDevApplication({
      entry: fixture("events-dev"),
      port,
    });
    servers.push({ stop: () => app.stop() }, { stop: () => app.events.stop() });
    const { received } = await import(fixture("events-dev"));

    const response = await createNote(port, "events_dev_service");
    expect(response.status).toBe(200);
    expect(
      await waitFor(() => received.some((payload: any) => payload.row)),
    ).toBe(true);
    expect(received.find((payload: any) => payload.row)).toMatchObject({
      row: { body: "hello" },
    });
  });
});

describe("signals", () => {
  for (const mode of ["drain", "timeout"] as const)
    it.skipIf(process.platform === "win32")(
      `brick dev exits after its supervisor is killed (${mode})`,
      async () => {
        const listener = Bun.serve({ port: 0, fetch: () => new Response() });
        const port = listener.port!;
        listener.stop(true);
        const child = Bun.spawn(
          [process.execPath, fixture("dev-signal"), String(port)],
          {
            detached: true,
            stdout: "pipe",
            stderr: "inherit",
            env: {
              ...process.env,
              BRICK_TEST_DELIVERY_MS: mode === "drain" ? "1000" : "never",
            },
          },
        );
        let output = "";
        const reading = (async () => {
          for await (const chunk of child.stdout)
            output += new TextDecoder().decode(chunk);
        })();
        const groupExited = () => {
          try {
            process.kill(-child.pid, 0);
            return false;
          } catch (error) {
            const code =
              error instanceof Error && "code" in error ? error.code : "";
            // macOS answers EPERM while the last member waits to be reaped.
            if (code === "EPERM") return false;
            if (code === "ESRCH") return true;
            throw error;
          }
        };
        try {
          await waitForOutput(() => output, "delivery started ");
          const sent = performance.now();
          child.kill("SIGKILL");
          await child.exited;
          expect(await waitFor(groupExited, 4500)).toBe(true);
          await reading;
          if (mode === "drain") expect(output).toContain("delivery finished");
          else {
            expect(output).not.toContain("delivery finished");
            expect(performance.now() - sent).toBeGreaterThan(2500);
          }
        } finally {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
          await child.exited;
          await reading;
        }
      },
      15000,
    );

  it.skipIf(process.platform === "win32")(
    "a dev worker without IPC drains on SIGINT",
    async () => {
      const listener = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = listener.port!;
      listener.stop(true);
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("../src/dev-worker.ts", import.meta.url).pathname,
          JSON.stringify({
            entry: fixture("events-dev-signal"),
            port,
            telemetry: false,
          }),
        ],
        {
          stdout: "pipe",
          stderr: "inherit",
          env: { ...process.env, BRICK_TEST_DELIVERY_MS: "1000" },
        },
      );
      let output = "";
      const reading = (async () => {
        for await (const chunk of child.stdout)
          output += new TextDecoder().decode(chunk);
      })();
      try {
        await waitForOutput(() => output, "delivery started ");
        child.kill("SIGINT");
        expect(await waitFor(() => child.exitCode !== null)).toBe(true);
        expect(await child.exited).toBe(0);
        await reading;
        expect(output).toContain("delivery finished");
      } finally {
        child.kill("SIGKILL");
        await child.exited;
        await reading;
      }
    },
    15000,
  );

  it.skipIf(process.platform === "win32")(
    "a dev worker drains a delivery that its entry started while loading",
    async () => {
      const listener = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = listener.port!;
      listener.stop(true);
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("../src/dev-worker.ts", import.meta.url).pathname,
          JSON.stringify({
            entry: fixture("events-dev-loading"),
            port,
            telemetry: false,
          }),
        ],
        { stdout: "pipe", stderr: "inherit" },
      );
      let output = "";
      const reading = (async () => {
        for await (const chunk of child.stdout)
          output += new TextDecoder().decode(chunk);
      })();
      try {
        await waitForOutput(() => output, "delivery started");
        const sent = performance.now();
        child.kill("SIGTERM");
        expect(await child.exited).toBe(0);
        expect(performance.now() - sent).toBeLessThan(3000);
        await reading;
        expect(output).toContain("delivery finished");
        expect(output).not.toContain("API Gateway");
      } finally {
        child.kill("SIGKILL");
        await child.exited;
        await reading;
      }
    },
    15000,
  );

  it.skipIf(process.platform === "win32")(
    "a dev worker exits and says so when its events fail to stop",
    async () => {
      const listener = Bun.serve({ port: 0, fetch: () => new Response() });
      const port = listener.port!;
      listener.stop(true);
      const child = Bun.spawn(
        [
          process.execPath,
          new URL("../src/dev-worker.ts", import.meta.url).pathname,
          JSON.stringify({
            entry: fixture("events-dev-failing-stop"),
            port,
            telemetry: false,
          }),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      let output = "";
      let errors = "";
      const reading = Promise.all([
        (async () => {
          for await (const chunk of child.stdout)
            output += new TextDecoder().decode(chunk);
        })(),
        (async () => {
          for await (const chunk of child.stderr)
            errors += new TextDecoder().decode(chunk);
        })(),
      ]);
      try {
        await waitForOutput(() => output, "entry loading");
        child.kill("SIGTERM");
        expect(await child.exited).toBe(0);
        await reading;
        expect(errors).toContain(
          "[Brick-TS] Could not stop the events: close failed",
        );
      } finally {
        child.kill("SIGKILL");
        await child.exited;
        await reading;
      }
    },
    15000,
  );

  for (const mode of ["drain", "force", "timeout"] as const)
    it.skipIf(process.platform === "win32")(
      `brick dev handles process-group signals (${mode})`,
      async () => {
        const listener = Bun.serve({ port: 0, fetch: () => new Response() });
        const port = listener.port!;
        listener.stop(true);
        const child = Bun.spawn(
          [process.execPath, fixture("dev-signal"), String(port)],
          {
            detached: true,
            stdout: "pipe",
            stderr: "inherit",
            env: {
              ...process.env,
              BRICK_TEST_DELIVERY_MS: mode === "drain" ? "1000" : "10000",
            },
          },
        );
        let output = "";
        const reader = child.stdout.getReader();
        const reading = (async () => {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            output += new TextDecoder().decode(value);
          }
        })();
        try {
          await waitForOutput(() => output, "delivery started ");
          const sent = performance.now();
          process.kill(-child.pid, "SIGINT");
          if (mode === "force") {
            await Bun.sleep(150);
            expect(child.exitCode).toBeNull();
            process.kill(-child.pid, "SIGINT");
          }
          expect(await child.exited).toBe(mode === "force" ? 130 : 0);
          await reading;
          if (mode === "drain") expect(output).toContain("delivery finished");
          else {
            expect(output).not.toContain("delivery finished");
            expect(performance.now() - sent).toBeLessThan(
              mode === "force" ? 1500 : 4500,
            );
            if (mode !== "force")
              expect(performance.now() - sent).toBeGreaterThan(2500);
          }
        } finally {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
          await child.exited;
          await reading;
          reader.releaseLock();
        }
      },
      15000,
    );

  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    it.skipIf(process.platform === "win32")(
      `exits with ${code} at a second ${signal}, without waiting for deliveries`,
      async () => {
        const child = Bun.spawn([process.execPath, fixture("signal-twice")], {
          stdout: "pipe",
        });
        const reader = child.stdout.getReader();
        let output = "";
        const until = async (text: string) => {
          while (!output.includes(text)) {
            const { value, done } = await reader.read();
            if (done) throw new Error(`exited before printing ${text}`);
            output += new TextDecoder().decode(value);
          }
        };
        try {
          await until("ready");
          child.kill(signal);
          // Two signals sent at once may arrive as one.
          await until("stopping");
          const sent = performance.now();
          child.kill(signal);
          expect(await child.exited).toBe(code);
          expect(performance.now() - sent).toBeLessThan(1000);
        } finally {
          child.kill("SIGKILL");
        }
      },
    );
});
