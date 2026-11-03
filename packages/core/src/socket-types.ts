import type { Static, TSchema } from "@sinclair/typebox";
import type {
  ActionErrorDefinition,
  ActionExecutionError,
  ErrorBuilder,
} from "./types";

export type SocketSchemas = Record<string, TSchema>;
export type SocketPayloads<S extends SocketSchemas> = {
  [K in keyof S]: Static<S[K]>;
};
export type SocketEventArgs<Events> = {
  [K in keyof Events & string]: [event: K, payload: Events[K]];
}[keyof Events & string];

export interface BrickSocketSender<Events> {
  /** Locally accepts a message. Does not acknowledge remote delivery. */
  send(...args: SocketEventArgs<Events>): void;
  close(): void;
}

export interface BrickSocketConfig<
  I extends SocketSchemas,
  O extends SocketSchemas,
  Ctx,
  E extends Record<string, ActionErrorDefinition> = {},
> {
  name: string;
  path?: string;
  description?: string;
  input: I;
  output: O;
  /** Defaults to the upgrade request's origin. */
  allowedOrigins?: readonly string[];
  allowMissingOrigin?: boolean;
  authorize?: (params: { ctx: Ctx }) => boolean | Promise<boolean>;
  /** Rooms the connection is put in when it opens. */
  rooms?: (params: {
    ctx: Ctx;
  }) => readonly string[] | Promise<readonly string[]>;
  /** Decides each room a client asks to join. Without it, client joins are refused. */
  join?: (params: { ctx: Ctx; room: string }) => boolean | Promise<boolean>;
  /** Rooms one connection can be in at once (default 100). */
  maxRooms?: number;
  /** Keep recent emits per room so a reconnecting client gets what it missed. Off by default. */
  replay?: SocketReplay;
  /**
   * Errors handlers may raise with `error.CODE()`, as an action declares them.
   * A raised error reaches the client's `onHandlerError` and the connection
   * stays open; anything else a handler throws still closes it with `1011`.
   */
  errors?: E;
  handlers: {
    [K in keyof I]: (params: {
      input: Static<I[K]>;
      ctx: Ctx;
      socket: BrickSocketSender<SocketPayloads<O>>;
      error: ErrorBuilder<E>;
    }) => void | Promise<void>;
  };
  open?: (params: {
    ctx: Ctx;
    socket: BrickSocketSender<SocketPayloads<O>>;
  }) => void | Promise<void>;
  close?: (params: {
    ctx: Ctx;
    socket: BrickSocketSender<SocketPayloads<O>>;
    code: number;
    reason: string;
  }) => void | Promise<void>;
}

export interface SocketEmitOptions {
  /** A transaction handle from `runInTransaction`: send on commit, drop on rollback. */
  after?: unknown;
}
export type SocketEmitArgs<Events> = {
  [K in keyof Events & string]: [
    event: K,
    payload: Events[K],
    options?: SocketEmitOptions,
  ];
}[keyof Events & string];

/** Returned by `service.socket()`. Emits and kicks reach every process through the app's broker. */
export interface BrickSocketHandle<Output> {
  readonly name: string;
  /** Validates and serializes once, then sends to every connection in the rooms. At most once, unacknowledged. */
  emit(
    rooms: string | readonly string[],
    ...args: SocketEmitArgs<Output>
  ): void;
  /** Removes connections from a room; `also` limits it to connections also in that room. */
  kick(room: string, options?: { also?: string; reason?: string }): void;
}

export interface SocketReplay {
  /** Emits kept per room. */
  keep: number;
  /** How long a room's history lasts without new emits. */
  maxAgeMs: number;
}

export type SocketBrokerMessage =
  /** `seq` is set by the broker for sockets with replay: `<number>-<number>`, rising per room. */
  | { type: "emit"; topic: string; frame: string; seq?: string }
  | { type: "kick"; topic: string; also?: string; reason?: string };

