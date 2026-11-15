import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
  spyOn,
} from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  brick,
  compileBrickApplication,
  createMcpRegistry,
  defineSecret,
  defineService,
  defineStorage,
  hmacSignature,
  memory,
  overrideSecret,
  redis,
  resetGlobalRegistry,
  resetSecrets,
  standardWebhooks,
  StorageUnavailableError,
  t,
  twilioSignature,
  type BrickApp,
  type KeyValueDriver,
  type StorageDriver,
  type WebhookVerifier,
} from "../src";
import { generateOpenApiSpec } from "../src/openapi";
import { redisReachable, requireService } from "./helpers";

const redisUrl = requireService("REDIS_URL", "redis webhooks");
if (redisUrl && !(await redisReachable(redisUrl)))
  throw new Error(`REDIS_URL is set, but no Redis answers at ${redisUrl}`);

beforeEach(resetGlobalRegistry);

const TEST_ONLY_SECRET = "whsec-test-secret";
const TWILIO_DOCS_EXAMPLE_TOKEN = "12345";
const sign = (body: string, secret = TEST_ONLY_SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const github = hmacSignature({
  secret: TEST_ONLY_SECRET,
  header: "x-hub-signature-256",
  prefix: "sha256=",
});
const delivery = ({ headers }: { headers: Headers }) =>
  headers.get("x-delivery") ?? undefined;

const running: BrickApp[] = [];
afterEach(async () => {
  setSystemTime();
  resetSecrets();
  for (const app of running.splice(0)) await app.stop(true);
});

function serve(
  ...services: Parameters<typeof brick>[0] extends infer O
    ? O extends { services?: infer S }
      ? NonNullable<S>
      : never
    : never
) {
  const app = brick({
    services,
    requestLogging: false,
    secrets: { validate: false },
  });
  app.listen(0);
  running.push(app);
  return `http://localhost:${app.server!.port}`;
}

function post(
  base: string,
  body: string,
  headers: Record<string, string> = {},
  path = "/api/integrations/github",
) {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}
const signed =
  (id: string, extra: Record<string, string> = {}) =>
  (body: string) => ({
    "x-hub-signature-256": sign(body),
    "x-delivery": id,
    ...extra,
  });

function integrations(
  options: {
    storage?: ReturnType<typeof defineStorage>;
    config?: Record<string, unknown>;
    service?: Record<string, unknown>;
  } = {},
) {
  const calls: { input: unknown; eventId: string | undefined }[] = [];
  const service = defineService("integrations", {
    deps: { cache: options.storage ?? defineStorage({ driver: memory() }) },
    ...options.service,
  });
  const webhook = service.webhook({
    name: "github",
    verify: github,
    eventId: delivery,
    input: t.Object({ action: t.String() }),
    execute: ({ input, eventId }: any) => {
      calls.push({ input, eventId });
    },
    ...options.config,
  } as never);
  return { service, webhook, calls };
}

describe("sensitive fields", () => {
  it("redacts a t.Sensitive field of a webhook's input in its logs and its error response", async () => {
    const TOKEN = "sk_live_webhook_token_9f3a";
    const logged: string[] = [];
    const error = spyOn(console, "error").mockImplementation((...args) => {
      logged.push(Bun.inspect(args));
    });
    try {
      const { service } = integrations({
        config: {
          input: t.Object({
            action: t.String(),
            token: t.Sensitive(t.String()),
          }),
          execute: ({ input }: any) => {
            throw new Error(`could not use ${input.token}`);
          },
        },
      });
      const base = serve(service);
      const body = JSON.stringify({ action: "opened", token: TOKEN });
      const response = await post(base, body, signed("s1")(body));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain(TOKEN);
      expect(logged.join("\n")).toContain("could not use");
      expect(logged.join("\n")).not.toContain(TOKEN);
    } finally {
      error.mockRestore();
    }
  });
});

describe("hmacSignature", () => {
  it("refuses an unsigned and a wrongly signed delivery, and accepts a signed one", async () => {
    const { service, calls } = integrations();
    const base = serve(service);
    const body = JSON.stringify({ action: "opened" });
    const unsigned = await post(base, body, { "x-delivery": "1" });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({
      code: "UNAUTHORIZED",
      message: "Webhook verification failed",
    });
    for (const header of [
      sign(body, "another secret"),
      sign(body).replace("sha256=", ""),
      sign(body).toUpperCase(),
      sign(`${body} `),
    ])
      expect(
        (
          await post(base, body, {
            "x-hub-signature-256": header,
            "x-delivery": "1",
          })
        ).status,
      ).toBe(401);
    expect(calls).toHaveLength(0);
    const ok = await post(base, body, signed("1")(body));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(calls).toEqual([{ input: { action: "opened" }, eventId: "1" }]);
  });

  it("takes a base64 signature, another algorithm and an unprefixed header", async () => {
    const { service, calls } = integrations({
      config: {
        verify: hmacSignature({
          secret: TEST_ONLY_SECRET,
          header: "x-signature",
          algorithm: "sha1",
          encoding: "base64",
        }),
      },
    });
    const base = serve(service);
    const body = JSON.stringify({ action: "a" });
    const signature = createHmac("sha1", TEST_ONLY_SECRET)
      .update(body)
      .digest("base64");
    expect(
      (await post(base, body, { "x-signature": signature, "x-delivery": "1" }))
        .status,
    ).toBe(200);
    expect(
      (await post(base, body, { "x-signature": "AAAA", "x-delivery": "2" }))
        .status,
    ).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("accepts a rotated secret: any secret of the list, from strings or refs", async () => {
    const current = defineSecret("WEBHOOK_CURRENT");
    const previous = defineSecret("WEBHOOK_PREVIOUS");
    overrideSecret("WEBHOOK_CURRENT", "new-secret");
    overrideSecret("WEBHOOK_PREVIOUS", "old-secret");
    try {
      const { service, calls } = integrations({
        config: {
          verify: hmacSignature({
            secret: [current, previous, "literal-secret"],
            header: "x-hub-signature-256",
            prefix: "sha256=",
          }),
        },
      });
      const base = serve(service);
      const body = JSON.stringify({ action: "a" });
      for (const [index, secret] of [
        "new-secret",
        "old-secret",
        "literal-secret",
      ].entries())
        expect(
          (
            await post(base, body, {
              "x-hub-signature-256": sign(body, secret),
              "x-delivery": String(index),
            })
          ).status,
        ).toBe(200);
      expect(
        (
          await post(base, body, {
            "x-hub-signature-256": sign(body, "retired-secret"),
            "x-delivery": "x",
          })
        ).status,
      ).toBe(401);
      overrideSecret("WEBHOOK_PREVIOUS", "newer-secret");
      expect(
        (
          await post(base, body, {
            "x-hub-signature-256": sign(body, "old-secret"),
            "x-delivery": "y",
          })
        ).status,
      ).toBe(401);
      expect(calls).toHaveLength(3);
    } finally {
      resetSecrets();
    }
  });

  it("refuses everything when the secret is missing or empty, never accepting an empty key", async () => {
    const missing = defineSecret("WEBHOOK_NOT_SET");
    const { service, calls } = integrations({
      config: {
        verify: hmacSignature({
          secret: missing,
          header: "x-hub-signature-256",
          prefix: "sha256=",
        }),
      },
    });
    const base = serve(service);
    const body = JSON.stringify({ action: "a" });
    expect((await post(base, body, signed("1")(body))).status).toBe(401);
    overrideSecret("WEBHOOK_NOT_SET", "");
    try {
      expect(
        (
          await post(base, body, {
            "x-hub-signature-256": sign(body, ""),
            "x-delivery": "2",
          })
        ).status,
      ).toBe(401);
    } finally {
      resetSecrets();
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts a hex signature written in upper case", async () => {
    const { service, calls } = integrations();
    const base = serve(service);
    const body = JSON.stringify({ action: "a" });
    const upper = `sha256=${sign(body).slice("sha256=".length).toUpperCase()}`;
    const response = await post(base, body, {
      "x-hub-signature-256": upper,
      "x-delivery": "1",
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("refuses a request that is not a POST, which has no body to sign", async () => {
    const request = (method: string) => ({
      rawBody: new Uint8Array(),
      headers: new Headers({ "x-hub-signature-256": sign("") }),
      url: "http://localhost/hook?a=1",
      method,
    });
    expect(await github(request("POST"))).toBe(true);
    expect(await github(request("GET"))).toBe(false);
  });
});

it("refuses an hmacSignature secret that is only whitespace", async () => {
  const verify = hmacSignature({ secret: " \n", header: "x-sig" });
  const rawBody = new TextEncoder().encode("{}");
  const signature = createHmac("sha256", " \n").update(rawBody).digest("hex");
  const request = {
    rawBody,
    headers: new Headers({ "x-sig": signature }),
    url: "http://localhost/",
    method: "POST",
  };
  expect(() => verify(request)).toThrow("secret is empty");
});

describe("standardWebhooks", () => {
  const STANDARD_WEBHOOKS_DOCS_EXAMPLE_SECRET =
    "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
  const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
  const TIMESTAMP = "1614265330";
  const BODY = '{"test": 2432232314}';
  const SIGNATURE = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
  const headers = (extra: Record<string, string> = {}) => ({
    "webhook-id": ID,
    "webhook-timestamp": TIMESTAMP,
    "webhook-signature": SIGNATURE,
    ...extra,
  });
  function payments(options: { toleranceMs?: number } = {}) {
    const calls: unknown[] = [];
    const service = defineService("billing", {
      deps: { cache: defineStorage({ driver: memory() }) },
    });
    service.webhook({
      name: "payments",
      verify: standardWebhooks({
        secret: STANDARD_WEBHOOKS_DOCS_EXAMPLE_SECRET,
        ...options,
      }),
      input: t.Object({ test: t.Number() }),
      execute: ({ input, eventId }) => {
        calls.push({ input, eventId });
      },
    });
    return { base: serve(service), calls };
  }
  const send = (
    base: string,
    extra: Record<string, string> = {},
    body = BODY,
  ) => post(base, body, headers(extra), "/api/billing/payments");

  it("accepts the published example and uses the webhook-id as the event id", async () => {
    setSystemTime(new Date(Number(TIMESTAMP) * 1000));
    const { base, calls } = payments();
    expect((await send(base)).status).toBe(200);
    expect(calls).toEqual([{ input: { test: 2432232314 }, eventId: ID }]);
    expect(await (await send(base)).json()).toEqual({ duplicate: true });
    expect(calls).toHaveLength(1);
  });

  it("reads Svix's svix-* headers the same way, and a secret that ends in a newline", async () => {
    setSystemTime(new Date(Number(TIMESTAMP) * 1000));
    const calls: unknown[] = [];
    const service = defineService("billing", {
      deps: { cache: defineStorage({ driver: memory() }) },
    });
    service.webhook({
      name: "payments",
      verify: standardWebhooks({
        secret: ` ${STANDARD_WEBHOOKS_DOCS_EXAMPLE_SECRET}\r\n`,
      }),
      input: t.Object({ test: t.Number() }),
      execute: ({ eventId }) => {
        calls.push(eventId);
      },
    });
    const response = await post(
      serve(service),
      BODY,
      {
        "svix-id": ID,
        "svix-timestamp": TIMESTAMP,
        "svix-signature": SIGNATURE,
      },
      "/api/billing/payments",
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([ID]);
  });

  it("refuses a missing, wrong, altered and unsupported signature", async () => {
    setSystemTime(new Date(Number(TIMESTAMP) * 1000));
    const { base, calls } = payments();
    for (const extra of [
      { "webhook-signature": "" },
      { "webhook-signature": "v1,AAAA" },
      { "webhook-signature": SIGNATURE.replace("v1,", "v2,") },
      { "webhook-signature": SIGNATURE.replace("v1,", "v1a,") },
      { "webhook-id": "msg_other" },
      { "webhook-timestamp": "1614265331" },
      { "webhook-timestamp": "not a number" },
    ] as Record<string, string>[])
      expect((await send(base, extra)).status).toBe(401);
    expect((await send(base, {}, `${BODY} `)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("takes any one of several signatures, as in a secret rotation", async () => {
    setSystemTime(new Date(Number(TIMESTAMP) * 1000));
    const { base, calls } = payments();
    const response = await send(base, {
      "webhook-signature": `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${SIGNATURE}`,
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("refuses a timestamp outside the tolerance, either way", async () => {
    const { base, calls } = payments();
    const at = (seconds: number) => setSystemTime(new Date(seconds * 1000));
    at(Number(TIMESTAMP) + 301);
    expect((await send(base)).status).toBe(401);
    at(Number(TIMESTAMP) - 301);
    expect((await send(base)).status).toBe(401);
    at(Number(TIMESTAMP) + 299);
    expect((await send(base)).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("refuses a secret that is no key, and a delivery signed with an empty one", async () => {
    setSystemTime(new Date(Number(TIMESTAMP) * 1000));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const [secret, key] of [
        ["whsec_", Buffer.alloc(0)],
        ["whsec_!!!", Buffer.alloc(0)],
        ["whsec_A", Buffer.alloc(0)],
        ["my-plain-secret", Buffer.from("my-plain-secret", "base64")],
      ] as const) {
        resetGlobalRegistry();
        const signature = createHmac("sha256", key)
          .update(`${ID}.${TIMESTAMP}.${BODY}`)
          .digest("base64");
        const service = defineService("billing", {
          deps: { cache: defineStorage({ driver: memory() }) },
        });
        const calls: unknown[] = [];
        service.webhook({
          name: "payments",
          verify: standardWebhooks({ secret }),
          input: t.Object({ test: t.Number() }),
          execute: ({ input }) => {
            calls.push(input);
          },
        });
        const response = await send(
          serve(service),
          { "webhook-signature": `v1,${signature}` },
          BODY,
        );
        expect([secret, response.status]).toEqual([secret, 401]);
        expect(calls).toHaveLength(0);
      }
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a request that is not a POST, which has no body to sign", async () => {
    setSystemTime(new Date(Number(TIMESTAMP) * 1000));
    const verify = standardWebhooks({
      secret: STANDARD_WEBHOOKS_DOCS_EXAMPLE_SECRET,
    });
    const request = (method: string) => ({
      rawBody: new TextEncoder().encode(BODY),
      headers: new Headers(headers()),
      url: "http://localhost/hook",
      method,
    });
    expect(await verify(request("POST"))).toEqual({ eventId: ID });
    expect(await verify(request("GET"))).toBe(false);
  });

  it("takes the tolerance from toleranceMs", async () => {
    const { base } = payments({ toleranceMs: 1000 });
    setSystemTime(new Date((Number(TIMESTAMP) + 2) * 1000));
    expect((await send(base)).status).toBe(401);
    setSystemTime(new Date((Number(TIMESTAMP) + 1) * 1000));
    expect((await send(base)).status).toBe(200);
  });
});

describe("twilioSignature", () => {
  const URL_SIGNED = "https://example.com/myapp.php?foo=1&bar=2";
  const FORM =
    "CallSid=CA1234567890ABCDE&Caller=%2B14158675310&Digits=1234&From=%2B14158675310&To=%2B18005551212";
  const SIGNATURE = "L/OH5YylLD5NRKLltdqwSvS0BnU=";
  function telephony(
    url: string | ((request: { url: string }) => string) = URL_SIGNED,
  ) {
    const calls: unknown[] = [];
    const service = defineService("telephony", {
      deps: { cache: defineStorage({ driver: memory() }) },
    });
    service.webhook({
      name: "voiceStatus",
      verify: twilioSignature({
        authToken: TWILIO_DOCS_EXAMPLE_TOKEN,
        url: url as never,
      }),
      eventId: ({ input }) => `${input.CallSid}:${input.Digits}`,
      input: t.Object({
        CallSid: t.String(),
        Digits: t.Number(),
        Ignored: t.Optional(t.String()),
      }),
      execute: ({ input }) => {
        calls.push(input);
        return new Response("<Response/>", {
          headers: { "content-type": "text/xml" },
        });
      },
    });
    return { base: serve(service), calls };
  }
  const send = (
    base: string,
    signature: string | undefined,
    body = FORM,
    type = "application/x-www-form-urlencoded",
  ) =>
    fetch(`${base}/api/telephony/voice-status`, {
      method: "POST",
      headers: {
        "content-type": type,
        ...(signature ? { "x-twilio-signature": signature } : {}),
      },
      body,
    });

  it("accepts the documented example, parses the form, and answers with the handler's Response", async () => {
    const { base, calls } = telephony();
    const response = await send(base, SIGNATURE);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/xml");
    expect(await response.text()).toBe("<Response/>");
    expect(calls).toEqual([{ CallSid: "CA1234567890ABCDE", Digits: 1234 }]);
  });

  it("refuses an unsigned, wrongly signed, tampered or re-addressed delivery", async () => {
    const { base, calls } = telephony();
    expect((await send(base, undefined)).status).toBe(401);
    expect((await send(base, "AAAA/OH5YylLD5NRKLltdqwSvS0BnU=")).status).toBe(
      401,
    );
    expect(
      (await send(base, SIGNATURE, FORM.replace("1234", "1235"))).status,
    ).toBe(401);
    expect((await send(base, SIGNATURE, `${FORM}&Extra=1`)).status).toBe(401);
    expect(
      (
        await send(
          telephony("https://other.example/myapp.php?foo=1&bar=2").base,
          SIGNATURE,
        )
      ).status,
    ).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("takes the public URL from the app, per request", async () => {
    const seen: string[] = [];
    const { base } = telephony((request) => {
      seen.push(request.url);
      return URL_SIGNED;
    });
    expect((await send(base, SIGNATURE)).status).toBe(200);
    expect(seen[0]).toContain("/api/telephony/voice-status");
  });

  it("signs a JSON body through its bodySHA256 query parameter", async () => {
    const body = JSON.stringify({ CallSid: "CA1", Digits: 7 });
    const hash = createHash("sha256").update(body).digest("hex");
    const url = `https://example.com/hook?bodySHA256=${hash}`;
    const signature = createHmac("sha1", TWILIO_DOCS_EXAMPLE_TOKEN)
      .update(url)
      .digest("base64");
    const { base, calls } = telephony(url);
    expect((await send(base, signature, body, "application/json")).status).toBe(
      200,
    );
    expect(calls).toEqual([{ CallSid: "CA1", Digits: 7 }]);
    const other = JSON.stringify({ CallSid: "CA1", Digits: 8 });
    expect(
      (await send(base, signature, other, "application/json")).status,
    ).toBe(401);
    const bare = "https://example.com/hook";
    const bareSignature = createHmac("sha1", TWILIO_DOCS_EXAMPLE_TOKEN)
      .update(bare)
      .digest("base64");
    expect(
      (
        await send(
          telephony(bare).base,
          bareSignature,
          body,
          "application/json",
        )
      ).status,
    ).toBe(401);
  });

  it("signs names in order and repeated values as Twilio does: each distinct value, sorted", async () => {
    const service = defineService("tel2", {});
    service.webhook({
      name: "multi",
      replay: false,
      verify: twilioSignature({
        authToken: TWILIO_DOCS_EXAMPLE_TOKEN,
        url: "https://e.example/x",
      }),
      input: t.Object({ A: t.Array(t.String()), B: t.String() }),
      execute: ({ input }) => input,
    });
    const base = serve(service);
    const signed = "https://e.example/x" + "A1A2" + "Bx";
    const signature = createHmac("sha1", TWILIO_DOCS_EXAMPLE_TOKEN)
      .update(signed)
      .digest("base64");
    const response = await fetch(`${base}/api/tel2/multi`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body: "B=x&A=2&A=1&A=2",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ A: ["2", "1", "2"], B: "x" });
  });
});

describe("a GET webhook", () => {
  const get = {
    name: "hook",
    method: "GET",
    replay: false,
    input: t.Object({ CallSid: t.String() }),
    execute: () => {},
  };

  it("cannot take a verifier that signs the body, and says why", () => {
    const service = defineService("billing", {});
    for (const verify of [github, standardWebhooks({ secret: "whsec_AAAA" })])
      expect(() => service.webhook({ ...get, verify } as never)).toThrow(
        /Service "billing": webhook 'hook': method "GET" has no body, and this verifier signs the body/,
      );
    const twilio = twilioSignature({ authToken: "t", url: "https://x.test" });
    expect(() =>
      service.webhook({ ...get, verify: twilio } as never),
    ).not.toThrow();
  });

  it("is not authenticated by a wrapper that signs the body either: one signature for every query is refused", async () => {
    const calls: unknown[] = [];
    const service = defineService("billing", {});
    service.webhook({
      ...get,
      input: t.Object({ a: t.String() }),
      verify: (request: Parameters<WebhookVerifier>[0]) => github(request),
      execute: ({ input }: any) => {
        calls.push(input);
      },
    } as never);
    const base = serve(service);
    for (const a of ["1", "999", "31337"]) {
      const response = await fetch(`${base}/api/billing/hook?a=${a}`, {
        headers: { "x-hub-signature-256": sign("") },
      });
      expect(response.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  it("is signed by Twilio over its URL, query included, and the body is not part of it", async () => {
    const token = TWILIO_DOCS_EXAMPLE_TOKEN;
    const url = "https://example.com/hook?CallSid=CA1";
    const urlSignature = createHmac("sha1", token).update(url).digest("base64");
    const calls: unknown[] = [];
    const service = defineService("telephony", {});
    service.webhook({
      ...get,
      name: "status",
      verify: twilioSignature({ authToken: token, url }),
      execute: ({ input }: any) => {
        calls.push(input);
      },
    } as never);
    const base = serve(service);
    const call = (signature: string) =>
      fetch(`${base}/api/telephony/status?CallSid=CA1`, {
        headers: { "x-twilio-signature": signature },
      });
    expect((await call(urlSignature)).status).toBe(200);
    expect(calls).toEqual([{ CallSid: "CA1" }]);
    const forged = await fetch(
      `${base}/api/telephony/status?CallSid=CA999&Amount=1000000`,
      { headers: { "x-twilio-signature": urlSignature } },
    );
    expect(forged.status).toBe(401);
    expect(calls).toHaveLength(1);
    expect((await call("AAAA/OH5YylLD5NRKLltdqwSvS0BnU=")).status).toBe(401);
    const verify = twilioSignature({ authToken: token, url });
    const request = (method: string) => ({
      rawBody: new TextEncoder().encode("a=1"),
      headers: new Headers({
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": urlSignature,
      }),
      url,
      method,
    });
    expect(await verify(request("GET"))).toBe(true);
    expect(await verify(request("POST"))).toBe(false);
  });
});

describe("a webhook's route", () => {
  const webhook = {
    name: "stripe",
    path: "/hooks/stripe",
    verify: () => false,
    replay: false,
    input: t.Object({}),
    execute: () => "unverified",
  };
  const action = {
    name: "legacyStripe",
    path: "/hooks/stripe",
    method: "POST",
    execute: () => "unverified",
  };

  it("is not taken by an action, or taken from one, whichever is defined first", () => {
    for (const webhookFirst of [true, false]) {
      resetGlobalRegistry();
      const service = defineService("billing", {});
      const addWebhook = () => service.webhook(webhook as never);
      const addAction = () => service.action(action as never);
      for (const add of webhookFirst
        ? [addWebhook, addAction]
        : [addAction, addWebhook])
        add();
      const start = () => brick({ services: [service] });
      expect(start).toThrow(/'billing\.stripe'/);
      expect(start).toThrow(/'billing\.legacyStripe'/);
      expect(start).toThrow(/a webhook cannot share its route/);
    }
  });

  it("is not taken by an endpoint, defined before or after", () => {
    const service = defineService("billing", {});
    service.webhook(webhook as never);
    const endpoint = {
      method: "POST" as const,
      path: "/api/billing/hooks/stripe",
      handler: () => "unverified",
    };
    expect(() => brick({ services: [service], endpoints: [endpoint] })).toThrow(
      /webhook 'billing\.stripe'.*cannot share/,
    );
    const app = brick({ services: [service] });
    expect(() => app.endpoint(endpoint)).toThrow(/webhook 'billing\.stripe'/);
  });

  it("is not replaced by an action of the same name, nor replaces one", () => {
    for (const webhookFirst of [true, false]) {
      resetGlobalRegistry();
      const service = defineService("billing", {});
      const adds = [
        () => service.webhook(webhook as never),
        () => service.action({ name: "stripe", execute: () => "unverified" }),
      ];
      if (!webhookFirst) adds.reverse();
      adds[0]!();
      expect(adds[1]!).toThrow(/both as a webhook and as an action/);
    }
  });

  it("leaves two plain actions on one route as they were: the later is shadowed", () => {
    const service = defineService("billing", {});
    service.action({ ...action, name: "a" } as never);
    service.action({ ...action, name: "b" } as never);
    expect(() => brick({ services: [service] })).not.toThrow();
  });
});

describe("a custom verifier", () => {
  const verifier = (verify: WebhookVerifier) => {
    const calls: unknown[] = [];
    const service = defineService("custom", {});
    service.webhook({
      name: "events",
      replay: false,
      verify,
      input: t.Object({ n: t.Number() }),
      execute: ({ input, eventId }) => {
        calls.push({ input, eventId });
      },
    });
    return { base: serve(service), calls };
  };
  const send = (base: string, body = '{"n":1}') =>
    post(base, body, {}, "/api/custom/events");

  it("is given the raw body, the headers, the URL and the method", async () => {
    let seen: any;
    const { base } = verifier(({ rawBody, headers, url, method }) => {
      seen = {
        body: new TextDecoder().decode(rawBody),
        type: headers.get("content-type"),
        url,
        method,
      };
      return true;
    });
    expect((await send(base, '{ "n" :  1 }')).status).toBe(200);
    expect(seen).toEqual({
      body: '{ "n" :  1 }',
      type: "application/json",
      url: `${base}/api/custom/events`,
      method: "POST",
    });
  });

  it("accepts on true, and names the event with { eventId }", async () => {
    const accepted = verifier(() => true);
    expect((await send(accepted.base)).status).toBe(200);
    expect(accepted.calls).toEqual([{ input: { n: 1 }, eventId: undefined }]);
    const named = verifier(() => ({ eventId: "evt_9" }));
    expect((await send(named.base)).status).toBe(200);
    expect(named.calls).toEqual([{ input: { n: 1 }, eventId: "evt_9" }]);
    const numbered = verifier(() => ({ eventId: 7 }));
    expect((await send(numbered.base)).status).toBe(200);
    expect(numbered.calls).toEqual([{ input: { n: 1 }, eventId: "7" }]);
  });

  it("refuses on false, on a throw, on a rejection and on anything else", async () => {
    for (const verify of [
      () => false,
      () => {
        throw new Error("signature mismatch: secret-looking-detail");
      },
      async () => {
        throw new Error("rejected");
      },
      () => undefined as never,
      () => null as never,
      () => "true" as never,
      () => ({ eventId: "" }),
      () => ({ eventId: 1.5 }),
      () => ({ eventId: {} }) as never,
    ]) {
      const { base, calls } = verifier(verify);
      const response = await send(base);
      expect(response.status).toBe(401);
      const envelope = await response.json();
      expect(envelope.message).toBe("Webhook verification failed");
      expect(JSON.stringify(envelope)).not.toContain("secret-looking-detail");
      expect(calls).toHaveLength(0);
      resetGlobalRegistry();
    }
  });

  it("warns, once, of a verifier that throws: the webhook and the error's class, never its message", async () => {
    class VaultError extends Error {}
    const spies = (["warn", "error", "log", "info", "debug"] as const).map(
      (level) => spyOn(console, level).mockImplementation(() => {}),
    );
    try {
      const { base } = verifier(() => {
        throw new VaultError("bad signature body-and-secret-detail");
      });
      expect((await send(base)).status).toBe(401);
      const [warn] = spies;
      expect(warn!).toHaveBeenCalledTimes(1);
      // Bun.inspect, not JSON: JSON.stringify of an Error is "{}", which would hide a logged message.
      const logged = Bun.inspect(spies.flatMap((spy) => spy.mock.calls));
      expect(logged).toContain("custom");
      expect(logged).toContain("events");
      expect(logged).toContain("VaultError");
      expect(logged).not.toContain("body-and-secret-detail");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("does not log a delivery whose signature is merely wrong: anyone can send those", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { base } = verifier(() => false);
      expect((await send(base)).status).toBe(401);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("nothing runs before the verifier accepts", () => {
  it("runs no app code and parses nothing for an unverified delivery", async () => {
    const ran: string[] = [];
    const parse = spyOn(JSON, "parse");
    const { service, calls } = integrations({
      service: {
        context: () => {
          ran.push("context");
          return {};
        },
        identity: () => {
          ran.push("identity");
          return null;
        },
      },
      config: {
        eventId: () => {
          ran.push("eventId");
          return "1";
        },
        rateLimit: {
          per: () => {
            ran.push("rateLimit");
            return "k";
          },
          max: 5,
          windowMs: 1000,
        },
        input: t.Object({ action: t.String() }),
      },
    });
    const base = serve(service);
    const before = parse.mock.calls.length;
    const poison = '{"action": <<not json>>';
    expect(
      (await post(base, poison, { "x-hub-signature-256": "sha256=00" })).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${base}/api/integrations/github`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-hub-signature-256": "sha256=00",
          },
          body: "%E0%A4%A&&&=%",
        })
      ).status,
    ).toBe(401);
    expect(ran).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(parse.mock.calls.length).toBe(before);
    parse.mockRestore();
    const signedPoison = await post(base, poison, signed("1")(poison));
    expect(signedPoison.status).toBe(400);
    expect(ran).toEqual([]);
  });

  it("runs in order: verify, parse, event id, context, rate limit, execute", async () => {
    const order: string[] = [];
    const { service } = integrations({
      service: {
        context: () => {
          order.push("context");
          return { marker: true };
        },
      },
      config: {
        verify: () => {
          order.push("verify");
          return true;
        },
        eventId: () => {
          order.push("eventId");
          return "1";
        },
        rateLimit: {
          per: () => {
            order.push("rateLimit");
            return "k";
          },
          max: 5,
          windowMs: 1000,
        },
        execute: ({ ctx }: any) => {
          order.push(`execute:${ctx.marker}`);
        },
      },
    });
    const base = serve(service);
    expect((await post(base, '{"action":"a"}')).status).toBe(200);
    expect(order).toEqual([
      "verify",
      "eventId",
      "context",
      "rateLimit",
      "execute:true",
    ]);
  });
});

describe("the body", () => {
  const big = (bytes: number) => JSON.stringify({ action: "x".repeat(bytes) });

  it("answers 413 over maxBodyBytes by Content-Length, before verifying", async () => {
    const { service, calls } = integrations({ config: { maxBodyBytes: 1000 } });
    const base = serve(service);
    const body = big(2000);
    const unsigned = await post(base, body);
    expect(unsigned.status).toBe(413);
    expect((await unsigned.json()).code).toBe("PAYLOAD_TOO_LARGE");
    expect((await post(base, body, signed("1")(body))).status).toBe(413);
    const small = big(100);
    expect((await post(base, small, signed("2")(small))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("refuses by Content-Length without waiting for a body that never comes", async () => {
    const { service, calls } = integrations({ config: { maxBodyBytes: 1000 } });
    const port = Number(new URL(serve(service)).port);
    let text = "";
    const closed = Promise.withResolvers<void>();
    const socket = await Bun.connect({
      hostname: "localhost",
      port,
      socket: {
        data: (_socket, chunk) => {
          text += chunk.toString();
        },
        close: () => closed.resolve(),
        error: () => closed.resolve(),
      },
    });
    socket.write(
      "POST /api/integrations/github HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n",
    );
    await Promise.race([
      new Promise((resolve) => {
        const timer = setInterval(() => {
          if (!text.includes("\r\n\r\n")) return;
          clearInterval(timer);
          resolve(0);
        }, 10);
      }),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    socket.end();
    await closed.promise;
    expect(text).toStartWith("HTTP/1.1 413");
    expect(calls).toHaveLength(0);
  });

  it("holds the cap for a chunked body that declares no length", async () => {
    const { service, calls } = integrations({ config: { maxBodyBytes: 1000 } });
    const base = serve(service);
    const chunked = (sizes: number[], headers: Record<string, string> = {}) => {
      const encoder = new TextEncoder();
      return fetch(`${base}/api/integrations/github`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: new ReadableStream({
          start(controller) {
            for (const size of sizes)
              controller.enqueue(encoder.encode("x".repeat(size)));
            controller.close();
          },
        }),
        duplex: "half",
      } as RequestInit);
    };
    expect((await chunked([600, 600])).status).toBe(413);
    expect((await chunked([5000])).status).toBe(413);
    const text = '{"action":"chunked"}';
    const response = await fetch(`${base}/api/integrations/github`, {
      method: "POST",
      headers: { "content-type": "application/json", ...signed("3")(text) },
      body: new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(text.slice(0, 7)));
          controller.enqueue(encoder.encode(text.slice(7)));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(200);
    expect(calls).toEqual([{ input: { action: "chunked" }, eventId: "3" }]);
  });

  it("defaults the cap to 1 MiB", async () => {
    const { service } = integrations();
    const base = serve(service);
    expect((await post(base, big(1024 * 1024 + 1))).status).toBe(413);
    const fits = big(1024 * 1024 - 100);
    expect((await post(base, fits, signed("1")(fits))).status).toBe(200);
  });
});

describe("the payload", () => {
  it("answers 400 for a payload the schema refuses, and for one that is not JSON", async () => {
    const { service, calls } = integrations();
    const base = serve(service);
    for (const [index, body] of [
      '{"action": 3}',
      "{}",
      "[]",
      "not json",
      "",
    ].entries()) {
      const response = await post(base, body, signed(String(index))(body));
      expect(response.status).toBe(400);
      expect((await response.json()).name).toBe("ValidationError");
    }
    expect(calls).toHaveLength(0);
  });

  it("drops properties the schema does not declare, nested ones too", async () => {
    const { service, calls } = integrations({
      config: {
        input: t.Object({
          action: t.String(),
          repository: t.Object({ id: t.Number() }),
          labels: t.Array(t.Object({ name: t.String() })),
        }),
      },
    });
    const base = serve(service);
    const body = JSON.stringify({
      action: "opened",
      customer_email: "victim@example.com",
      repository: { id: 1, owner: { email: "x@y.z" } },
      labels: [{ name: "bug", color: "red" }],
    });
    expect((await post(base, body, signed("1")(body))).status).toBe(200);
    expect(calls[0]!.input).toEqual({
      action: "opened",
      repository: { id: 1 },
      labels: [{ name: "bug" }],
    });
  });

  it("reads a form body and coerces its values like query values", async () => {
    const calls: unknown[] = [];
    const service = defineService("forms", {});
    service.webhook({
      name: "form",
      replay: false,
      verify: () => true,
      input: t.Object({
        n: t.Number(),
        flag: t.Boolean(),
        tags: t.Array(t.String()),
        meta: t.Object({ a: t.Number() }),
      }),
      execute: ({ input }) => {
        calls.push(input);
      },
    });
    const base = serve(service);
    const response = await fetch(`${base}/api/forms/form`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "n=5&flag=true&tags=a&tags=b&meta=%7B%22a%22%3A1%7D&extra=1",
    });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { n: 5, flag: true, tags: ["a", "b"], meta: { a: 1 } },
    ]);
    const bad = await fetch(`${base}/api/forms/form`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "n=five&flag=true&tags=a&meta=%7B%22a%22%3A1%7D",
    });
    expect(bad.status).toBe(400);
  });

  it("serves a GET webhook from its query string", async () => {
    const calls: unknown[] = [];
    const service = defineService("gets", {});
    service.webhook({
      name: "ping",
      method: "GET",
      replay: false,
      verify: ({ method, url }) => method === "GET" && url.includes("sig=ok"),
      input: t.Object({ n: t.Number(), sig: t.String() }),
      execute: ({ input }) => {
        calls.push(input);
      },
    });
    const base = serve(service);
    expect((await fetch(`${base}/api/gets/ping?n=4&sig=ok`)).status).toBe(200);
    expect((await fetch(`${base}/api/gets/ping?n=4&sig=no`)).status).toBe(401);
    expect(calls).toEqual([{ n: 4, sig: "ok" }]);
  });

  it("answers with a Response as it is, and { ok: true } for nothing", async () => {
    const { service } = integrations({
      config: {
        replay: false,
        execute: () =>
          new Response("<Response/>", {
            status: 202,
            headers: { "content-type": "text/xml", "x-extra": "1" },
          }),
      },
    });
    const base = serve(service);
    const response = await post(
      base,
      '{"action":"a"}',
      signed("1")('{"action":"a"}'),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("x-extra")).toBe("1");
    expect(await response.text()).toBe("<Response/>");
  });

  it("answers what the handler returns, and maps what it throws", async () => {
    const { service } = integrations({
      config: {
        replay: false,
        errors: { TEAPOT: { message: "No", status: 418 } },
        execute: ({ input, error }: any) => {
          if (input.action === "teapot") throw error.TEAPOT();
          if (input.action === "boom") throw new Error("internal detail");
          return { saw: input.action };
        },
      },
    });
    const base = serve(service);
    const call = async (action: string) => {
      const body = JSON.stringify({ action });
      return post(base, body, signed("1")(body));
    };
    expect(await (await call("fine")).json()).toEqual({ saw: "fine" });
    const teapot = await call("teapot");
    expect(teapot.status).toBe(418);
    expect((await teapot.json()).code).toBe("TEAPOT");
    const boom = await call("boom");
    expect(boom.status).toBe(500);
    expect(JSON.stringify(await boom.json())).not.toContain("internal detail");
  });
});

function replaySuite(
  name: string,
  driver: () => StorageDriver,
  lapse: () => Promise<void>,
  skip = false,
) {
  describe.skipIf(skip)(`replay on ${name}`, () => {
    let storage: ReturnType<typeof defineStorage>;
    beforeEach(() => {
      storage = defineStorage({ driver: driver() });
    });
    afterEach(() => storage.close());

    const body = JSON.stringify({ action: "a" });
    const send = (
      base: string,
      id: string,
      extra: Record<string, string> = {},
    ) => post(base, body, signed(id, extra)(body));

    function held() {
      const gates = new Map<string, PromiseWithResolvers<"ok" | "throw">>();
      const started: string[] = [];
      const gate = (run: string) => {
        if (!gates.has(run)) gates.set(run, Promise.withResolvers());
        return gates.get(run)!;
      };
      return {
        gate,
        started,
        execute: async ({ ctx }: any) => {
          const run = ctx.request.headers.get("x-run");
          started.push(run);
          if (run && (await gate(run).promise) === "throw")
            throw new Error("handler failed");
          return { ran: run };
        },
      };
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

    it("runs the first delivery, and answers a repeat after success with duplicate: true", async () => {
      const { service, calls } = integrations({ storage });
      const base = serve(service);
      const first = await send(base, "evt-1");
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ ok: true });
      const again = await send(base, "evt-1");
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({ duplicate: true });
      expect(calls).toHaveLength(1);
      expect((await send(base, "evt-2")).status).toBe(200);
      expect(calls).toHaveLength(2);
    });

    it("keeps one event id apart per service and per webhook", async () => {
      const a = integrations({ storage });
      const other = defineService("other", { deps: { cache: storage } });
      const otherCalls: unknown[] = [];
      other.webhook({
        name: "github",
        verify: github,
        eventId: delivery,
        input: t.Object({ action: t.String() }),
        execute: ({ input }) => {
          otherCalls.push(input);
        },
      });
      a.service.webhook({
        name: "gitlab",
        verify: github,
        eventId: delivery,
        input: t.Object({ action: t.String() }),
        execute: () => {},
      });
      const base = serve(a.service, other);
      expect((await send(base, "same")).status).toBe(200);
      expect(
        await (
          await post(
            base,
            body,
            signed("same")(body),
            "/api/integrations/gitlab",
          )
        ).json(),
      ).toEqual({ ok: true });
      expect(
        await (
          await post(base, body, signed("same")(body), "/api/other/github")
        ).json(),
      ).toEqual({ ok: true });
      expect(a.calls).toHaveLength(1);
      expect(otherCalls).toHaveLength(1);
    });

    it("answers 409 to a delivery that arrives while another is being handled, and 200 duplicate once it is done", async () => {
      const h = held();
      const { service } = integrations({
        storage,
        config: { execute: h.execute },
      });
      const base = serve(service);
      const first = send(base, "evt", { "x-run": "A" });
      await settle();
      expect(h.started).toEqual(["A"]);
      const concurrent = await send(base, "evt", { "x-run": "B" });
      expect(concurrent.status).toBe(409);
      expect((await concurrent.json()).code).toBe("CONFLICT");
      expect(h.started).toEqual(["A"]);
      h.gate("A").resolve("ok");
      expect((await first).status).toBe(200);
      expect(await (await send(base, "evt", { "x-run": "C" })).json()).toEqual({
        duplicate: true,
      });
      expect(h.started).toEqual(["A"]);
    });

    it("releases the claim when execute throws, so the provider's retry runs", async () => {
      const h = held();
      const { service } = integrations({
        storage,
        config: { execute: h.execute },
      });
      const base = serve(service);
      const failing = send(base, "evt", { "x-run": "A" });
      await settle();
      h.gate("A").resolve("throw");
      expect((await failing).status).toBe(500);
      const retry = send(base, "evt", { "x-run": "B" });
      await settle();
      h.gate("B").resolve("ok");
      expect((await retry).status).toBe(200);
      expect(h.started).toEqual(["A", "B"]);
      expect(await (await send(base, "evt", { "x-run": "C" })).json()).toEqual({
        duplicate: true,
      });
    });

    it("releases the claim when the context hook refuses, when the rate limit refuses, and for a failing Response", async () => {
      let refuse = true;
      const { service, calls } = integrations({
        storage,
        service: {
          context: () => {
            if (refuse) throw new Error("context failed");
            return {};
          },
        },
      });
      const base = serve(service);
      expect((await send(base, "evt")).status).toBe(500);
      refuse = false;
      expect((await send(base, "evt")).status).toBe(200);
      expect(calls).toHaveLength(1);

      resetGlobalRegistry();
      let status = 503;
      const limited = integrations({
        storage,
        config: {
          rateLimit: { per: () => "k", max: 1, windowMs: 60_000 },
          execute: () => new Response("later", { status }),
        },
      });
      const second = serve(limited.service);
      expect((await send(second, "a")).status).toBe(503);
      expect((await send(second, "a")).status).toBe(429);
      expect((await send(second, "b")).status).toBe(429);
      status = 200;
      setSystemTime(new Date(Date.now() + 120_000));
      await lapse();
      expect((await send(second, "a")).status).toBe(200);
      expect(await (await send(second, "a")).json()).toEqual({
        duplicate: true,
      });
    });

    it("releases only its own claim: a handler that fails after its lease lapsed does not free the delivery that took over", async () => {
      const h = held();
      const { service } = integrations({
        storage,
        config: { execute: h.execute },
      });
      const base = serve(service);
      const first = send(base, "evt", { "x-run": "A" });
      await settle();
      await lapse();
      const second = send(base, "evt", { "x-run": "B" });
      await settle();
      expect(h.started).toEqual(["A", "B"]);
      h.gate("A").resolve("throw");
      expect((await first).status).toBe(500);
      expect((await send(base, "evt", { "x-run": "C" })).status).toBe(409);
      expect(h.started).toEqual(["A", "B"]);
      h.gate("B").resolve("ok");
      expect((await second).status).toBe(200);
      expect(await (await send(base, "evt", { "x-run": "D" })).json()).toEqual({
        duplicate: true,
      });
    });

    it("remembers a handled id for replay.ttlMs and then runs it again", async () => {
      const { service, calls } = integrations({
        storage,
        config: { replay: { ttlMs: 150 } },
      });
      const base = serve(service);
      expect((await send(base, "evt")).status).toBe(200);
      expect(await (await send(base, "evt")).json()).toEqual({
        duplicate: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await lapse();
      expect(await (await send(base, "evt")).json()).toEqual({ ok: true });
      expect(calls).toHaveLength(2);
    });

    it("answers 400 to a verified delivery that has no id, without running it", async () => {
      const { service, calls } = integrations({ storage });
      const base = serve(service);
      const response = await post(base, body, {
        "x-hub-signature-256": sign(body),
      });
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it('takes 0 as an id, and 7 and "7" as one', async () => {
      const ids: Record<string, unknown> = { zero: 0, number: 7, string: "7" };
      const { service, calls } = integrations({
        storage,
        config: { eventId: ({ headers }: any) => ids[headers.get("x-id")] },
      });
      const base = serve(service);
      const go = (id: string) =>
        post(base, body, { "x-hub-signature-256": sign(body), "x-id": id });
      expect((await go("zero")).status).toBe(200);
      expect(await (await go("zero")).json()).toEqual({ duplicate: true });
      expect((await go("number")).status).toBe(200);
      expect(await (await go("string")).json()).toEqual({ duplicate: true });
      expect(calls.map((call) => call.eventId)).toEqual(["0", "7"]);
    });

    it("answers an id that is not a non-empty string or a safe integer as no id", async () => {
      const ids: Record<string, unknown> = {
        empty: "",
        object: { id: 1 },
        array: ["a"],
        flag: true,
        nan: Number.NaN,
        fraction: 1.5,
        unsafe: 2 ** 53 + 2,
        infinity: Number.POSITIVE_INFINITY,
        none: null,
      };
      const { service, calls } = integrations({
        storage,
        config: { eventId: ({ headers }: any) => ids[headers.get("x-id")] },
      });
      const base = serve(service);
      for (const id of Object.keys(ids)) {
        const response = await post(base, body, {
          "x-hub-signature-256": sign(body),
          "x-id": id,
        });
        expect([id, response.status]).toEqual([id, 400]);
      }
      expect(calls).toHaveLength(0);
    });

    it("does not take the hash of a long id for an id of its own", async () => {
      const { service, calls } = integrations({ storage });
      const base = serve(service);
      const long = "x".repeat(200);
      const hash = createHash("sha256").update(long).digest("hex");
      expect((await send(base, long)).status).toBe(200);
      expect(await (await send(base, hash)).json()).toEqual({ ok: true });
      expect(await (await send(base, long)).json()).toEqual({
        duplicate: true,
      });
      expect(calls).toHaveLength(2);
    });

    it("hashes a long event id into the key, and still tells ids apart", async () => {
      const { service, calls } = integrations({ storage });
      const base = serve(service);
      const long = "x".repeat(5000);
      expect((await send(base, long)).status).toBe(200);
      expect((await send(base, `${long}y`)).status).toBe(200);
      expect(await (await send(base, long)).json()).toEqual({
        duplicate: true,
      });
      expect(calls).toHaveLength(2);
    });
  });
}

replaySuite("memory", memory, async () => {
  setSystemTime(new Date(Date.now() + 6 * 60_000));
});

const prefix = `webhook-test-${crypto.randomUUID().slice(0, 8)}:`;
const raw = redisUrl ? new Bun.RedisClient(redisUrl) : undefined;
afterAll(async () => {
  if (!raw) return;
  const keys: string[] = await raw.send("KEYS", [`${prefix}*`]);
  if (keys.length) await raw.send("DEL", keys);
  raw.close();
});
let current = prefix;
replaySuite(
  "redis",
  () =>
    redis({
      url: redisUrl,
      prefix: (current = `${prefix}${crypto.randomUUID()}:`),
    }),
  async () => {
    const keys: string[] = await raw!.send("KEYS", [`${current}*`]);
    for (const key of keys) await raw!.send("PEXPIRE", [key, "1"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
  },
  !redisUrl,
);

describe("a handled id", () => {
  it("is kept for replay.ttlMs, not only for the lease", async () => {
    const { service, calls } = integrations({
      config: { replay: { ttlMs: 60 * 60_000 } },
    });
    const base = serve(service);
    const body = JSON.stringify({ action: "a" });
    const send = () => post(base, body, signed("evt")(body));
    expect((await send()).status).toBe(200);
    setSystemTime(new Date(Date.now() + 6 * 60_000));
    expect(await (await send()).json()).toEqual({ duplicate: true });
    setSystemTime(new Date(Date.now() + 60 * 60_000));
    expect(await (await send()).json()).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });
});

describe("when the storage cannot answer", () => {
  const unavailable = (): StorageUnavailableError =>
    new StorageUnavailableError("down");
  const body = JSON.stringify({ action: "a" });

  it("answers 503 without running execute, and never calls the delivery handled", async () => {
    const down: KeyValueDriver = {
      ...memory(),
      putIfAbsent: async () => {
        throw unavailable();
      },
    };
    const { service, calls } = integrations({
      storage: defineStorage({ driver: down }),
    });
    const base = serve(service);
    const response = await post(base, body, signed("1")(body));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe("SERVICE_UNAVAILABLE");
    expect(calls).toHaveLength(0);
  });

  it("answers 503 against a Redis that is not there", async () => {
    const { service, calls } = integrations({
      storage: defineStorage({ driver: redis({ url: "redis://127.0.0.1:1" }) }),
    });
    const base = serve(service);
    expect((await post(base, body, signed("1")(body))).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("frees a claim that was applied although its write rejected, so the retry is not held off", async () => {
    const real = memory();
    let fail = true;
    const flaky: KeyValueDriver = {
      ...real,
      putIfAbsent: async (key, value, ttl) => {
        const result = await real.putIfAbsent(key, value, ttl);
        if (fail) throw unavailable();
        return result;
      },
    };
    const { service, calls } = integrations({
      storage: defineStorage({ driver: flaky }),
    });
    const base = serve(service);
    expect((await post(base, body, signed("1")(body))).status).toBe(503);
    fail = false;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await post(base, body, signed("1")(body))).status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("still answers the failure of execute while the storage is down, and does not hold the response up", async () => {
    const real = memory();
    let down = false;
    const flaky: KeyValueDriver = {
      ...real,
      compareAndDelete: async () => {
        throw unavailable();
      },
    };
    const { service } = integrations({
      storage: defineStorage({ driver: flaky }),
      config: {
        execute: () => {
          down = true;
          throw new Error("boom");
        },
      },
    });
    const base = serve(service);
    expect((await post(base, body, signed("1")(body))).status).toBe(500);
    expect(down).toBe(true);
  });

  it("answers the handler's success when the id cannot be recorded, and warns", async () => {
    const real = memory();
    const flaky: KeyValueDriver = {
      ...real,
      put: async () => {
        throw unavailable();
      },
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { service, calls } = integrations({
        storage: defineStorage({ driver: flaky }),
      });
      const base = serve(service);
      const response = await post(base, body, signed("1")(body));
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
      expect(JSON.stringify(warn.mock.calls)).not.toContain(TEST_ONLY_SECRET);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("replay: false", () => {
  it("runs every delivery, needs no storage and no event id", async () => {
    const service = defineService("plain", {});
    const calls: unknown[] = [];
    service.webhook({
      name: "hook",
      replay: false,
      verify: github,
      input: t.Object({ action: t.String() }),
      execute: ({ input, eventId }) => {
        calls.push({ input, eventId });
      },
    });
    const base = serve(service);
    const body = JSON.stringify({ action: "a" });
    for (let i = 0; i < 2; i++)
      expect(
        (
          await post(
            base,
            body,
            { "x-hub-signature-256": sign(body) },
            "/api/plain/hook",
          )
        ).status,
      ).toBe(200);
    expect(calls).toHaveLength(2);
  });
});

describe("startup errors", () => {
  const config = {
    name: "hook",
    verify: github,
    input: t.Object({ action: t.String() }),
    execute: () => {},
  };

  it("fails when nothing names the delivery and replay is not switched off", () => {
    const service = defineService("billing", {
      deps: { cache: defineStorage({ driver: memory() }) },
    });
    service.webhook(config);
    expect(() => service.build()).toThrow(
      /Service "billing": webhook 'hook' has no event id .*eventId: \(\{ input \}\).*signed.*standardWebhooks.*replay: false/,
    );
    expect(() => brick({ services: [service] })).toThrow(/no event id/);
  });

  it("does not fail when the verifier supplies the id, or eventId is given, or replay is false", () => {
    const cache = defineStorage({ driver: memory() });
    const service = defineService("billing", { deps: { cache } });
    service.webhook({
      ...config,
      name: "a",
      verify: standardWebhooks({ secret: "whsec_AAAA" }),
    });
    service.webhook({ ...config, name: "b", eventId: delivery });
    service.webhook({ ...config, name: "c", replay: false });
    expect(() => service.build()).not.toThrow();
  });

  it("fails when the service has no key-value storage, naming the service and the webhook and the fix", () => {
    const service = defineService("billing", {});
    service.webhook({ ...config, eventId: delivery });
    expect(() => service.build()).toThrow(
      /Service "billing": webhook 'hook' remembers the events it has handled, but the service has no key-value storage\. Add one: defineService\("billing", \{ deps: \{ cache: defineStorage\(\{ driver: redis\(\) \}\) \} \}\), or set replay: false\./,
    );
    expect(() => brick({ services: [service] })).toThrow(
      /no key-value storage/,
    );
    const free = defineService("free", {});
    free.webhook({ ...config, replay: false });
    expect(() => free.build()).not.toThrow();
  });

  it("fails without a verifier or an input schema, and on options it cannot run with", () => {
    const service = defineService("billing", {});
    const without = (key: string) => {
      const { [key]: _, ...rest } = config as Record<string, unknown>;
      return rest;
    };
    expect(() => service.webhook(without("verify") as never)).toThrow(
      /Service "billing": webhook 'hook' needs verify/,
    );
    expect(() => service.webhook(without("input") as never)).toThrow(
      /needs input/,
    );
    expect(() =>
      service.webhook({ ...config, verify: "secret" } as never),
    ).toThrow(/needs verify/);
    expect(() =>
      service.webhook({ ...config, method: "PUT" } as never),
    ).toThrow(/method must be/);
    expect(() =>
      service.webhook({ ...config, maxBodyBytes: 0 } as never),
    ).toThrow(/maxBodyBytes/);
    expect(() =>
      service.webhook({ ...config, replay: { ttlMs: -1 } } as never),
    ).toThrow(/replay.ttlMs/);
  });

  it("fails on authorize and output, which a webhook would silently ignore", () => {
    const service = defineService("billing", {});
    for (const [option, value] of [
      ["authorize", () => false],
      ["output", t.Object({})],
    ] as const)
      expect(() =>
        service.webhook({ ...config, [option]: value } as never),
      ).toThrow(
        new RegExp(
          `webhook 'hook': ${option} is not an option of a webhook.*verify is the check`,
        ),
      );
  });

  it("checks the rateLimit of a webhook, also when replay is off", () => {
    const service = defineService("billing", {});
    service.webhook({
      ...config,
      replay: false,
      rateLimit: { per: () => "k", max: 1, windowMs: 1000 },
    });
    expect(() => service.build()).toThrow(
      /Service "billing": action 'hook' declares rateLimit, but the service has no key-value storage/,
    );
  });

  it("shares the name and URL rules of actions", () => {
    const service = defineService("billing", {});
    service.action({ name: "foo-bar", execute: () => 1 });
    service.webhook({ ...config, name: "fooBar", replay: false });
    expect(() => brick({ services: [service] })).toThrow(
      /duplicate name "foo-bar" in service "billing"/,
    );
    const second = defineService("second", {});
    second.action({ name: "foo-bar", execute: () => 1 });
    second.webhook({ ...config, name: "fooBar", replay: false, path: "/x" });
    expect(() => brick({ services: [second] })).not.toThrow();
  });
});

describe("webhook.run", () => {
  it("runs execute with the given input, skipping verification and the replay check", async () => {
    const verify = spyOn({ verify: () => false as boolean }, "verify");
    const down: KeyValueDriver = {
      ...memory(),
      putIfAbsent: async () => {
        throw new StorageUnavailableError("down");
      },
    };
    const { service, webhook, calls } = integrations({
      storage: defineStorage({ driver: down }),
      config: { verify: verify as never },
    });
    expect(await webhook.run({ action: "replayed" })).toBeUndefined();
    expect(await webhook.run({ action: "replayed" })).toBeUndefined();
    expect(calls).toEqual([
      { input: { action: "replayed" }, eventId: undefined },
      { input: { action: "replayed" }, eventId: undefined },
    ]);
    expect(verify).not.toHaveBeenCalled();
    await expect(webhook.run({ action: 3 } as never)).rejects.toThrow(
      /Validation failed/,
    );
    void service;
  });
});

describe("where a webhook is listed", () => {
  function billing() {
    const service = defineService("billing", {
      deps: { cache: defineStorage({ driver: memory() }) },
    });
    service.action({
      name: "charge",
      authorize: () => true,
      input: t.Object({ n: t.Number() }),
      execute: () => 1,
    });
    service.webhook({
      name: "payments",
      description: "Payment events",
      verify: standardWebhooks({ secret: "whsec_AAAA" }),
      input: t.Object({ type: t.String() }),
      execute: () => {},
    });
    service.tool({ name: "lookup", execute: () => 1 });
    return service;
  }

  it("is left out of MCP", () => {
    const registry = createMcpRegistry({ services: [billing()] });
    expect(registry.listTools().map((tool) => tool.name)).toEqual(["lookup"]);
  });

  it("is told from an action by introspect(), and routed like one", () => {
    const service = billing();
    const actions = Object.fromEntries(
      service.introspect().actions.map((action) => [action.name, action]),
    );
    expect(actions.payments).toMatchObject({
      webhook: true,
      hasAuthorize: false,
    });
    expect(actions.charge!.webhook).toBeUndefined();
    const { ir } = compileBrickApplication({ services: [service] });
    expect(
      ir.routes.map((route) => [
        route.action,
        route.kind,
        route.path,
        route.method,
      ]),
    ).toEqual([
      ["charge", "action", "/api/billing/charge", "POST"],
      ["payments", "webhook", "/api/billing/payments", "POST"],
    ]);
    expect(ir.routes[1]!.bodyLimit).toBe(1024 * 1024);
    expect(ir.routes[0]!.bodyLimit).toBeUndefined();
  });

  it("is in OpenAPI with its input and the 401, 409 and 413 responses, and no bearer security", () => {
    const spec = generateOpenApiSpec({ services: [billing()] });
    const operation = spec.paths["/api/billing/payments"].post;
    expect(operation["x-brick-webhook"]).toBe(true);
    expect(operation.description).toBe("Payment events");
    expect(operation.security).toBeUndefined();
    expect(Object.keys(operation.responses)).toEqual(
      expect.arrayContaining(["200", "400", "401", "409", "413", "500", "503"]),
    );
    expect(
      operation.requestBody.content["application/json"].schema.properties,
    ).toHaveProperty("type");
    expect(operation.requestBody.content).toHaveProperty(
      "application/x-www-form-urlencoded",
    );
    const charge = spec.paths["/api/billing/charge"].post;
    expect(charge["x-brick-webhook"]).toBeUndefined();
    expect(charge.responses["413"]).toBeUndefined();
  });

  it("leaves an action unaffected: it keeps the synchronous fast path", () => {
    const service = defineService("fast", {});
    service.action({ name: "ping", execute: () => ({ pong: true }) });
    const { routes } = compileBrickApplication({ services: [service] });
    const result = routes[0]!.handler({
      set: { headers: {} },
      request: new Request("http://localhost/api/fast/ping", {
        method: "POST",
      }),
      headers: {},
    });
    expect(result).toEqual({ pong: true });
  });
});
