import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from "bun:test";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { createHmac } from "node:crypto";
import {
  brick,
  defineService,
  defineStorage,
  hmacSignature,
  memory,
  resetGlobalRegistry,
  t,
  type BrickApp,
} from "../src";

const exporter = new InMemorySpanExporter();
beforeAll(() => {
  trace.setGlobalTracerProvider(
    new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    }),
  );
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});
afterAll(() => {
  trace.disable();
  context.disable();
  propagation.disable();
});

const SECRET = "very-secret-signing-key";
const MARKER = "SENSITIVE-PAYLOAD-MARKER";
const sign = (body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

let app: BrickApp;
const logged: unknown[][] = [];
const spies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  resetGlobalRegistry();
  exporter.reset();
  logged.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    spies.push(
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      }),
    );
});
afterEach(async () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  await app.stop(true);
});

function start() {
  const service = defineService("integrations", {
    deps: { cache: defineStorage({ driver: memory() }) },
  });
  service.webhook({
    name: "github",
    verify: hmacSignature({
      secret: SECRET,
      header: "x-hub-signature-256",
      prefix: "sha256=",
    }),
    eventId: ({ headers }) => headers.get("x-delivery") ?? undefined,
    input: t.Object({ action: t.String(), note: t.Optional(t.String()) }),
    execute: ({ input }) => {
      if (input.note === "explode") throw new Error("handler failed");
    },
  });
  app = brick({ services: [service], telemetry: true });
  app.listen(0);
  const base = `http://localhost:${app.server!.port}/api/integrations/github`;
  return (body: string, headers: Record<string, string>) =>
    fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
}

const action = () =>
  exporter
    .getFinishedSpans()
    .filter((span) => span.name === "action integrations.github");

describe("what a webhook delivery leaves in logs and spans", () => {
  it("records the webhook's name, the event id and the outcome on the span", async () => {
    const send = start();
    const body = JSON.stringify({ action: "opened" });
    const good = { "x-hub-signature-256": sign(body), "x-delivery": "evt-1" };
    await send(body, good);
    await send(body, good);
    await send(body, {
      "x-hub-signature-256": "sha256=00",
      "x-delivery": "evt-2",
    });
    const bad = JSON.stringify({ action: 1 });
    await send(bad, {
      "x-hub-signature-256": sign(bad),
      "x-delivery": "evt-3",
    });
    const outcomes = action().map((span) => [
      span.attributes["brick.webhook"],
      span.attributes["brick.webhook.event_id"],
      span.attributes["brick.webhook.outcome"],
    ]);
    expect(outcomes).toEqual([
      ["github", "evt-1", "processed"],
      ["github", "evt-1", "duplicate"],
      ["github", undefined, "refused"],
      ["github", undefined, "invalid"],
    ]);
  });

  it("never logs or records the body, the signature, the secret or what the verifier saw", async () => {
    const send = start();
    const body = JSON.stringify({ action: "opened", note: MARKER });
    const signature = sign(body);
    const exploding = JSON.stringify({ action: "a", note: "explode" });
    await send(body, { "x-hub-signature-256": signature, "x-delivery": "1" });
    await send(body, { "x-hub-signature-256": signature, "x-delivery": "1" });
    await send(body, {
      "x-hub-signature-256": "sha256=deadbeef",
      "x-delivery": "2",
    });
    await send(`${MARKER} {not json`, { "x-hub-signature-256": "sha256=00" });
    const invalid = JSON.stringify({ action: MARKER, note: 5 });
    await send(invalid, {
      "x-hub-signature-256": sign(invalid),
      "x-delivery": "3",
    });
    await send(exploding, {
      "x-hub-signature-256": sign(exploding),
      "x-delivery": "4",
    });
    const everything = JSON.stringify({
      logs: logged.map((args) => args.map(String)),
      spans: exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: span.attributes,
        events: span.events,
        status: span.status,
      })),
    });
    for (const secret of [MARKER, SECRET, signature, "deadbeef", sign(invalid)])
      expect(everything).not.toContain(secret);
    // The failures were logged and traced, just without the delivery's content.
    expect(everything).toContain("handler failed");
    expect(action()).toHaveLength(6);
  });
});
