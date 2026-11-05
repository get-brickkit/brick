import { Check } from "@sinclair/typebox/value";
import { restoreSocketSchema } from "./socket-schema";
import {
  byteLength,
  compareSocketSeq,
  decodeFrame,
  encodeFrame,
  isControlEvent,
  isSocketEnvelope,
  isSocketRoom,
  isSocketSeq,
  SOCKET_BUFFER_BYTES,
  SOCKET_CLOSE,
  SOCKET_CONTROL,
  SOCKET_MAX_BYTES,
  SOCKET_PROTOCOL,
  SOCKET_STOP_CODES,
  SOCKET_TOKEN_PROTOCOL,
} from "./protocol";
import {
  BrickSocketError,
  type BrickClientSocket,
  type BrickSocketClient,
  type BrickSocketConnectOptions,
  type BrickSocketHandlerError,
  type BrickSocketStatus,
} from "./socket-types";
import { ActionExecutionError } from "./types";

/** RFC 6455 subprotocols are RFC 7230 tokens. */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function connectSocket(
  baseUrl: string,
  contract: BrickClientSocket,
  options: BrickSocketConnectOptions,
): BrickSocketClient<Record<string, unknown>, Record<string, unknown>> {
  const url = new URL(`${baseUrl}${contract.config.path}`);
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol))
    throw new Error("Invalid socket URL protocol");
  url.protocol =
    url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  if (url.search || url.hash)
    throw new Error("Socket base URL must not contain a query or fragment");
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
  )
    throw new Error("Socket timeoutMs must be a finite nonnegative number");
  const backoff =
    options.reconnect === false
      ? undefined
      : {
          minDelayMs: 500,
          maxDelayMs: 30_000,
          jitter: 0.2,
          ...options.reconnect,
        };
  if (
    backoff &&
    !(
      backoff.minDelayMs >= 0 &&
      backoff.maxDelayMs >= backoff.minDelayMs &&
      Number.isFinite(backoff.maxDelayMs) &&
      backoff.jitter >= 0 &&
      backoff.jitter <= 1
    )
  )
    throw new Error(
      "Socket reconnect needs 0 <= minDelayMs <= maxDelayMs and jitter from 0 to 1",
    );
  const schemas = new Map(
    Object.entries(contract.output).map(([name, schema]) => [
      name,
      restoreSocketSchema(schema),
    ]),
  );
  const events = new Map<string, Set<(value: unknown) => void>>();
  const errors = new Set<(error: BrickSocketError) => void>();
  type Untyped = Record<string, unknown>;
  const failures = new Set<
    (error: BrickSocketHandlerError<Untyped, Untyped>) => void
  >();
  const closes = new Set<(info: { code: number; reason: string }) => void>();
  const leaves = new Set<(room: string, reason?: string) => void>();
  const statuses = new Set<(status: BrickSocketStatus) => void>();
  const reconnects = new Set<() => void>();
  const gaps = new Set<(room: string) => void>();
  /** The last sequence seen per room, for sockets with replay. */
  const seqs = new Map<string, string>();
  /** Rooms the server accepted for this client, rejoined after a reconnect. */
  const rooms = new Set<string>();
  const joins = new Map<string, ((result: boolean | Error) => void)[]>();
  const ready = Promise.withResolvers<void>();
  // Consumers can register lifecycle listeners without awaiting ready.
  void ready.promise.catch(() => {});
  let status: BrickSocketStatus = "connecting";
  let opened = false;
  let openedAt = 0;
  let attempts = 0;
  let attempting = false;
  let ws: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const signal = options.signal;
  const page = (
    globalThis as {
      document?: EventTarget & { visibilityState?: string };
    }
  ).document;
  const report = (error: BrickSocketError) => {
    for (const listener of errors) listener(error);
  };
  const setStatus = (next: BrickSocketStatus) => {
    if (status === next) return;
    status = next;
    for (const listener of statuses) listener(next);
  };
  const settleJoins = (error: Error) => {
    for (const settle of [...joins.values()].flat()) settle(error);
    joins.clear();
  };
  const detach = () => {
    clearTimeout(timer);
    if (!ws) return;
    ws.onopen = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onclose = null;
  };
  /** Ends the client for good. */
  const finish = (info: { code: number; reason: string }, error?: unknown) => {
    if (status === "closed") return;
    detach();
    clearTimeout(retry);
    signal?.removeEventListener("abort", abort);
    globalThis.removeEventListener?.("online", wake);
    page?.removeEventListener("visibilitychange", wake);
    if (!opened)
      ready.reject(
        error ??
          new BrickSocketError("connection", "Socket closed before opening"),
      );
    settleJoins(
      new BrickSocketError("connection", "Socket closed before joining"),
    );
    try {
      setStatus("closed");
      for (const listener of closes) listener(info);
    } finally {
      events.clear();
      for (const listeners of [
        errors,
        failures,
        closes,
        leaves,
        statuses,
        reconnects,
        gaps,
      ])
        listeners.clear();
    }
  };
  const stop = (
    error?: unknown,
    code: number = SOCKET_CLOSE.normal,
    reason = "",
  ) => {
    if (status === "closed") return;
    try {
      if (error instanceof BrickSocketError) report(error);
    } finally {
      try {
        ws?.close(code, reason);
      } finally {
        finish({ code, reason }, error);
      }
    }
  };
  /** The connection ended without `close()`: retry unless the code says not to. */
  const dropped = (
    info: { code: number; reason: string },
    error?: BrickSocketError,
  ) => {
    if (status === "closed") return;
    detach();
    ws = undefined;
    if (error) report(error);
    if (!backoff || SOCKET_STOP_CODES.has(info.code))
      return finish(info, error);
    settleJoins(
      new BrickSocketError("connection", "Socket closed before joining"),
    );
    if (openedAt && Date.now() - openedAt >= 10_000) attempts = 0;
    openedAt = 0;
    setStatus("reconnecting");
    for (const listener of closes) listener(info);
    schedule();
  };
  const schedule = () => {
    if (status !== "reconnecting" || attempting || retry !== undefined) return;
    // Offline: wait for the online event instead of spending attempts.
    if (
      (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine ===
      false
    )
      return;
    const delay = Math.min(
      backoff!.maxDelayMs,
      backoff!.minDelayMs * 2 ** attempts++,
    );
    retry = setTimeout(
      () => {
        retry = undefined;
        void attempt();
      },
      delay * (1 + backoff!.jitter * (Math.random() * 2 - 1)),
    );
  };
  function wake() {
    if (
      status !== "reconnecting" ||
      attempting ||
      ws ||
      page?.visibilityState === "hidden"
    )
      return;
    clearTimeout(retry);
    retry = undefined;
    void attempt();
  }
  const attempt = async () => {
    attempting = true;
    let protocols: string[] | undefined;
    try {
      if (options.token) {
        let token: string;
        try {
          token = await options.token();
        } catch (cause) {
          attempting = false;
          return dropped(
            { code: SOCKET_CLOSE.abnormal, reason: "" },
            new BrickSocketError("connection", "Socket token failed", {
              cause,
            }),
          );
        }
        if (status === "closed") return;
        if (typeof token !== "string" || !TOKEN.test(token))
          return stop(
            new BrickSocketError(
              "protocol",
              "Socket token must use RFC 6455 token characters, such as a JWT or base64url without = padding",
            ),
          );
        protocols = [SOCKET_PROTOCOL, SOCKET_TOKEN_PROTOCOL + token];
      }
      try {
        ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
      } catch (cause) {
        attempting = false;
        return dropped(
          { code: SOCKET_CLOSE.abnormal, reason: "" },
          new BrickSocketError("connection", "Socket connection failed", {
            cause,
          }),
        );
      }
    } finally {
      attempting = false;
    }
    const failed = (message: string) => {
      const socket = ws;
      dropped(
        { code: SOCKET_CLOSE.abnormal, reason: "" },
        new BrickSocketError("connection", message),
      );
      socket?.close();
    };
    ws.onopen = () => {
      clearTimeout(timer);
      openedAt = Date.now();
      setStatus("open");
      if (!opened) {
        opened = true;
        ready.resolve();
        return;
      }
      for (const room of rooms)
        void request(room, seqs.get(room)).catch(() => {});
      // Server rooms come back with the connection, without what was missed.
      for (const room of seqs.keys())
        if (!rooms.has(room)) {
          seqs.delete(room);
          notifyGap(room);
        }
      for (const listener of reconnects) listener();
    };
    ws.onerror = () => failed("Socket connection failed");
    ws.onclose = ({ code, reason }) => dropped({ code, reason });
    ws.onmessage = receive;
    if (options.timeoutMs !== undefined)
      timer = setTimeout(
        () => failed("Socket connection timed out"),
        options.timeoutMs,
      );
  };
  const assertOpen = () => {
    if (!ws || status !== "open" || ws.readyState !== 1)
      throw new BrickSocketError("connection", "Socket is not open");
    return ws;
  };
  const write = (event: string, data: unknown) =>
    assertOpen().send(encodeFrame(event, data));
  const request = (room: string, since?: string) =>
    new Promise<void>((resolve, reject) => {
      write(
        SOCKET_CONTROL.join,
        since === undefined ? { room } : { room, since },
      );
      joins.set(room, [
        ...(joins.get(room) ?? []),
        (result) =>
          result === true
            ? resolve()
            : reject(
                result ||
                  new BrickSocketError("refused", `Join refused: ${room}`),
              ),
      ]);
    });
  const notifyLeave = (room: string, reason?: string) => {
    seqs.delete(room);
    for (const listener of leaves) listener(room, reason);
  };
  const notifyGap = (room: string) => {
    for (const listener of gaps) listener(room);
  };
  /** Checks a room acknowledgement or removal; returns the work to run once it passed. */
  const control = (event: string, data: unknown): (() => void) => {
    const fields = (data ?? {}) as Record<string, unknown>;
    if (event === SOCKET_CONTROL.error) {
      const { event: input, code, message, status, details } = fields;
      if (
        typeof input !== "string" ||
        typeof code !== "string" ||
        typeof message !== "string" ||
        typeof status !== "number"
      )
        throw new Error("Invalid control message");
      return () => {
        const failure = Object.assign(
          new ActionExecutionError(code, message, status, details),
          { event: input },
        );
        for (const listener of failures) listener(failure);
      };
    }
    const { room, seq } = fields;
    if (!isSocketRoom(room) || (seq !== undefined && !isSocketSeq(seq)))
      throw new Error("Invalid control message");
    if (event === SOCKET_CONTROL.join && typeof fields.ok === "boolean") {
      const ok = fields.ok;
      return () => {
        const pending = joins.get(room);
        if (!pending) return;
        joins.delete(room);
        if (ok) rooms.add(room);
        else if (rooms.delete(room)) notifyLeave(room, "join refused");
        if (ok && seq !== undefined && !seqs.has(room)) seqs.set(room, seq);
        for (const settle of pending) settle(ok);
      };
    }
    if (event === SOCKET_CONTROL.left) {
      const reason =
        typeof fields.reason === "string" ? fields.reason : undefined;
      return () => {
        rooms.delete(room);
        notifyLeave(room, reason);
      };
    }
    if (event === SOCKET_CONTROL.gap && seq !== undefined)
      return () => {
        seqs.set(room, seq);
        notifyGap(room);
      };
    if (event === SOCKET_CONTROL.leave) return () => {};
    throw new Error("Unknown control message");
  };
  const receive = ({ data }: MessageEvent<unknown>) => {
    let message: ReturnType<typeof decodeFrame>;
    let action: (() => void) | undefined;
    try {
      message = decodeFrame(data);
      if (isControlEvent(message.event)) {
        if (message.seq !== undefined)
          throw new Error("Invalid control message");
        action = control(message.event, message.data);
      } else {
        const schema = schemas.get(message.event);
        if (!schema || !Check(schema, message.data))
          throw new Error("Invalid socket output");
      }
    } catch (cause) {
      stop(
        new BrickSocketError(
          "protocol",
          "Server sent an invalid socket message",
          { cause },
        ),
        SOCKET_CLOSE.invalidServerMessage,
        "Invalid server message",
      );
      return;
    }
    if (action) return action();
    const { room, seq } = message;
    if (room !== undefined && seq !== undefined) {
      const last = seqs.get(room);
      // A replayed emit can also arrive live; deliver it once.
      if (last !== undefined && compareSocketSeq(seq, last) <= 0) return;
      seqs.set(room, seq);
    }
    for (const listener of events.get(message.event) ?? [])
      listener(message.data);
  };
  function abort() {
    stop(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  }
  const listen = <T>(listeners: Set<T>, listener: T) => {
    if (status !== "closed") listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const api: BrickSocketClient<Untyped, Untyped, Untyped> = {
    ready: ready.promise,
    get status() {
      return status;
    },
    join(room) {
      if (!isSocketRoom(room))
        return Promise.reject(
          new BrickSocketError("protocol", `Invalid room: ${String(room)}`),
        );
      return request(room);
    },
    leave(room) {
      rooms.delete(room);
      seqs.delete(room);
      for (const settle of joins.get(room) ?? [])
        settle(new BrickSocketError("refused", `Left before joining: ${room}`));
      joins.delete(room);
      if (isSocketRoom(room) && status === "open" && ws?.readyState === 1)
        write(SOCKET_CONTROL.leave, { room });
    },
    send(event, data) {
      const ws = assertOpen();
      if (isControlEvent(event))
        throw new BrickSocketError("protocol", "Reserved socket event");
      const frame = encodeFrame(event, data);
      const bytes = byteLength(frame);
      if (!isSocketEnvelope(JSON.parse(frame)) || bytes > SOCKET_MAX_BYTES)
        throw new BrickSocketError(
          "protocol",
          `Message must be a JSON payload under ${SOCKET_MAX_BYTES / 1024} KiB`,
        );
      if (ws.bufferedAmount + bytes > SOCKET_BUFFER_BYTES) {
        const error = new BrickSocketError(
          "backpressure",
          "Socket buffer full",
        );
        stop(error, SOCKET_CLOSE.clientBufferFull, "Socket buffer full");
        throw error;
      }
      ws.send(frame);
    },
    close() {
      stop();
    },
    on(event, listener) {
      if (status === "closed") return () => {};
      const listeners = events.get(event) ?? new Set();
      listeners.add(listener);
      events.set(event, listeners);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) events.delete(event);
      };
    },
    onLeave: (listener) => listen(leaves, listener),
    onGap: (listener) => listen(gaps, listener),
    onStatus: (listener) => listen(statuses, listener),
    onReconnect: (listener) => listen(reconnects, listener),
    onError: (listener) => listen(errors, listener),
    onHandlerError: (listener) => listen(failures, listener),
    onClose: (listener) => listen(closes, listener),
  };
  if (signal?.aborted) {
    queueMicrotask(abort);
    return api;
  }
  signal?.addEventListener("abort", abort, { once: true });
  if (backoff) {
    globalThis.addEventListener?.("online", wake);
    page?.addEventListener("visibilitychange", wake);
  }
  void attempt();
  return api;
}
