import { setTimeout as sleep } from "node:timers/promises";
import type { Streamer } from "@workflow/world";
import { Redis } from "ioredis";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { createStreamer } from "../src/streamer.js";
import { describeRedis, redisUrl } from "./helpers.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Read a stream to completion, returning each delivered chunk. */
async function readAll(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const out: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

async function readAllText(
  stream: ReadableStream<Uint8Array>,
): Promise<string[]> {
  return (await readAll(stream)).map((chunk) => decoder.decode(chunk));
}

describeRedis("Streamer (Redis integration)", () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  });

  afterAll(() => {
    redis?.disconnect();
  });

  let prefixCounter = 0;
  let streamers: ReturnType<typeof createStreamer>[] = [];

  // `writeMulti` is optional on the Streamer type but this world always has it.
  type TestStreams = Omit<Streamer["streams"], "writeMulti"> & {
    writeMulti: NonNullable<Streamer["streams"]["writeMulti"]>;
  };

  /** A streamer on its own key prefix, so tests never see each other's keys. */
  function newStreamer(keyPrefix = `t${Date.now()}:${prefixCounter++}:`) {
    const streamer = createStreamer({ redis, keyPrefix });
    streamers.push(streamer);
    const { writeMulti } = streamer.streams;
    if (!writeMulti) throw new Error("streams.writeMulti is not implemented");
    const streams: TestStreams = { ...streamer.streams, writeMulti };
    return { streamer, streams, keyPrefix };
  }

  afterEach(async () => {
    await Promise.all(streamers.map((s) => s.close()));
    streamers = [];
  });

  describe("write and get", () => {
    test("round trips string and Uint8Array chunks", async () => {
      const { streams } = newStreamer();
      const binary = new Uint8Array([0, 1, 2, 253, 254, 255]);

      await streams.write("wrun_a", "out", "hello");
      await streams.write("wrun_a", "out", binary);
      await streams.write("wrun_a", "out", "héllo ✓ 世界");
      await streams.write("wrun_a", "out", Buffer.from("buf"));
      await streams.close("wrun_a", "out");

      const chunks = await readAll(await streams.get("wrun_a", "out"));
      expect(chunks).toHaveLength(4);
      expect(decoder.decode(chunks[0])).toBe("hello");
      expect(Array.from(chunks[1])).toEqual(Array.from(binary));
      expect(chunks[1]).toBeInstanceOf(Uint8Array);
      expect(decoder.decode(chunks[2])).toBe("héllo ✓ 世界");
      expect(decoder.decode(chunks[3])).toBe("buf");
    });

    test("get with startIndex 2 skips the first two chunks", async () => {
      const { streams } = newStreamer();
      for (const c of ["c0", "c1", "c2", "c3", "c4"])
        await streams.write("wrun_a", "out", c);
      await streams.close("wrun_a", "out");

      expect(await readAllText(await streams.get("wrun_a", "out", 2))).toEqual([
        "c2",
        "c3",
        "c4",
      ]);
      expect(await readAllText(await streams.get("wrun_a", "out", 0))).toEqual([
        "c0",
        "c1",
        "c2",
        "c3",
        "c4",
      ]);
    });

    test("get with a negative startIndex counts back from the tail", async () => {
      const { streams } = newStreamer();
      for (const c of ["c0", "c1", "c2", "c3", "c4"])
        await streams.write("wrun_a", "out", c);
      await streams.close("wrun_a", "out");

      // The eof marker is not a data chunk, so -2 is the last two data chunks.
      expect(await readAllText(await streams.get("wrun_a", "out", -2))).toEqual(
        ["c3", "c4"],
      );
      expect(await readAllText(await streams.get("wrun_a", "out", -1))).toEqual(
        ["c4"],
      );
      expect(await readAllText(await streams.get("wrun_a", "out", -5))).toEqual(
        ["c0", "c1", "c2", "c3", "c4"],
      );
      // Clamped to 0 when it reaches back past the start.
      expect(
        await readAllText(await streams.get("wrun_a", "out", -100)),
      ).toEqual(["c0", "c1", "c2", "c3", "c4"]);
    });

    test("a startIndex at or past the data count still closes the stream", async () => {
      const { streams } = newStreamer();
      await streams.write("wrun_a", "out", "c0");
      await streams.write("wrun_a", "out", "c1");
      await streams.close("wrun_a", "out");

      expect(await readAllText(await streams.get("wrun_a", "out", 2))).toEqual(
        [],
      );
      expect(await readAllText(await streams.get("wrun_a", "out", 50))).toEqual(
        [],
      );
    });

    test("a negative startIndex on an open stream resumes with live chunks", async () => {
      const { streams } = newStreamer();
      for (const c of ["c0", "c1", "c2"])
        await streams.write("wrun_a", "out", c);

      const reading = readAllText(await streams.get("wrun_a", "out", -2));
      await sleep(50);
      await streams.write("wrun_a", "out", "c3");
      await streams.close("wrun_a", "out");

      expect(await reading).toEqual(["c1", "c2", "c3"]);
    });

    test("a stream closed before the reader attaches replays and ends", async () => {
      const { streams } = newStreamer();
      await streams.write("wrun_a", "out", "one");
      await streams.write("wrun_a", "out", "two");
      await streams.close("wrun_a", "out");

      expect(await readAllText(await streams.get("wrun_a", "out"))).toEqual([
        "one",
        "two",
      ]);
    });

    test("a stream closed without any data ends empty", async () => {
      const { streams } = newStreamer();
      await streams.close("wrun_a", "empty");

      expect(await readAllText(await streams.get("wrun_a", "empty"))).toEqual(
        [],
      );
      expect(await streams.list("wrun_a")).toEqual(["empty"]);
    });

    test("a reader attached before any write receives live chunks", async () => {
      const { streams } = newStreamer();

      const reading = readAllText(await streams.get("wrun_a", "out"));
      // Let the reader finish its (empty) history read and go live.
      await sleep(50);
      await streams.write("wrun_a", "out", "live-0");
      await streams.write("wrun_a", "out", "live-1");
      await streams.writeMulti("wrun_a", "out", ["live-2", "live-3"]);
      await streams.close("wrun_a", "out");

      expect(await reading).toEqual(["live-0", "live-1", "live-2", "live-3"]);
    });

    test("a reader mid-stream gets history first, then live chunks, without duplicates", async () => {
      const { streams } = newStreamer();
      await streams.write("wrun_a", "out", "past-0");
      await streams.write("wrun_a", "out", "past-1");

      const reading = readAllText(await streams.get("wrun_a", "out"));
      await sleep(50);
      await streams.write("wrun_a", "out", "live-0");
      await streams.close("wrun_a", "out");

      expect(await reading).toEqual(["past-0", "past-1", "live-0"]);
    });

    test("startIndex applies to live chunks too", async () => {
      const { streams } = newStreamer();

      const reading = readAllText(await streams.get("wrun_a", "out", 2));
      await sleep(50);
      for (const c of ["c0", "c1", "c2", "c3"])
        await streams.write("wrun_a", "out", c);
      await streams.close("wrun_a", "out");

      expect(await reading).toEqual(["c2", "c3"]);
    });

    test("an entry skipped by the offset is not counted again when it also arrives live", async () => {
      const { streams } = newStreamer();
      await streams.write("wrun_a", "out", "c0");

      // Hold the reader's history read until c1 has been written and published,
      // so c1 is in the history snapshot AND in the live buffer.
      const original = redis.xrange.bind(redis) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      const spy = vi.spyOn(redis, "xrange").mockImplementationOnce(((
        ...args: unknown[]
      ) =>
        (async () => {
          await streams.write("wrun_a", "out", "c1");
          await sleep(50);
          return original(...args);
        })()) as never);

      try {
        const reading = readAllText(await streams.get("wrun_a", "out", 2));
        await sleep(150);
        await streams.write("wrun_a", "out", "c2");
        await streams.close("wrun_a", "out");

        expect(await reading).toEqual(["c2"]);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });

    test("cancelling a reader detaches it without disturbing later writes", async () => {
      const { streams } = newStreamer();
      await streams.write("wrun_a", "out", "c0");

      const stream = await streams.get("wrun_a", "out");
      const reader = stream.getReader();
      expect(decoder.decode((await reader.read()).value)).toBe("c0");
      await reader.cancel();

      await streams.write("wrun_a", "out", "c1");
      await streams.close("wrun_a", "out");
      expect(await readAllText(await streams.get("wrun_a", "out"))).toEqual([
        "c0",
        "c1",
      ]);
    });

    test("writes after close are dropped and do not disturb the stream", async () => {
      const { streams } = newStreamer();
      await streams.write("wrun_a", "out", "c0");
      await streams.close("wrun_a", "out");
      // A producer retrying after a lost ACK.
      await streams.close("wrun_a", "out");
      await streams.write("wrun_a", "out", "late");

      expect(await readAllText(await streams.get("wrun_a", "out"))).toEqual([
        "c0",
      ]);
      expect(await streams.getInfo("wrun_a", "out")).toEqual({
        tailIndex: 0,
        done: true,
      });
      const page = await streams.getChunks("wrun_a", "out");
      expect(page.data.map((c) => decoder.decode(c.data))).toEqual(["c0"]);
      expect(page.done).toBe(true);
    });

    test("accepts a promise for the run id and keeps call order", async () => {
      const { streams } = newStreamer();
      // The v5 type says `string`, but core may still hand the run id over as a
      // promise (the v4 contract); the writes await it and must stay in order.
      const runId = sleep(20).then(() => "wrun_a") as unknown as string;

      await Promise.all([
        streams.write(runId, "out", "c0"),
        streams.write(runId, "out", "c1"),
        streams.write(runId, "out", "c2"),
      ]);
      await streams.close(runId, "out");

      expect(await readAllText(await streams.get("wrun_a", "out"))).toEqual([
        "c0",
        "c1",
        "c2",
      ]);
    });
  });

  describe("run isolation", () => {
    test("two runs using the same stream name stay isolated", async () => {
      const { streams } = newStreamer();

      await streams.write("wrun_a", "shared", "a-0");
      await streams.write("wrun_b", "shared", "b-0");
      await streams.write("wrun_a", "shared", "a-1");
      await streams.close("wrun_a", "shared");

      // Run B is still open: A's eof must not leak into it.
      expect(await readAllText(await streams.get("wrun_a", "shared"))).toEqual([
        "a-0",
        "a-1",
      ]);
      expect(await streams.getInfo("wrun_a", "shared")).toEqual({
        tailIndex: 1,
        done: true,
      });
      expect(await streams.getInfo("wrun_b", "shared")).toEqual({
        tailIndex: 0,
        done: false,
      });

      const pageB = await streams.getChunks("wrun_b", "shared");
      expect(pageB.data.map((c) => decoder.decode(c.data))).toEqual(["b-0"]);
      expect(pageB.done).toBe(false);

      await streams.write("wrun_b", "shared", "b-1");
      await streams.close("wrun_b", "shared");
      expect(await readAllText(await streams.get("wrun_b", "shared"))).toEqual([
        "b-0",
        "b-1",
      ]);
    });

    test("live readers of the same name in different runs only see their own run", async () => {
      const { streams } = newStreamer();

      const readingA = readAllText(await streams.get("wrun_a", "shared"));
      const readingB = readAllText(await streams.get("wrun_b", "shared"));
      await sleep(50);

      await streams.write("wrun_a", "shared", "a-0");
      await streams.write("wrun_b", "shared", "b-0");
      await streams.write("wrun_b", "shared", "b-1");
      await streams.close("wrun_a", "shared");
      // B has not closed, so its reader must still be waiting.
      expect(await readingA).toEqual(["a-0"]);

      await streams.write("wrun_b", "shared", "b-2");
      await streams.close("wrun_b", "shared");
      expect(await readingB).toEqual(["b-0", "b-1", "b-2"]);
    });

    test("a stream name containing colons does not collide with another run", async () => {
      const { streams } = newStreamer();
      await streams.write("wrun_a", "x:wrun_b:y", "a");
      await streams.write("wrun_b", "y", "b");
      await streams.close("wrun_a", "x:wrun_b:y");
      await streams.close("wrun_b", "y");

      expect(
        await readAllText(await streams.get("wrun_a", "x:wrun_b:y")),
      ).toEqual(["a"]);
      expect(await readAllText(await streams.get("wrun_b", "y"))).toEqual([
        "b",
      ]);
    });

    test("streams of different key prefixes do not share state", async () => {
      const one = newStreamer();
      const two = newStreamer();
      await one.streams.write("wrun_a", "out", "one");
      await one.streams.close("wrun_a", "out");

      expect(await two.streams.getInfo("wrun_a", "out")).toEqual({
        tailIndex: -1,
        done: false,
      });
      expect(await two.streams.list("wrun_a")).toEqual([]);
    });
  });

  describe("list", () => {
    test("lists the streams of a run, and only that run", async () => {
      const { streams } = newStreamer();
      await streams.write("wrun_a", "stdout", "x");
      await streams.writeMulti("wrun_a", "stderr", ["y"]);
      await streams.close("wrun_a", "closed-only");
      await streams.write("wrun_a", "stdout", "again");
      await streams.write("wrun_b", "other", "z");

      expect((await streams.list("wrun_a")).sort()).toEqual([
        "closed-only",
        "stderr",
        "stdout",
      ]);
      expect(await streams.list("wrun_b")).toEqual(["other"]);
      expect(await streams.list("wrun_none")).toEqual([]);
    });
  });

  describe("getChunks", () => {
    test("paginates with a cursor and reports done only after close", async () => {
      const { streams } = newStreamer();
      for (let i = 0; i < 5; i++) await streams.write("wrun_a", "out", `c${i}`);

      const text = (page: Awaited<ReturnType<typeof streams.getChunks>>) =>
        page.data.map((c) => `${c.index}:${decoder.decode(c.data)}`);

      const page1 = await streams.getChunks("wrun_a", "out", { limit: 2 });
      expect(text(page1)).toEqual(["0:c0", "1:c1"]);
      expect(page1.hasMore).toBe(true);
      expect(page1.done).toBe(false);
      expect(page1.cursor).toEqual(expect.any(String));

      const page2 = await streams.getChunks("wrun_a", "out", {
        limit: 2,
        cursor: page1.cursor ?? undefined,
      });
      expect(text(page2)).toEqual(["2:c2", "3:c3"]);
      expect(page2.hasMore).toBe(true);
      expect(page2.done).toBe(false);

      // Last available chunk, stream still open: nothing more to page, not done.
      const page3 = await streams.getChunks("wrun_a", "out", {
        limit: 2,
        cursor: page2.cursor ?? undefined,
      });
      expect(text(page3)).toEqual(["4:c4"]);
      expect(page3.hasMore).toBe(false);
      expect(page3.cursor).toBeNull();
      expect(page3.done).toBe(false);

      await streams.close("wrun_a", "out");

      // Same walk after close: the final page reports done.
      const closed1 = await streams.getChunks("wrun_a", "out", { limit: 4 });
      expect(text(closed1)).toEqual(["0:c0", "1:c1", "2:c2", "3:c3"]);
      expect(closed1.hasMore).toBe(true);
      expect(closed1.done).toBe(false);
      const closed2 = await streams.getChunks("wrun_a", "out", {
        limit: 4,
        cursor: closed1.cursor ?? undefined,
      });
      expect(text(closed2)).toEqual(["4:c4"]);
      expect(closed2.hasMore).toBe(false);
      expect(closed2.cursor).toBeNull();
      expect(closed2.done).toBe(true);
    });

    test("a page that ends exactly at the eof marker is done, with no further page", async () => {
      const { streams } = newStreamer();
      for (let i = 0; i < 3; i++) await streams.write("wrun_a", "out", `c${i}`);
      await streams.close("wrun_a", "out");

      const page = await streams.getChunks("wrun_a", "out", { limit: 3 });
      expect(page.data).toHaveLength(3);
      expect(page.hasMore).toBe(false);
      expect(page.cursor).toBeNull();
      expect(page.done).toBe(true);
    });

    test("returns binary payloads intact, and an unknown stream as empty", async () => {
      const { streams } = newStreamer();
      const binary = new Uint8Array([9, 0, 255, 128]);
      await streams.write("wrun_a", "out", binary);

      const page = await streams.getChunks("wrun_a", "out");
      expect(page.data).toHaveLength(1);
      expect(page.data[0].data).toBeInstanceOf(Uint8Array);
      expect(Array.from(page.data[0].data)).toEqual(Array.from(binary));

      expect(await streams.getChunks("wrun_a", "missing")).toEqual({
        data: [],
        cursor: null,
        hasMore: false,
        done: false,
      });
    });

    test("restarts from the beginning on a malformed cursor", async () => {
      const { streams } = newStreamer();
      await streams.write("wrun_a", "out", "c0");

      const page = await streams.getChunks("wrun_a", "out", {
        cursor: "%%%not-a-cursor",
      });
      expect(page.data.map((c) => c.index)).toEqual([0]);
    });
  });

  describe("getInfo", () => {
    test("reports the tail index and completion", async () => {
      const { streams } = newStreamer();

      expect(await streams.getInfo("wrun_a", "out")).toEqual({
        tailIndex: -1,
        done: false,
      });

      await streams.write("wrun_a", "out", "c0");
      expect(await streams.getInfo("wrun_a", "out")).toEqual({
        tailIndex: 0,
        done: false,
      });

      await streams.writeMulti("wrun_a", "out", ["c1", "c2"]);
      expect(await streams.getInfo("wrun_a", "out")).toEqual({
        tailIndex: 2,
        done: false,
      });

      await streams.close("wrun_a", "out");
      // The eof marker is not a data chunk.
      expect(await streams.getInfo("wrun_a", "out")).toEqual({
        tailIndex: 2,
        done: true,
      });
    });

    test("a stream closed without data has tailIndex -1 and is done", async () => {
      const { streams } = newStreamer();
      await streams.close("wrun_a", "empty");
      expect(await streams.getInfo("wrun_a", "empty")).toEqual({
        tailIndex: -1,
        done: true,
      });
    });

    test("tailIndex resolves a negative startIndex the same way get does", async () => {
      const { streams } = newStreamer();
      for (let i = 0; i < 6; i++) await streams.write("wrun_a", "out", `c${i}`);
      await streams.close("wrun_a", "out");

      const { tailIndex } = await streams.getInfo("wrun_a", "out");
      const absolute = tailIndex + 1 - 3;
      expect(
        await readAllText(await streams.get("wrun_a", "out", absolute)),
      ).toEqual(await readAllText(await streams.get("wrun_a", "out", -3)));
    });
  });

  describe("writeMulti", () => {
    test("keeps chunks in array order and in order with single writes", async () => {
      const { streams } = newStreamer();

      await streams.write("wrun_a", "out", "w0");
      await streams.writeMulti("wrun_a", "out", [
        "m0",
        encoder.encode("m1"),
        "m2",
      ]);
      await streams.write("wrun_a", "out", "w1");
      await streams.writeMulti("wrun_a", "out", ["m3", "m4"]);
      await streams.close("wrun_a", "out");

      expect(await readAllText(await streams.get("wrun_a", "out"))).toEqual([
        "w0",
        "m0",
        "m1",
        "m2",
        "w1",
        "m3",
        "m4",
      ]);
      const page = await streams.getChunks("wrun_a", "out");
      expect(page.data.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    });

    test("an empty batch writes nothing and does not index the stream", async () => {
      const { streams } = newStreamer();
      await streams.writeMulti("wrun_a", "out", []);
      expect(await streams.list("wrun_a")).toEqual([]);
      expect(await streams.getInfo("wrun_a", "out")).toEqual({
        tailIndex: -1,
        done: false,
      });
    });

    test("a large batch stays ordered across entry-id sequence digit boundaries", async () => {
      const { streams } = newStreamer();
      const chunks = Array.from({ length: 250 }, (_, i) => `chunk-${i}`);

      // The reader is live while the batch lands, so the entries arrive as
      // pub/sub messages whose ids share a millisecond (`<ms>-9`, `<ms>-10`, ...).
      const reading = readAllText(await streams.get("wrun_a", "out"));
      await sleep(50);
      await streams.writeMulti("wrun_a", "out", chunks);
      await streams.close("wrun_a", "out");

      expect(await reading).toEqual(chunks);
      expect(await readAllText(await streams.get("wrun_a", "out"))).toEqual(
        chunks,
      );
    });
  });
});