/** Carries emits and kicks between processes. Topics are `<service>.<socket>:<room>`. */
export interface SocketBroker {
  /**
   * Sends to every subscriber of `message.topic`, in every process, this one
   * included. With `replay`, also keeps the emit and gives it a `seq`.
   */
  publish(message: SocketBrokerMessage, replay?: SocketReplay): void;
  /** The current position of a room, below every later `seq`. Needed for replay. */
  head?(topic: string): string | Promise<string>;
  /** Kept emits after `since`, or undefined when the history no longer covers it. Needed for replay. */
  history?(
    topic: string,
    since: string,
    replay: SocketReplay,
  ):
    | SocketBrokerMessage[]
    | undefined
    | Promise<SocketBrokerMessage[] | undefined>;
  /** Called once per local holder of a topic; returns its unsubscribe. */
  subscribe(
    topic: string,
    deliver: (message: SocketBrokerMessage) => void,
  ): () => void;
  /** Resolves once messages for a topic just subscribed reach this process. */
  ready?(topic: string): Promise<void>;
  close?(): void | Promise<void>;
}

export interface BrickSocketReconnectOptions {
  /** Default 500. */
  minDelayMs?: number;
  /** Default 30 000. */
  maxDelayMs?: number;
  /** Random spread around each delay, 0 to 1. Default 0.2. */
  jitter?: number;
}

export type BrickSocketStatus =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface BrickSocketConnectOptions {
  signal?: AbortSignal;
  /** Limits each opening attempt. */
  timeoutMs?: number;
  /** Called on every connect and reconnect; sent as the `brick.token.<token>` subprotocol. */
  token?: () => string | Promise<string>;
  /** On by default. `false` ends the client at the first close. */
  reconnect?: false | BrickSocketReconnectOptions;
}

export class BrickSocketError extends Error {
  constructor(
    readonly kind: "connection" | "protocol" | "backpressure" | "refused",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BrickSocketError";
  }
}

/** The framework codes every socket handler can raise, besides its declared ones. */
type StandardSocketErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_SERVER_ERROR";

/** An error a socket handler raised with `error.CODE()`, for the message `event` it was handling. */
export type BrickSocketHandlerError<
  Input = unknown,
  Errors = {},
> = ActionExecutionError & {
  event: keyof Input & string;
  code: Extract<keyof Errors, string> | StandardSocketErrorCode;
};

export interface BrickSocketClient<
  Input,
  Output,
  Errors = {},
> extends BrickSocketSender<Input> {
  /** Resolves on the first open; rejects if the client closes before it. */
  readonly ready: Promise<void>;
  readonly status: BrickSocketStatus;
  onStatus(listener: (status: BrickSocketStatus) => void): () => void;
  /** After each reconnect. Messages sent while offline are not replayed. */
  onReconnect(listener: () => void): () => void;
  on<K extends keyof Output & string>(
    event: K,
    listener: (payload: Output[K]) => void,
  ): () => void;
  /** Resolves when the server accepts the room; rejects with kind `refused` otherwise. */
  join(room: string): Promise<void>;
  leave(room: string): void;
  /** The server removed this connection from a room. */
  onLeave(listener: (room: string, reason?: string) => void): () => void;
  /** Replay could not cover what this client missed in a room while away: refetch it. */
  onGap(listener: (room: string) => void): () => void;
  onError(listener: (error: BrickSocketError) => void): () => void;
  /** A handler raised a declared error for a message this client sent. The connection stays open. */
  onHandlerError(
    listener: (error: BrickSocketHandlerError<Input, Errors>) => void,
  ): () => void;
  onClose(
    listener: (info: { code: number; reason: string }) => void,
  ): () => void;
}

/** Browser metadata. Schemas retain TypeBox kinds as JSON-safe annotations. */
export interface BrickClientSocket<
  Input = unknown,
  Output = unknown,
  Errors = {},
> {
  kind: "socket";
  name: string;
  serviceName: string;
  config: { path: string };
  output: Record<string, unknown>;
  readonly __types?: { input: Input; output: Output; errors: Errors };
}

export interface BrickSocketSchema {
  name: string;
  path?: string;
  description?: string;
  input: string[];
  output: string[];
  hasAuthorize: boolean;
}
