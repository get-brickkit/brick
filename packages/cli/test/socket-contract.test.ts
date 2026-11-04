import { expect, it } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  brick,
  defineService,
  getGlobalRegistry,
  resetGlobalRegistry,
  t,
} from "@brickkit/core";
import { createBrickClient } from "@brickkit/core/client";
import { generateClientContract } from "../src/client-contract";

it("generates and runs a typed, browser-safe socket contract alongside HTTP actions", async () => {
  resetGlobalRegistry();
  const service = defineService("chat");
  service.action({ name: "ping", output: t.String(), execute: () => "pong" });
  const output = t.Object({ text: t.String(), __brick_kind: t.String() });
  service.socket({
    name: "room.live",
    path: "/custom/live",
    description: "Live echo",
    input: { say: t.String() },
    output: { message: output },
    allowMissingOrigin: true,
    errors: { TOO_LONG: { message: "Too long", status: 422 } },
    handlers: {
      say: ({ input, socket, error }) => {
        if (input.length > 10) error.TOO_LONG();
        socket.send("message", { text: input, __brick_kind: "preserved" });
      },
    },
  });
  const app = brick({
    services: [service],
    prefix: "/v3",
    docs: false,
    requestLogging: false,
  }).listen(0);
  const root = resolve(import.meta.dir, "../../..");
  await mkdir(join(root, ".brick"), { recursive: true });
  const dir = await mkdtemp(join(root, ".brick/socket-contract-"));
  try {
    const source = generateClientContract(app);
    await Bun.write(join(dir, "contract.ts"), source);
    const { contract } = await import(join(dir, "contract.ts"));
    expect(contract.chat.room.live.config.path).toBe("/v3/chat/custom/live");
    expect(contract.chat.ping.kind).toBe("action");
    const api = createBrickClient({
      baseUrl: `http://localhost:${app.server!.port}`,
      contract,
    });
    expect(await api.chat.ping()).toBe("pong");
    const live = api.chat.room.live.connect();
    const received = new Promise((resolve) => live.on("message", resolve));
    await live.ready;
    live.send("say", "hello");
    expect(await received).toEqual({
      text: "hello",
      __brick_kind: "preserved",
    });
    const failed = new Promise((resolve) => live.onHandlerError(resolve));
    live.send("say", "far too long");
    expect(await failed).toMatchObject({ event: "say", code: "TOO_LONG" });
    live.close();
    expect(
      getGlobalRegistry().exportArchitecture(app.definition).services[0]!
        .sockets,
    ).toEqual([
      {
        name: "room.live",
        service: "chat",
        path: "/v3/chat/custom/live",
        description: "Live echo",
        input: ["say"],
        output: ["message"],
        hasAuthorize: false,
      },
    ]);
    await Bun.write(
      join(dir, "browser.ts"),
      `import { createBrickClient } from '@brickkit/core/client'; import {contract} from './contract'; export const api = createBrickClient({baseUrl:'https://example.test',contract});`,
    );
    const bundle = await Bun.build({
      entrypoints: [join(dir, "browser.ts")],
      target: "browser",
      tsconfig: join(root, "tsconfig.json"),
    });
    expect(bundle.success).toBe(true);
    const js = await bundle.outputs[0]!.text();
    for (const backend of [
      "bun:sqlite",
      "defineService",
      "postgres",
      'from "elysia"',
    ])
      expect(js).not.toContain(backend);
    await Bun.write(
      join(dir, "types.ts"),
      `
import {api} from './browser';
const live=api.chat.room.live.connect();
live.send('say','hello');
live.on('message', p=>{const text:string=p.text;void text;});
// @ts-expect-error Wrong payload
live.send('say',42);
// @ts-expect-error Wrong direction
live.send('message',{text:'x'});
// @ts-expect-error Unknown output
live.on('say',()=>{});
live.onHandlerError(e=>{const code:'TOO_LONG'|'FORBIDDEN'|'BAD_REQUEST'|'UNAUTHORIZED'|'NOT_FOUND'|'CONFLICT'|'INTERNAL_SERVER_ERROR'=e.code;const event:'say'=e.event;void [code,event];});
`,
    );
    await Bun.write(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: join(root, "tsconfig.json"),
        compilerOptions: { noEmit: true },
        include: ["*.ts"],
      }),
    );
    const check = Bun.spawn(
      [
        process.execPath,
        "x",
        "--no-install",
        "tsc",
        "-p",
        join(dir, "tsconfig.json"),
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout, stderr] = await Promise.all([
      check.exited,
      new Response(check.stdout).text(),
      new Response(check.stderr).text(),
    ]);
    expect(stdout + stderr).toBe("");
    expect(code).toBe(0);
  } finally {
    await app.stop(true);
    await rm(dir, { recursive: true, force: true });
    resetGlobalRegistry();
  }
}, 20000);

it("refuses socket/action client namespace collisions", () => {
  resetGlobalRegistry();
  const service = defineService("collision");
  service.socket({ name: "live", input: {}, output: {}, handlers: {} });
  service.action({ name: "live", execute() {} });
  // The default routes share a URL segment, which fails first.
  expect(() => brick({ services: [service], docs: false })).toThrow(
    'duplicate name "live"',
  );
  // Distinct routes still collide in the client namespace.
  service.action({ name: "live", path: "/other", execute() {} });
  expect(() =>
    generateClientContract(brick({ services: [service], docs: false })),
  ).toThrow("namespace collision");
  resetGlobalRegistry();
});
