// The wire contract between a Brick server and its clients. Browser-safe:
// constants, types and pure helpers, imported by both sides.
import {
  ActionExecutionError,
  ValidationError,
  type ValidationErrorItem,
} from "./types";

/** The codes every action, listener and socket handler can raise, with their status and default message. */
export const STANDARD_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Bad Request" },
  UNAUTHORIZED: { status: 401, message: "Unauthorized" },
  FORBIDDEN: { status: 403, message: "Forbidden" },
  NOT_FOUND: { status: 404, message: "Not Found" },
  CONFLICT: { status: 409, message: "Conflict" },
  INTERNAL_SERVER_ERROR: { status: 500, message: "Internal Server Error" },
} as const;

export type StandardErrorCode = keyof typeof STANDARD_ERRORS;

/** An error as JSON: the body of a failed HTTP call, and the data of a socket `$error` (with its `event`). */
export interface WireError {
  name: string;
  code: string;
  message: string;
  status: number;
  details?: unknown;
  errors?: ValidationErrorItem[];
}

/** Rebuild the error a server sent; `undefined` when the body is not a Brick error. */
export function decodeError(
  body: unknown,
  status: number,
): ActionExecutionError | ValidationError | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  if (record.name === "ValidationError")
    return new ValidationError(
      typeof record.message === "string" ? record.message : "Validation failed",
      Array.isArray(record.errors) ? record.errors : [],
      typeof record.status === "number" ? record.status : status,
    );
  if (typeof record.code !== "string") return undefined;
  return new ActionExecutionError(
    record.code,
    typeof record.message === "string" ? record.message : record.code,
    typeof record.status === "number" ? record.status : status,
    record.details ?? undefined,
  );
}

/** The subprotocol a Brick socket client offers and the server echoes. */
export const SOCKET_PROTOCOL = "brick.v1";
/** `brick.token.<token>`: a bearer token carried as a subprotocol, since browsers can't set headers on a WebSocket. */
export const SOCKET_TOKEN_PROTOCOL = "brick.token.";

/** Control messages, sent as frames whose event starts with `$`. */
export const SOCKET_CONTROL = {
  /** Client: `{room, since?}`. Server ack: `{room, ok, seq?}`. */
  join: "$join",
  /** Client: `{room}`. Server ack: `{room}`. */
  leave: "$leave",
  /** Server: `{room, reason?}`, the client was removed from a room. */
  left: "$left",
  /** Server: `{room, seq}`, history was lost; resume from `seq`. */
  gap: "$gap",
  /** Server: `{event, ...WireError}`, a handler raised a declared error. */
  error: "$error",
} as const;

/** Event names starting with `$` are reserved for control messages. */
export const isControlEvent = (event: string) => event.startsWith("$");

export const SOCKET_CLOSE = {
  normal: 1000,
  unsupportedData: 1003,
  abnormal: 1006,
  invalidPayload: 1007,
  policy: 1008,
  tooLarge: 1009,
  serverError: 1011,
  tryAgainLater: 1013,
  /** Client: the server sent an invalid message. */
  invalidServerMessage: 4000,
  /** Client: its send buffer is full. */
  clientBufferFull: 4001,
  /** Not sent by Brick: for proxies or custom servers refusing auth after the upgrade. */
  unauthorized: 4401,
  forbidden: 4403,
} as const;

/** Close codes after which the client does not reconnect: retrying would not help. */
export const SOCKET_STOP_CODES: ReadonlySet<number> = new Set([
  SOCKET_CLOSE.normal,
  SOCKET_CLOSE.unsupportedData,
  SOCKET_CLOSE.invalidPayload,
  SOCKET_CLOSE.policy,
  SOCKET_CLOSE.tooLarge,
  SOCKET_CLOSE.invalidServerMessage,
  SOCKET_CLOSE.unauthorized,
  SOCKET_CLOSE.forbidden,
]);

export const SOCKET_MAX_BYTES = 64 * 1024;
export const SOCKET_BUFFER_BYTES = 1024 * 1024;
const ROOM_MAX_BYTES = 200;
/** Bytes a replayed emit gains on delivery for its `room` and signed `seq`. */
export const SOCKET_REPLAY_HEADROOM = 300;
/** The length of a sequence's signature: base64url of an HMAC, cut short. */
export const SOCKET_SIGNATURE_LENGTH = 22;

export const byteLength = (value: string) =>
  new TextEncoder().encode(value).byteLength;

export const encodeFrame = (event: string, data: unknown) =>
  JSON.stringify({ event, data });

/** Adds the room and signed sequence to an encoded frame of a socket with replay. */
export const replayFrame = (frame: string, room: string, seq: string) =>
  `${frame.slice(0, -1)},"room":${JSON.stringify(room)},"seq":${JSON.stringify(seq)}}`;

export function isSocketEnvelope(
  value: unknown,
): value is { event: string; data: unknown } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "event" in value &&
    typeof value.event === "string" &&
    "data" in value &&
    Object.keys(value).length === 2
  );
}

/** Parses a server frame: an envelope, plus `room` and `seq` on a replayed emit. Throws on anything else. */
export function decodeFrame(text: unknown): {
  event: string;
  data: unknown;
  room?: string;
  seq?: string;
} {
  if (typeof text !== "string" || byteLength(text) > SOCKET_MAX_BYTES)
    throw new Error(`Expected JSON text under ${SOCKET_MAX_BYTES / 1024} KiB`);
  const parsed: unknown = JSON.parse(text);
  const { room, seq, ...message } = (
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  ) as Record<string, unknown>;
  if (
    (room !== undefined || seq !== undefined) &&
    !(isSocketRoom(room) && isSocketSeq(seq))
  )
    throw new Error("Invalid socket sequence");
  if (!isSocketEnvelope(message)) throw new Error("Invalid socket envelope");
  return room === undefined
    ? message
    : { ...message, room, seq: seq as string };
}

/** `prefix:value`, at most 200 bytes, without control characters. */
export function isSocketRoom(value: unknown): value is string {
  return (
    typeof value === "string" &&
    // eslint-disable-next-line no-control-regex
    /^[A-Za-z][\w-]*:[^\u0000-\u001f\u007f]+$/.test(value) &&
    byteLength(value) <= ROOM_MAX_BYTES
  );
}

/** A replay sequence: `<number>-<number>`, the shape of a Redis stream id, then `.` and the server's signature for its room. */
const SIGNED_SEQ = new RegExp(
  `^\\d{1,20}-\\d{1,20}\\.[\\w-]{${SOCKET_SIGNATURE_LENGTH}}$`,
);

export const isSocketSeq = (value: unknown): value is string =>
  typeof value === "string" && SIGNED_SEQ.test(value);

export const signSeq = (seq: string, signature: string) =>
  `${seq}.${signature}`;

/** The sequence and signature of a signed sequence. */
export const splitSeq = (signed: string) =>
  signed.split(".") as [seq: string, signature: string];

/** Orders two sequences, signed or not. */
export function compareSocketSeq(a: string, b: string): number {
  const [a1, a2] = splitSeq(a)[0].split("-").map(BigInt) as [bigint, bigint];
  const [b1, b2] = splitSeq(b)[0].split("-").map(BigInt) as [bigint, bigint];
  if (a1 !== b1) return a1 > b1 ? 1 : -1;
  return a2 === b2 ? 0 : a2 > b2 ? 1 : -1;
}
