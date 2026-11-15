import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SecretRef } from "./secrets";
import type { WebhookRequest, WebhookVerifier } from "./webhook";

type SecretInput = string | SecretRef<string>;
/** One secret, or several so a secret can be rotated: any one that verifies accepts. */
export type WebhookSecret = SecretInput | readonly SecretInput[];

function valuesOf(secret: WebhookSecret): string[] {
  const list = Array.isArray(secret) ? secret : [secret];
  const values = list.map((item: SecretInput) =>
    typeof item === "string" ? item : item.require(),
  );
  if (!values.length || values.some((value) => !value.trim()))
    throw new Error("A webhook secret is empty");
  return values;
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const hasBody = (method: string) => method === "POST";

function matchesAnyWithoutShortCircuit(
  given: string,
  candidates: string[],
): boolean {
  let found = false;
  for (const candidate of candidates) found = same(given, candidate) || found;
  return found;
}

export interface HmacSignatureOptions {
  /** The secret the provider signs with; a list accepts any of them, to rotate. */
  secret: WebhookSecret;
  /** The header that carries the signature, such as `x-hub-signature-256`. */
  header: string;
  /** What the header puts before the signature, such as `sha256=`. A header without it is refused. */
  prefix?: string;
  /** Default `"sha256"`. */
  algorithm?: "sha1" | "sha256" | "sha384" | "sha512";
  /** How the signature is written in the header: default `"hex"`. */
  encoding?: "hex" | "base64";
}

/**
 * Verifies an HMAC of the raw body, compared in constant time with a header.
 * It signs the body alone and checks no timestamp. Give the webhook an
 * `eventId`: it stops a replayed capture only when it comes from the signed body.
 *
 * @example
 * verify: hmacSignature({ secret: githubSecret, header: "x-hub-signature-256", prefix: "sha256=" })
 */
export function hmacSignature(options: HmacSignatureOptions): WebhookVerifier {
  const {
    header,
    prefix = "",
    algorithm = "sha256",
    encoding = "hex",
  } = options;
  const verify: WebhookVerifier = ({ rawBody, headers, method }) => {
    if (!hasBody(method)) return false;
    const value = headers.get(header);
    if (value === null || !value.startsWith(prefix)) return false;
    const given = value.slice(prefix.length);
    const expected = valuesOf(options.secret).map((secret) =>
      createHmac(algorithm, secret).update(rawBody).digest(encoding),
    );
    return matchesAnyWithoutShortCircuit(
      encoding === "hex" ? given.toLowerCase() : given,
      expected,
    );
  };
  return Object.assign(verify, { signsBody: true as const });
}

function keyOf(secret: string): Buffer {
  const encoded = secret.trim().replace(/^whsec_/, "");
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    ? Buffer.from(encoded, "base64")
    : Buffer.alloc(0);
  if (!key.length)
    throw new Error("A Standard Webhooks secret is not base64, or is empty");
  return key;
}

export interface StandardWebhooksOptions {
  /** The `whsec_…` secret; a list accepts any of them, to rotate. */
  secret: WebhookSecret;
  /** How far the timestamp may be from now, either way. Default 5 minutes. */
  toleranceMs?: number;
}

/**
 * Verifies the Standard Webhooks scheme (standardwebhooks.com): a base64
 * HMAC-SHA256 of `id.timestamp.body` in `webhook-signature`, as `v1,<signature>`
 * entries separated by spaces, with the timestamp in `webhook-timestamp`.
 * Svix's `svix-id`, `svix-timestamp` and `svix-signature` are read the same way.
 * The id header is the event id, so the webhook needs no `eventId`.
 *
 * @example
 * verify: standardWebhooks({ secret: billingSecret })
 */
export function standardWebhooks(
  options: StandardWebhooksOptions,
): WebhookVerifier {
  const toleranceMs = options.toleranceMs ?? 5 * 60_000;
  const verify: WebhookVerifier = ({ rawBody, headers, method }) => {
    if (!hasBody(method)) return false;
    const header = (name: string) =>
      headers.get(`webhook-${name}`) ?? headers.get(`svix-${name}`);
    const id = header("id");
    const timestamp = header("timestamp");
    const signatures = header("signature");
    if (!id || !timestamp || !signatures || !/^\d{1,15}$/.test(timestamp))
      return false;
    if (Math.abs(Date.now() - Number(timestamp) * 1000) > toleranceMs)
      return false;
    const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`), rawBody]);
    const expected = valuesOf(options.secret).map((secret) =>
      createHmac("sha256", keyOf(secret)).update(signed).digest("base64"),
    );
    let ok = false;
    for (const entry of signatures.split(" ")) {
      // Only `v1` is symmetric; other versions (`v1a`) are not ours to check.
      const [version, signature] = entry.split(",");
      if (version === "v1" && signature)
        ok = matchesAnyWithoutShortCircuit(signature, expected) || ok;
    }
    return ok ? { eventId: id } : false;
  };
  return Object.assign(verify, {
    suppliesEventId: true as const,
    signsBody: true as const,
  });
}

export interface TwilioSignatureOptions {
  /** The account's auth token; a list accepts any of them, to rotate. */
  authToken: WebhookSecret;
  /**
   * The URL Twilio called, exactly as Twilio signed it (the scheme, host,
   * path and query). The server cannot know it behind a proxy, so the app says.
   * Twilio drops the port from the URL it signs for HTTPS voice callbacks.
   */
  url: string | ((request: WebhookRequest) => string | Promise<string>);
}

/**
 * Verifies Twilio's `X-Twilio-Signature`: a base64 HMAC-SHA1, keyed with the
 * auth token, of the URL followed by the form parameters sorted by name, each
 * as name and value. For a JSON body, Twilio signs the URL alone and puts the
 * body's SHA-256 (hex) in its `bodySHA256` query parameter, which is checked
 * against the body. For a GET, it signs the URL alone,
 * and a request whose query is not the signed URL's is refused. It supplies no event id: give the webhook an `eventId`.
 *
 * @example
 * verify: twilioSignature({ authToken, url: "https://api.example.com/api/telephony/voice-status" })
 */
export function twilioSignature(
  options: TwilioSignatureOptions,
): WebhookVerifier {
  return async (request) => {
    const given = request.headers.get("x-twilio-signature");
    if (!given) return false;
    const url =
      typeof options.url === "string"
        ? options.url
        : await options.url(request);
    if (
      request.method !== "POST" &&
      new URL(url).search !== new URL(request.url).search
    )
      return false;
    let signed = url;
    if (request.headers.get("content-type")?.includes("json")) {
      const claimed = new URL(url).searchParams.get("bodySHA256");
      const actual = createHash("sha256").update(request.rawBody).digest("hex");
      if (!claimed || !same(claimed.toLowerCase(), actual)) return false;
    } else if (request.method === "POST") {
      const form = new URLSearchParams(Buffer.from(request.rawBody).toString());
      for (const name of [...new Set(form.keys())].sort())
        // As Twilio's own libraries do: a repeated name adds each distinct value, sorted.
        for (const value of [...new Set(form.getAll(name))].sort())
          signed += name + value;
    }
    return matchesAnyWithoutShortCircuit(
      given,
      valuesOf(options.authToken).map((token) =>
        createHmac("sha1", token).update(signed).digest("base64"),
      ),
    );
  };
}
