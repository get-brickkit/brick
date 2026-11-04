import { defineService, t } from "../src";
import { createBrickClient, type BrickClientSocket } from "../src/client";

const service = defineService("chat", {
  context: () => ({ user: { id: "user" } }),
});
const handle = service.socket({
  name: "live",
  input: { say: t.String(), count: t.Number() },
  output: { message: t.Object({ text: t.String() }) },
  handlers: {
    say({ input, ctx, socket }) {
      const text: string = input;
      const id: string = ctx.user.id;
      socket.send("message", { text: text + id });
      // @ts-expect-error Output payloads are checked.
      socket.send("message", { text: 42 });
      // @ts-expect-error Direction is checked.
      socket.send("say", "hello");
    },
    count({ input }) {
      const number: number = input;
      void number;
    },
  },
});
handle.emit("doc:1", "message", { text: "hi" });
handle.emit(["user:1", "team:2"], "message", { text: "hi" }, { after: {} });
handle.kick("doc:1", { also: "user:1", reason: "removed" });
// @ts-expect-error Emit payloads are checked.
handle.emit("doc:1", "message", { text: 42 });
// @ts-expect-error Only output events can be emitted.
handle.emit("doc:1", "say", "hello");
service.socket({
  name: "missing",
  input: { say: t.String() },
  output: {},
  // @ts-expect-error Every input event requires a handler.
  handlers: {},
});

declare const contract: {
  chat: {
    live: BrickClientSocket<
      { say: string; count: number },
      { message: { text: string } }
    >;
  };
};
const live = createBrickClient({
  baseUrl: "https://example.test",
  contract,
}).chat.live.connect();
live.send("say", "hello");
live.send("count", 42);
live.on("message", (payload) => {
  const text: string = payload.text;
  void text;
});
// @ts-expect-error Unknown event.
live.send("unknown", "hello");
// @ts-expect-error Wrong payload.
live.send("say", 42);
// @ts-expect-error Reversed direction.
live.on("say", () => {});
declare const union: "say" | "count";
// @ts-expect-error An uncorrelated union event/payload must not compile.
live.send(union, "hello");
void live.join("doc:1").then(() => live.leave("doc:1"));
live.onLeave((room: string, reason?: string) => void [room, reason]);
const mobile = createBrickClient({
  baseUrl: "https://example.test",
  contract,
}).chat.live.connect({
  token: async () => "jwt",
  reconnect: { minDelayMs: 100 },
});
const status: "connecting" | "open" | "reconnecting" | "closed" = mobile.status;
void status;
mobile.onStatus((next) => void next);
mobile.onReconnect(() => {});
createBrickClient({
  baseUrl: "https://example.test",
  contract,
}).chat.live.connect({ reconnect: false });
mobile.onGap((room: string) => void room);
service.socket({
  name: "typedErrors",
  input: { say: t.String() },
  output: {},
  errors: {
    TOO_LONG: { message: "Too long", details: t.Object({ max: t.Number() }) },
  },
  handlers: {
    say({ error }) {
      error.TOO_LONG(undefined, { max: 280 });
      error.FORBIDDEN();
      // @ts-expect-error details must match the schema
      error.TOO_LONG(undefined, { max: "280" });
    },
  },
});
declare const typedContract: {
  chat: {
    typedErrors: BrickClientSocket<
      { say: string },
      {},
      Record<"TOO_LONG", { message: string; status?: number }>
    >;
  };
};
createBrickClient({ baseUrl: "https://example.test", contract: typedContract })
  .chat.typedErrors.connect()
  .onHandlerError((failure) => {
    const event: "say" = failure.event;
    const details: unknown = failure.details;
    void [event, details];
    if (failure.code === "TOO_LONG" || failure.code === "FORBIDDEN") return;
    // @ts-expect-error not a code this socket can raise
    if (failure.code === "SLUG_EXISTS") return;
  });
service.socket({
  name: "replayed",
  input: {},
  output: {},
  replay: { keep: 100, maxAgeMs: 60_000 },
  handlers: {},
});
