import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, expect, it } from "vitest";
import { keys } from "../src/keys.js";
import { createStreamer } from "../src/streamer.js";
import { describeRedis, pauseAfter, redisUrl, subscribed } from "./helpers.js";

// The gap check (prevId) covers notifications buffered while the initial
// XRANGE is in flight too: a chunk whose own notification was lost in that
// window (a subscriber reconnect: the resync catch-up is a no-op while `buffer`
// is set) is still delivered, so lastEntryId never moves past it.

let writer: Redis;
let admin: Redis;
beforeAll(() => {
  writer = new Redis(redisUrl);
  admin = new Redis(redisUrl);
});
afterAll(async () => {
  await Promise.all([writer.quit(), admin.quit()]);
});

describeRedis("streamer initial read vs a lost notification", () => {
  it("delivers a chunk whose notification was lost while the history read was in flight", async () => {
    const keyPrefix = `review2:${randomUUID()}:`;
    const readerRedis = new Redis(redisUrl);
    const reading = createStreamer({ redis: readerRedis, keyPrefix });
    const writing = createStreamer({ redis: writer, keyPrefix });
    const runId = `wrun_${randomUUID()}`;
    const key = keys(keyPrefix).streamKey(runId, "out");

    await writing.streams.write(runId, "out", "one");
    await subscribed(admin, keyPrefix, 2);

    // Hold the reader's history XRANGE reply (taken now: ['one']) until we say so.
    const history = pauseAfter(readerRedis, "xrange");

    const streamP = reading.streams.get(runId, "out");
    await history.reached;

    // 'two' reaches the stream, its notification is lost.
    await admin.xadd(
      key,
      "*",
      "data",
      Buffer.from("two").toString("base64"),
      "eof",
      "false",
    );
    // 'three' is published normally (prevId = 'two') and lands in the reader's buffer.
    await writing.streams.write(runId, "out", "three");
    // Nothing to wait on: give the notification time to reach the reader's buffer.
    await new Promise((r) => setTimeout(r, 100));
    history.release();

    const stream = await streamP;
    const received: string[] = [];
    const pump = (async () => {
      const r = stream.getReader();
      for (;;) {
        const { value, done } = await r.read();
        if (done) break;
        received.push(Buffer.from(value).toString());
      }
    })();
    await writing.streams.close(runId, "out");
    // Longer than one CATCH_UP_INTERVAL_MS, so the timer had its chance too.
    await Promise.race([pump, new Promise((r) => setTimeout(r, 3000))]);
    await stream.cancel().catch(() => {});
    await Promise.all([reading.close(), writing.close()]);
    await readerRedis.quit();

    expect(received).toEqual(["one", "two", "three"]);
  });
});
