import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Elysia } from "elysia";
import { websocket } from "elysia/websocket";
import { createLogger } from "./logger";
import { kebabCase } from "./kebab";
import { joinRoute, ownerPath } from "./routes";
import { buildErrorHelpers } from "./action";
import {
  ActionExecutionError,
  type ActionErrorDefinition,
  type BaseContext,
} from "./types";
import { getCompiledCheck } from "./typebox";
import { inTransaction, onTransactionCommit } from "./events/transaction";
import { serializeSocketSchema } from "./socket-schema";
import {
  byteLength,
  encodeFrame,
  isControlEvent,
  isSocketEnvelope,
  isSocketRoom,
  isSocketSeq,
  replayFrame,
  replayHeadroom,
  signSeq,
  splitSeq,
  SOCKET_BUFFER_BYTES,
  SOCKET_BUFFER_MESSAGES,
  STANDARD_ERRORS,
  SOCKET_CLOSE,
  SOCKET_CONTROL,
  SOCKET_MAX_BYTES,
  SOCKET_PROTOCOL,
  SOCKET_SIGNATURE_LENGTH,
  SOCKET_TOKEN_PROTOCOL,
} from "./protocol";
import { publicOrigin } from "./cors";
import type {
  BrickSocketConfig,
  BrickSocketSender,
  SocketBroker,
  SocketBrokerMessage,
  SocketEmitArgs,
  SocketPayloads,
  SocketSchemas,
  RegisteredSocket,
  SocketSender,
  SocketSession,
} from "./socket-types";

export type { RegisteredSocket };

class SocketDenied extends Error {}

/** Validates and serializes one output message, rechecking what survives JSON. */
function outputFrame(
  output: SocketSchemas,
  event: string,
  data: unknown,
): string {
  const schema = Object.hasOwn(output, event) ? output[event] : undefined;
  if (!schema || !getCompiledCheck(schema).Check(data))
    throw new Error("Invalid socket output");
  const frame = encodeFrame(event, data);
  if (byteLength(frame) > SOCKET_MAX_BYTES)
    throw new Error("Socket output too large");
  if (!getCompiledCheck(schema).Check(JSON.parse(frame).data))
    throw new Error("Socket output is not JSON-compatible");
  return frame;
}

/** Delivers within this process. The default broker of every app. */
export function localBroker(): SocketBroker {
  const topics = new Map<string, Set<(message: SocketBrokerMessage) => void>>();
  // Replay history: one rising counter per process, prefixed with its start so a restart reads as a gap.
  const epoch = Date.now();
  let counter = 0;
  /** Rooms dropped from `kept` once idle, at counter values up to this. */
  let swept = 0;
  const kept = new Map<
    string,
    {
      entries: { n: number; at: number; message: SocketBrokerMessage }[];
      /** The highest n no longer kept. */
      trimmed: number;
      maxAgeMs: number;
    }
  >();
  const prune = (names: Iterable<string>) => {
    for (const topic of names) {
      const room = kept.get(topic);
      if (!room) continue;
      const oldest = Date.now() - room.maxAgeMs;
      while (room.entries[0] && room.entries[0].at < oldest)
        room.trimmed = room.entries.shift()!.n;
      if (!room.entries.length) {
        kept.delete(topic);
        swept = counter;
      }
    }
  };
  return {
    publish(message, replay) {
      if (message.type === "emit" && replay) {
        const n = ++counter;
        message = { ...message, seq: `${epoch}-${n}` };
        const room = kept.get(message.topic) ?? {
          entries: [],
          trimmed: 0,
          maxAgeMs: replay.maxAgeMs,
        };
        kept.set(message.topic, room);
        room.entries.push({ n, at: Date.now(), message });
        if (room.entries.length > replay.keep)
          room.trimmed = room.entries.shift()!.n;
        // shortcut: idle rooms are swept every 1000 emits, not on a timer; fine while emits keep coming.
        if (n % 1000 === 0) prune([...kept.keys()]);
      }
      for (const deliver of topics.get(message.topic) ?? []) deliver(message);
    },
    head: () => `${epoch}-${counter}`,
    history(topic, since) {
      const [from, n] = since.split("-").map(Number) as [number, number];
      if (from !== epoch || n > counter) return undefined;
      prune([topic]);
      const room = kept.get(topic);
      if (!room) return n >= swept ? [] : undefined;
      if (n < room.trimmed) return undefined;
      return room.entries
        .filter((entry) => entry.n > n)
        .map((entry) => entry.message);
    },
    subscribe(topic, deliver) {
      const listeners = topics.get(topic) ?? new Set();
      listeners.add(deliver);
      topics.set(topic, listeners);
      return () => {
        listeners.delete(deliver);
        if (!listeners.size) topics.delete(topic);
      };
    },
  };
}

