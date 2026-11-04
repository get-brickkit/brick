import { resolve } from "node:path";
import { brick, defineService, t } from "@brickkit/core";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { anonymous } from "better-auth/plugins/anonymous";
import {
  authSchema,
  createChatStore,
  chatMessage,
  type ChatMessage,
} from "./store";

const output = {
  connected: t.Object({ id: t.String(), name: t.String() }),
  presence: t.Object({ count: t.Integer({ minimum: 0 }) }),
  history: t.Object({ messages: t.Array(chatMessage), done: t.Boolean() }),
  message: chatMessage,
};
const allowedOrigins = ["http://localhost:5178"];
const ROOM = "chat:lobby";

export function createChatApp(
  path = process.env.BRICK_CHAT_DB ?? resolve(".brick/chat.sqlite"),
) {
  const store = createChatStore(path);
  const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_URL ?? allowedOrigins[0],
    secret: process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(store.db, {
      provider: "sqlite",
      schema: authSchema,
    }),
    plugins: [
      anonymous({
        generateName: () => `Guest ${crypto.randomUUID().slice(0, 4)}`,
      }),
    ],
    trustedOrigins: allowedOrigins,
  });
  // Connections to this process. Every connection is in the one shared room.
  let online = 0;
  const chat = defineService("chat", {
    database: store.database,
    context: async ({ request }) => {
      const session = await auth.api.getSession({ headers: request.headers });
      return {
        user: session ? { id: session.user.id, name: session.user.name } : null,
      };
    },
  });
  const live = chat.socket({
    name: "live",
    description:
      "Persistent shared conversation with anonymous Better Auth identities",
    input: {
      say: t.Object({
        text: t.String({ minLength: 1, maxLength: 2000, pattern: "\\S" }),
      }),
    },
    output,
    allowedOrigins,
    authorize: ({ ctx }) => ctx.user != null,
    rooms: () => [ROOM],
    open: ({ ctx, socket }) => {
      if (!ctx.user) return;
      socket.send("connected", ctx.user);
      // Chunk stored history so every frame fits the socket payload limit.
      let batch: ChatMessage[] = [];
      for (const message of store.history()) {
        const next = [...batch, message];
        if (
          batch.length &&
          new TextEncoder().encode(JSON.stringify(next)).byteLength > 32 * 1024
        ) {
          socket.send("history", { messages: batch, done: false });
          batch = [];
        }
        batch.push(message);
      }
      socket.send("history", { messages: batch, done: true });
      live.emit(ROOM, "presence", { count: ++online });
    },
    close: () => {
      live.emit(ROOM, "presence", { count: --online });
    },
    handlers: {
      say: ({ input, ctx }) => {
        if (!ctx.user) return;
        const message = store.save(ctx.user.id, input.text);
        live.emit(ROOM, "message", message);
      },
    },
  });
  const app = brick({
    services: [chat],
    telemetry: true,
  });
  app.all("/api/auth/*", ({ request }: { request: Request }) =>
    auth.handler(request),
  );
  app.onStop(() => store.close());
  return app;
}
