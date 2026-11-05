import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it } from "vitest";
import { keys } from "../src/keys.js";
import { createStreamer } from "../src/streamer.js";
import { describeRedis, redisUrl, subscribed } from "./helpers.js";

// A live reader is fed by pub/sub after its initial XRANGE. Pub/sub is
// fire-and-forget, so a chunk (or the eof marker) published while the
// subscriber connection is down -- a reconnect, or Redis dropping a slow
// subscriber at `client-output-buffer-limit pubsub` (chunks ride inline in the
// message) -- must still reach the reader from the stream itself.

const name = `review-${randomUUID()}`;
let reader: Redis;
let writer: Redis;
let admin: Redis;

beforeAll(() => {
  reader = new Redis(redisUrl, { connectionName: name });
  writer = new Redis(redisUrl);
  admin = new Redis(redisUrl);
});
afterAll(async () => {
  await Promise.all([reader.quit(), writer.quit(), admin.quit()]);
});

async function readLive(redis: Redis, kill: boolean) {
  const keyPrefix = `review:${randomUUID()}:`;
  const readSide = createStreamer({ redis, keyPrefix });
  const writeSide = createStreamer({ redis: writer, keyPrefix });
  const runId = `wrun_${randomUUID()}`;
  const stream = await readSide.streams.get(runId, "out");
  const chunks: string[] = [];
  let done = false;
  const pump = (async () => {
    const r = stream.getReader();
    for (;;) {
      const { value, done: d } = await r.read();
      if (d) break;
      chunks.push(Buffer.from(value).toString());
    }
    done = true;
  })();
  await subscribed(admin, keyPrefix, 2);
  if (kill) {
    // Drop only OUR subscriber connection (the duplicate inherits connectionName).
    const list = (await admin.client("LIST")) as string;
    const ids = list
      .split("\n")
      .filter((l) => l.includes(`name=${name}`) && /flags=\S*P/.test(l))
      .map((l) => /id=(\d+)/.exec(l)![1]);
    expect(ids.length).toBe(1);
    await admin.client("KILL", "ID", ids[0]);
  }
  await writeSide.streams.write(runId, "out", "hello");
  await writeSide.streams.close(runId, "out");
  await Promise.race([pump, new Promise((r) => setTimeout(r, 1500))]);
  await stream.cancel().catch(() => {});
  await Promise.all([readSide.close(), writeSide.close()]);
  return { chunks, done };
}

describeRedis("streamer live delivery", () => {
  it("control: a live reader gets the chunk and eof when nothing is lost", async () => {
    const control = new Redis(redisUrl);
    expect(await readLive(control, false)).toEqual({
      chunks: ["hello"],
      done: true,
    });
    await control.quit();
  });

  it("delivers chunks written while the subscriber reconnects", async () => {
    expect(await readLive(reader, true)).toEqual({
      chunks: ["hello"],
      done: true,
    });
  });
});

describeRedis("stream recovery: a notification lost in the middle", () => {
  it("delivers the lost chunk before the one that did arrive", async () => {
    const keyPrefix = `review:${randomUUID()}:`;
    const reading = createStreamer({ redis: new Redis(redisUrl), keyPrefix });
    const writing = createStreamer({ redis: writer, keyPrefix });
    const runId = `wrun_${randomUUID()}`;

    const stream = await reading.streams.get(runId, "out");
    const received: string[] = [];
    const pump = (async () => {
      const r = stream.getReader();
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        received.push(Buffer.from(value).toString());
      }
    })();

    await writing.streams.write(runId, "out", "one");
    // 'two' reaches the stream but never the subscribers: a lost notification.
    await admin.xadd(
      keys(keyPrefix).streamKey(runId, "out"),
      "*",
      "data",
      Buffer.from("two").toString("base64"),
      "eof",
      "false",
    );
    // 'three' is published normally, and names 'two' as its predecessor.
    await writing.streams.write(runId, "out", "three");
    await writing.streams.close(runId, "out");

    await Promise.race([pump, new Promise((r) => setTimeout(r, 1500))]);
    await stream.cancel().catch(() => {});
    await Promise.all([reading.close(), writing.close()]);
    expect(received).toEqual(["one", "two", "three"]);
  });
});