export function defineServiceSocket<
  I extends SocketSchemas,
  O extends SocketSchemas,
  Ctx extends BaseContext,
  E extends Record<string, ActionErrorDefinition> = {},
>(
  service: string,
  config: BrickSocketConfig<I, O, Ctx, E>,
  resolve: (request: Request) => Promise<Ctx>,
): RegisteredSocket {
  if (
    !config.name ||
    config.name.split(".").some((part) => !/^[a-zA-Z_][\w-]*$/.test(part))
  )
    throw new Error("Invalid socket name");
  if (
    config.path !== undefined &&
    (!config.path.startsWith("/") ||
      /[?#*]/.test(config.path) ||
      config.path.split("/").some((segment) => segment.startsWith(":")))
  )
    throw new Error(
      "Socket path must be a static route (relative to its service) without a query or fragment",
    );
  const input = Object.freeze({ ...config.input });
  const output = Object.freeze({ ...config.output });
  const handlers = { ...config.handlers };
  if (
    Object.keys(input).length !== Object.keys(handlers).length ||
    Object.keys(input).some(
      (key) =>
        !Object.hasOwn(handlers, key) || typeof handlers[key] !== "function",
    )
  )
    throw new Error("Every socket input event needs exactly one handler");
  if ([...Object.keys(input), ...Object.keys(output)].some(isControlEvent))
    throw new Error("Socket event names starting with $ are reserved");
  const maxRooms = config.maxRooms ?? 100;
  if (!Number.isInteger(maxRooms) || maxRooms < 1)
    throw new Error("Socket maxRooms must be a positive integer");
  const replay = config.replay && { ...config.replay };
  if (
    replay &&
    !(
      Number.isInteger(replay.keep) &&
      replay.keep > 0 &&
      replay.maxAgeMs > 0 &&
      Number.isFinite(replay.maxAgeMs)
    )
  )
    throw new Error(
      "Socket replay needs a positive integer keep and a positive finite maxAgeMs",
    );
  for (const [path, schema] of [
    ...Object.entries(input).map(([k, v]) => [`input.${k}`, v] as const),
    ...Object.entries(output).map(([k, v]) => [`output.${k}`, v] as const),
  ]) {
    serializeSocketSchema(schema, path);
    getCompiledCheck(schema);
  }
  const typed = (socket: SocketSender): BrickSocketSender<SocketPayloads<O>> =>
    socket;
  const error = buildErrorHelpers(config.errors);
  const context = async (request: Request) => {
    const ctx = await resolve(request);
    if (config.authorize && !(await config.authorize({ ctx })))
      throw new SocketDenied();
    return ctx;
  };
  const topicPrefix = `${service}.${config.name}:`;
  const topic = (room: string) => {
    if (!isSocketRoom(room)) throw new Error(`Invalid socket room: ${room}`);
    return topicPrefix + room;
  };
  const brokers = new Set<SocketBroker>();
  const publish = (messages: SocketBrokerMessage[], after: unknown) => {
    const send = () => {
      for (const broker of brokers)
        for (const message of messages) broker.publish(message, replay);
    };
    if (after === undefined) return send();
    if (!inTransaction(after))
      throw new Error(
        "Socket emit { after: tx } needs a tx from runInTransaction(db, (tx) => ...); a plain db.transaction() is not tracked, so the emit could be sent for a write that rolls back",
      );
    void onTransactionCommit(after, send);
  };
  return {
    schema: {
      name: config.name,
      path: config.path,
      description: config.description,
      input: Object.keys(input),
      output: Object.keys(output),
      hasAuthorize: !!config.authorize,
    },
    input,
    output,
    ...(config.errors ? { errors: { ...config.errors } } : {}),
    allowedOrigins: config.allowedOrigins
      ? [...config.allowedOrigins]
      : undefined,
    allowMissingOrigin: config.allowMissingOrigin,
    maxRooms,
    replay,
    brokers,
    topicPrefix,
    topic,
    handle: {
      name: config.name,
      emit(rooms, ...[event, payload, options]: SocketEmitArgs<any>) {
        const unique = [
          ...new Set(typeof rooms === "string" ? [rooms] : rooms),
        ];
        const topics = unique.map(topic);
        const frame = outputFrame(output, event, payload);
        // Room and sequence are added to each replayed frame on delivery.
        if (
          replay &&
          unique.some(
            (room) =>
              byteLength(frame) + replayHeadroom(room) > SOCKET_MAX_BYTES,
          )
        )
          throw new Error("Socket output too large");
        publish(
          topics.map((topic) => ({ type: "emit", topic, frame })),
          options?.after,
        );
      },
      kick(room, options = {}) {
        publish(
          [
            {
              type: "kick",
              topic: topic(room),
              ...(options.also !== undefined
                ? { also: topic(options.also) }
                : {}),
              ...(options.reason !== undefined
                ? { reason: String(options.reason) }
                : {}),
            },
          ],
          undefined,
        );
      },
    },
    async connect(request) {
      const initial = await context(request);
      const rooms = [
        ...new Set(config.rooms ? await config.rooms({ ctx: initial }) : []),
      ];
      rooms.forEach(topic);
      if (rooms.length > maxRooms) throw new Error("Too many socket rooms");
      return {
        rooms,
        async open(socket) {
          await config.open?.({ ctx: initial, socket: typed(socket) });
        },
        async message(event, data, socket) {
          const schema = Object.hasOwn(input, event) ? input[event] : undefined;
          if (!schema || !getCompiledCheck(schema).Check(data))
            throw new SocketDenied();
          const ctx = await context(request);
          if (!socket.isOpen) return;
          // The schema and event were checked together before dispatch.
          const handler = handlers[event as keyof I];
          await handler({
            input: data as SocketPayloads<I>[keyof I],
            ctx,
            socket: typed(socket),
            error,
          });
        },
        async join(room) {
          const ctx = await context(request);
          return !!config.join && (await config.join({ ctx, room }));
        },
        async close(socket, code, reason) {
          await config.close?.({
            ctx: initial,
            socket: typed(socket),
            code,
            reason,
          });
        },
      };
    },
  };
}

/** `${prefix}/${service}/${socket}`; an explicit path is relative to the service. */
export function socketPath(
  prefix: string,
  service: string,
  socket: RegisteredSocket,
): string {
  return joinRoute(
    ownerPath(prefix, service),
    socket.schema.path ?? `/${kebabCase(socket.schema.name)}`,
  );
}

const protocols = (request: Request) =>
  (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);

/** Moves a `brick.token.<token>` subprotocol into `Authorization: Bearer` for the context resolver. */
function tokenRequest(request: Request): {
  token: boolean;
  request: Request;
} {
  const offered = protocols(request);
  const token = offered
    .find((protocol) => protocol.startsWith(SOCKET_TOKEN_PROTOCOL))
    ?.slice(SOCKET_TOKEN_PROTOCOL.length);
  if (!token) return { token: false, request };
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  const rest = offered.filter(
    (protocol) => !protocol.startsWith(SOCKET_TOKEN_PROTOCOL),
  );
  if (rest.length) headers.set("sec-websocket-protocol", rest.join(", "));
  else headers.delete("sec-websocket-protocol");
  return {
    token: true,
    request: new Request(request.url, { method: request.method, headers }),
  };
}

/** Each connection owns its queue and service session. */
export function mountSockets(
  app: Elysia,
  sockets: { service: string; path: string; definition: RegisteredSocket }[],
  broker: SocketBroker,
  secret?: string,
): void {
  if (secret === "") throw new Error("Brick: sockets.secret can't be empty");
  // A sequence is signed for its room, so a client resumes only a room it was sent that sequence in.
  const key = secret ?? randomBytes(32);
  const signature = (topic: string, seq: string) =>
    createHmac("sha256", key)
      .update(`${topic}\n${seq}`)
      .digest("base64url")
      .slice(0, SOCKET_SIGNATURE_LENGTH);
  const sign = (topic: string, seq: string) =>
    signSeq(seq, signature(topic, seq));
  const verify = (topic: string, signed: string) => {
    const [seq, sig] = splitSeq(signed);
    return timingSafeEqual(Buffer.from(sig), Buffer.from(signature(topic, seq)))
      ? seq
      : undefined;
  };
  if (
    sockets.some(({ definition }) => definition.replay) &&
    !(broker.head && broker.history)
  )
    throw new Error("Brick: the socket broker does not support replay");
  for (const { definition } of sockets) definition.brokers.add(broker);
  app.onStop(async () => {
    for (const { definition } of sockets) definition.brokers.delete(broker);
    await broker.close?.();
  });
  if (!sockets.length) return;
  app.use(
    websocket({
      maxPayloadLength: SOCKET_MAX_BYTES,
      backpressureLimit: SOCKET_BUFFER_BYTES,
      closeOnBackpressureLimit: true,
    }),
  );
  for (const { service, path, definition } of sockets) {
    const logger = createLogger(
      `[Brick socket ${service}.${definition.schema.name}]`,
    );
    const sessions = new WeakMap<Request, SocketSession>();
    type Peer = {
      request: Request;
      send(data: string): number;
      close(code?: number, reason?: string): void;
      subscribe(topic: string): void;
      unsubscribe(topic: string): void;
      isSubscribed(topic: string): boolean;
      readonly readyState: number;
    };
    type Connection = {
      ws: Peer;
      session: SocketSession;
      sender: SocketSender;
      tail: Promise<void>;
      pending: number;
      bytes: number;
      closed: boolean;
      /** Every room topic the connection is in. */
      rooms: Set<string>;
      /** The topics the client joined, which it may leave. */
      requested: Set<string>;
    };
    const connections = new WeakMap<Request, Connection>();
    const roomOf = (topic: string) =>
      topic.slice(definition.topicPrefix.length);
    const holders = new Map<
      string,
      { connections: Set<Connection>; unsubscribe: () => void }
    >();
    const control = (ws: Peer, event: string, data: unknown) => {
      if (ws.readyState === 1) ws.send(encodeFrame(event, data));
    };
    /** Joins a room; resolves once the broker delivers its messages here. `live: false` holds the room without receiving yet. */
    const enter = async (
      connection: Connection,
      topic: string,
      live = true,
    ) => {
      if (connection.rooms.has(topic)) return;
      connection.rooms.add(topic);
      if (live) connection.ws.subscribe(topic);
      let holder = holders.get(topic);
      if (!holder) {
        holder = {
          connections: new Set(),
          unsubscribe: () => {},
        };
        holders.set(topic, holder);
        holder.unsubscribe = broker.subscribe(topic, deliver);
      }
      holder.connections.add(connection);
      await broker.ready?.(topic).catch(() => {});
    };
    const exit = (connection: Connection, topic: string) => {
      if (!connection.rooms.delete(topic)) return;
      connection.requested.delete(topic);
      if (connection.ws.readyState === 1) connection.ws.unsubscribe(topic);
      const holder = holders.get(topic);
      if (!holder?.connections.delete(connection) || holder.connections.size)
        return;
      holders.delete(topic);
      holder.unsubscribe();
    };
    const frameOf = (message: SocketBrokerMessage & { type: "emit" }) =>
      message.seq === undefined
        ? message.frame
        : replayFrame(
            message.frame,
            roomOf(message.topic),
            sign(message.topic, message.seq),
          );
    const deliver = (message: SocketBrokerMessage) => {
      if (message.type === "emit") {
        app.server?.publish(message.topic, frameOf(message));
        return;
      }
      for (const connection of holders.get(message.topic)?.connections ?? []) {
        if (message.also && !connection.ws.isSubscribed(message.also)) continue;
        exit(connection, message.topic);
        control(connection.ws, SOCKET_CONTROL.left, {
          room: roomOf(message.topic),
          ...(message.reason !== undefined ? { reason: message.reason } : {}),
        });
      }
    };
    /** `$join` and `$leave`, acknowledged with the same event. */
    const room = async (
      connection: Connection,
      event: string,
      data: unknown,
    ) => {
      const fields = (data && typeof data === "object" ? data : {}) as Record<
        string,
        unknown
      >;
      const { room: name, since } = fields;
      if (!isSocketRoom(name) || (since !== undefined && !isSocketSeq(since)))
        throw new SocketDenied();
      const topic = definition.topic(name);
      if (event === SOCKET_CONTROL.leave) {
        if (connection.requested.has(topic)) exit(connection, topic);
        control(connection.ws, SOCKET_CONTROL.leave, { room: name });
        return;
      }
      const isOpen = () => !connection.closed && connection.ws.readyState === 1;
      const ok =
        connection.rooms.has(topic) ||
        (connection.rooms.size < definition.maxRooms &&
          (await connection.session.join(name)));
      if (!isOpen()) return;
      const replay = definition.replay;
      let seq: string | undefined;
      if (ok && !connection.rooms.has(topic)) {
        const entered = enter(connection, topic, !replay);
        connection.requested.add(topic);
        await entered;
        if (replay && connection.rooms.has(topic)) {
          // Held in this process before reading history, so later emits are either in it or arrive live.
          // A since not signed for this room gets no history, only $gap.
          const start =
            since === undefined
              ? await broker.head!(topic)
              : verify(topic, since);
          const missed =
            start === undefined
              ? undefined
              : await broker.history!(topic, start, replay);
          const restart = missed ? undefined : await broker.head!(topic);
          if (!isOpen()) return;
          if (connection.rooms.has(topic)) {
            connection.ws.subscribe(topic);
            if (since === undefined) seq = sign(topic, start!);
            for (const message of missed ?? [])
              if (message.type === "emit") connection.ws.send(frameOf(message));
            if (restart !== undefined)
              control(connection.ws, SOCKET_CONTROL.gap, {
                room: name,
                seq: sign(topic, restart),
              });
          }
        }
      }
      // A kick while joining wins.
      control(connection.ws, SOCKET_CONTROL.join, {
        room: name,
        ok: ok && connection.rooms.has(topic),
        ...(seq !== undefined ? { seq } : {}),
      });
    };
    // The codes a handler can raise with `error.CODE()`: declared plus standard.
    const raisable = { ...STANDARD_ERRORS, ...definition.errors };
    const fail = (ws: Peer, error: unknown) => {
      if (!(error instanceof SocketDenied))
        logger.error({ error, service, socket: definition.schema.name });
      if (ws.readyState !== 1) return;
      ws.close(
        error instanceof SocketDenied
          ? SOCKET_CLOSE.policy
          : SOCKET_CLOSE.serverError,
        error instanceof SocketDenied
          ? "Message refused"
          : "Socket handler failed",
      );
    };
    app.ws(path, {
      async beforeHandle({ request }) {
        if (sessions.has(request)) return;
        const { token, request: resolved } = tokenRequest(request);
        const origin = request.headers.get("origin");
        if (
          origin
            ? !(definition.allowedOrigins ?? [publicOrigin(request)]).includes(
                origin,
              )
            : // Without cookies a missing Origin is no hijacking risk.
              !(definition.allowMissingOrigin ?? token)
        )
          return new Response("Socket origin refused", { status: 403 });
        try {
          sessions.set(request, await definition.connect(resolved));
        } catch (error) {
          if (!(error instanceof SocketDenied))
            logger.error({ error, service, socket: definition.schema.name });
          return new Response("Socket connection refused", {
            status: error instanceof SocketDenied ? 403 : 500,
          });
        }
      },
      upgrade: ({ request }: { request: Request }) =>
        protocols(request).includes(SOCKET_PROTOCOL)
          ? { "Sec-WebSocket-Protocol": SOCKET_PROTOCOL }
          : undefined,
      async open(ws) {
        const session = sessions.get(ws.request);
        if (!session) {
          ws.close(SOCKET_CLOSE.serverError, "Missing socket session");
          return;
        }
        const sender: SocketSender = {
          get isOpen() {
            return !state.closed && ws.readyState === 1;
          },
          close() {
            ws.close(SOCKET_CLOSE.normal, "");
          },
          send(event, data) {
            if (!sender.isOpen) throw new Error("Socket is closed");
            const result = ws.send(outputFrame(definition.output, event, data));
            if (result === 0) {
              ws.close(SOCKET_CLOSE.tryAgainLater, "Socket buffer full");
              throw new Error("Socket buffer full");
            }
          },
        };
        const state: Connection = {
          ws,
          session,
          sender,
          tail: Promise.resolve(),
          pending: 0,
          bytes: 0,
          closed: false,
          rooms: new Set(),
          requested: new Set(),
        };
        connections.set(ws.request, state);
        try {
          await Promise.all(
            session.rooms.map((room) => enter(state, definition.topic(room))),
          );
          await session.open(sender);
        } catch (error) {
          fail(ws, error);
        }
      },
      message(ws, value: unknown) {
        const state = connections.get(ws.request);
        if (!state || state.closed || ws.readyState !== 1) return;
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
          ws.close(SOCKET_CLOSE.unsupportedData, "Only JSON text is supported");
          return;
        }
        if (typeof value === "string") {
          ws.close(SOCKET_CLOSE.invalidPayload, "Expected JSON envelope");
          return;
        }
        if (!isSocketEnvelope(value)) {
          ws.close(SOCKET_CLOSE.policy, "Invalid socket envelope");
          return;
        }
        const size = byteLength(JSON.stringify(value));
        if (size > SOCKET_MAX_BYTES) {
          ws.close(SOCKET_CLOSE.tooLarge, "Message too large");
          return;
        }
        if (
          state.pending >= SOCKET_BUFFER_MESSAGES ||
          state.bytes + size > SOCKET_BUFFER_BYTES
        ) {
          ws.close(SOCKET_CLOSE.tryAgainLater, "Socket queue full");
          return;
        }
        state.pending++;
        state.bytes += size;
        state.tail = state.tail
          .then(async () => {
            if (state.closed || ws.readyState !== 1) return;
            if (
              value.event === SOCKET_CONTROL.join ||
              value.event === SOCKET_CONTROL.leave
            )
              await room(state, value.event, value.data);
            else
              await state.session.message(
                value.event,
                value.data,
                state.sender,
              );
          })
          .catch((error: unknown) => {
            // A declared error answers a handler message; the connection stays
            // open. A failed $join or $leave, or an error with an undeclared
            // code (from a nested action, say), is logged and closes it, which
            // also rejects the client's pending joins.
            if (
              error instanceof ActionExecutionError &&
              !state.closed &&
              value.event !== SOCKET_CONTROL.join &&
              value.event !== SOCKET_CONTROL.leave &&
              Object.hasOwn(raisable, error.code)
            )
              try {
                const frame = encodeFrame(SOCKET_CONTROL.error, {
                  event: value.event,
                  ...error.toJSON(),
                });
                if (byteLength(frame) > SOCKET_MAX_BYTES)
                  throw new Error("Socket error too large", { cause: error });
                if (ws.readyState === 1) ws.send(frame);
                return;
              } catch (unsent) {
                return fail(ws, unsent);
              }
            fail(ws, error);
          })
          .finally(() => {
            state.pending--;
            state.bytes -= size;
          });
        // Brick owns the queue. Returning the tail here makes native close wait on application work.
      },
      async close(ws, code = 1006, reason = "") {
        const state = connections.get(ws.request);
        sessions.delete(ws.request);
        if (!state || state.closed) return;
        state.closed = true;
        for (const topic of state.rooms) exit(state, topic);
        try {
          await state.session.close(state.sender, code, reason);
        } catch (error) {
          logger.error({
            error,
            service,
            socket: definition.schema.name,
            phase: "cleanup",
          });
        }
        connections.delete(ws.request);
      },
    });
  }
}
