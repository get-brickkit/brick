import { expect } from "bun:test";
import { brick, defineService, t, type SocketBroker } from "../src";
import { createBrickClient, type BrickClientSocket } from "../src/client";
import { serializeSocketSchema } from "../src/socket-schema";
import { waitFor } from "./helpers";

/** The browser contract of the `chat.live` socket, mounted at `path`. */
export function chatContract<TInput>(path: string): {
  chat: { live: BrickClientSocket<TInput, { message: string }> };
} {
  return {
    chat: {
      live: {
        kind: "socket",
        name: "live",
        serviceName: "chat",
        config: { path },
        output: { message: serializeSocketSchema(t.String()) },
      },
    },
  };
}

/**
 * Shared by the in-process and Redis broker tests. `track` stops the app
 * afterwards. Redis trims with `MAXLEN ~`, which keeps short streams whole.
 */
export async function replayScenario(
  track: (app: ReturnType<typeof brick>) => void,
  broker?: SocketBroker,
  exactTrim = !broker,
) {
  const service = defineService("chat");
  const live = service.socket({
    name: "live",
    input: { crash: t.Null() },
    output: { message: t.String() },
    allowMissingOrigin: true,
    replay: { keep: 3, maxAgeMs: 60_000 },
    rooms: () => ["user:me"],
    join: () => true,
    handlers: {
      crash() {
        throw new Error("crash");
      },
    },
  });
  const app = brick({
    services: [service],
    docs: false,
    requestLogging: false,
    ...(broker ? { sockets: { broker } } : {}),
  }).listen(0);
  track(app);
  const socket = createBrickClient({
    baseUrl: `http://localhost:${app.server!.port}`,
    contract: chatContract<{ crash: null }>("/api/chat/live"),
  }).chat.live.connect({ reconnect: { minDelayMs: 5, maxDelayMs: 20 } });
  const received: string[] = [];
  const gaps: string[] = [];
  socket.on("message", (text) => received.push(text));
  socket.onGap((room) => gaps.push(room));
  try {
    const id = crypto.randomUUID();
    const [one, two] = [`doc:${id}-1`, `doc:${id}-2`];
    await socket.ready;
    await socket.join(one);
    await socket.join(two);
    live.emit(one, "message", "a1");
    live.emit(two, "message", "b1");
    live.emit("user:me", "message", "u1");
    await waitFor(() => received.length === 3);
    socket.onStatus((status) => {
      if (status !== "reconnecting") return;
      // Missed while away: the first room fits in the kept history; the second overflows it when the broker trims exactly.
      live.emit(one, "message", "a2");
      live.emit(one, "message", "a3");
      for (const n of [2, 3, 4, 5]) live.emit(two, "message", `b${n}`);
    });
    const reconnected = new Promise<void>((resolve) =>
      socket.onReconnect(resolve),
    );
    socket.send("crash", null);
    await reconnected;
    const missed = exactTrim
      ? ["a2", "a3"]
      : ["a2", "a3", "b2", "b3", "b4", "b5"];
    const gapped = exactTrim ? [two, "user:me"].toSorted() : ["user:me"];
    await waitFor(
      () =>
        received.length === 3 + missed.length && gaps.length === gapped.length,
    );
    live.emit(two, "message", "b6");
    live.emit(one, "message", "a4");
    await waitFor(() => received.length === 5 + missed.length);
    // Nothing else may arrive: give a stray replay time to show up.
    await Bun.sleep(50);
    expect(received).toEqual(["a1", "b1", "u1", ...missed, "b6", "a4"]);
    expect(gaps.toSorted()).toEqual(gapped);
  } finally {
    socket.close();
  }
}
