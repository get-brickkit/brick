import { afterAll, beforeEach, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { Database } from "bun:sqlite";
import { resetGlobalRegistry } from "@brickkit/core";
import { createChatApp } from "../src/room";
import type { ChatMessage } from "../src/store";
import { createChatStore } from "../src/store";

beforeEach(resetGlobalRegistry);
// The next test file in the same process may define a service named "chat" too.
afterAll(resetGlobalRegistry);
const origin = "http://localhost:5178";

async function signIn(base: string) {
  const response = await fetch(base + "/api/auth/sign-in/anonymous", {
    method: "POST",
    headers: { origin },
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}
function connect(base: string, headers: Record<string, string>) {
  return new WebSocket(base.replace(/^http/, "ws") + "/api/chat/live", {
    headers,
  });
}
async function join(base: string, cookie: string) {
  const socket = connect(base, { origin, cookie });
  return new Promise<{
    socket: WebSocket;
    id: string;
    name: string;
    history: ChatMessage[];
  }>((resolve, reject) => {
    let id = "";
    let name = "";
    const history: ChatMessage[] = [];
    socket.onerror = reject;
    socket.onclose = ({ code }) =>
      reject(new Error(`Socket closed while joining: ${code}`));
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.event === "connected") {
        id = message.data.id;
        name = message.data.name;
      }
      if (message.event === "history") {
        history.push(...message.data.messages);
        if (message.data.done) resolve({ socket, id, name, history });
      }
    };
  });
}
function nextMessage(socket: WebSocket): Promise<ChatMessage> {
  return new Promise((resolve) => {
    const listener = ({ data }: MessageEvent) => {
      const message = JSON.parse(String(data));
      if (message.event === "message") {
        socket.removeEventListener("message", listener);
        resolve(message.data);
      }
    };
    socket.addEventListener("message", listener);
  });
}
function send(socket: WebSocket, text: string) {
  socket.send(JSON.stringify({ event: "say", data: { text } }));
}

it("broadcasts saved messages and restores the same guest on reconnect", async () => {
  const app = createChatApp(":memory:").listen(0);
  const sockets: WebSocket[] = [];
  try {
    const base = `http://localhost:${app.server!.port}`;
    const cookieA = await signIn(base);
    const first = await join(base, cookieA);
    sockets.push(first.socket);
    const second = await join(base, await signIn(base));
    sockets.push(second.socket);
    expect(first.id).not.toBe(second.id);
    expect(first.name).toMatch(/^Guest /);
    expect(first.history).toEqual([]);
    const local = nextMessage(first.socket),
      remote = nextMessage(second.socket);
    send(first.socket, "From the first browser");
    const [one, two] = await Promise.all([local, remote]);
    expect(one).toEqual(two);
    expect(two).toMatchObject({
      id: 1,
      text: "From the first browser",
      userId: first.id,
      name: first.name,
    });
    second.socket.close();
    const returning = await join(base, cookieA);
    sockets.push(returning.socket);
    expect(returning.id).toBe(first.id);
    expect(returning.name).toBe(first.name);
    expect(returning.history).toEqual([one]);
  } finally {
    for (const socket of sockets) socket.close();
    await app.stop(true);
  }
});

it("keeps messages and guest sessions in SQLite after a server restart", async () => {
  const directory = await mkdtemp(joinPath(tmpdir(), "brick-chat-"));
  const path = joinPath(directory, "chat.sqlite");
  let app = createChatApp(path).listen(0);
  let socket: WebSocket | undefined;
  try {
    const cookie = await signIn(`http://localhost:${app.server!.port}`);
    const first = await join(`http://localhost:${app.server!.port}`, cookie);
    socket = first.socket;
    const received = nextMessage(socket);
    send(socket, "Remember this after restart");
    const saved = await received;
    socket.close();
    await app.stop(true);
    resetGlobalRegistry();
    app = createChatApp(path).listen(0);
    const returning = await join(
      `http://localhost:${app.server!.port}`,
      cookie,
    );
    socket = returning.socket;
    expect(returning.id).toBe(first.id);
    expect(returning.history).toEqual([saved]);
    const disk = new Database(path, { readonly: true });
    try {
      expect(
        disk.query("SELECT user_id, text FROM chat_messages").all(),
      ).toEqual([{ user_id: first.id, text: "Remember this after restart" }]);
    } finally {
      disk.close();
    }
  } finally {
    socket?.close();
    await app.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses sockets without a session or from foreign origins", async () => {
  const app = createChatApp(":memory:").listen(0);
  try {
    const base = `http://localhost:${app.server!.port}`;
    const refused = (socket: WebSocket) =>
      new Promise<boolean>((resolve) => {
        socket.onopen = () => resolve(false);
        socket.onerror = () => resolve(true);
      });
    expect(await refused(connect(base, { origin }))).toBe(true);
    expect(
      await refused(
        connect(base, {
          origin: "https://another.test",
          cookie: await signIn(base),
        }),
      ),
    ).toBe(true);
  } finally {
    await app.stop(true);
  }
});

it("loads the latest 50 stored messages in bounded history frames", async () => {
  const directory = await mkdtemp(joinPath(tmpdir(), "brick-chat-history-"));
  const path = joinPath(directory, "chat.sqlite");
  let app = createChatApp(path).listen(0);
  let socket: WebSocket | undefined;
  try {
    const cookie = await signIn(`http://localhost:${app.server!.port}`);
    const { socket: seed, id } = await join(
      `http://localhost:${app.server!.port}`,
      cookie,
    );
    seed.close();
    await app.stop(true);
    resetGlobalRegistry();
    const store = createChatStore(path);
    for (let i = 0; i < 55; i++) store.save(id, "\u0000".repeat(2000));
    await store.close();
    resetGlobalRegistry();
    app = createChatApp(path).listen(0);
    const client = await join(`http://localhost:${app.server!.port}`, cookie);
    socket = client.socket;
    expect(client.history).toHaveLength(50);
    expect(client.history[0]!.id).toBe(6);
    expect(client.history[49]!.id).toBe(55);
    expect(client.history[49]!.text).toBe("\u0000".repeat(2000));
  } finally {
    socket?.close();
    await app.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
